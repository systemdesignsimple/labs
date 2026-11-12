// sd-16 lab: Which server gets your request?
// Round robin vs least connections vs hash(user ID) across 4 simulated servers.
// Node.js 22 ESM, standard library only. Deterministic: fixed seed, simulated clock.
//
// This is a discrete-event simulation. No real sockets, no real sleeping.
// Time is a number in milliseconds that jumps from event to event, so 20,000
// requests (about a minute of simulated traffic) finish in well under a second.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CONFIG = {
  seed: 16,
  servers: 4,
  slotsPerServer: 8,          // each server works on at most 8 requests at once
  requests: 20000,
  fastMs: 20,
  slowMs: 400,
  slowFraction: 0.10,         // probability a request is slow in the mixed run (a target, not a count)
  users: 2000,
  zipfS: 1.0,                 // user traffic skew: a few heavy users, a long tail
  targetUtilization: 0.65,    // target average load of the 32 slots in the MIXED run; it sets the arrival rate
};
// The control run reuses the mixed run's arrival rate and exact arrival times.
// Only the service times change (every request takes fastMs), so the control
// is far less loaded. The realized load of each run is measured and reported.

// ---------- seeded random numbers (mulberry32) ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- FNV-1a 32-bit hash for user IDs ----------
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ---------- one shared request stream ----------
// Each request has: a unit-mean exponential gap (Poisson arrivals at a fixed
// average rate once scaled), a user picked from a Zipf distribution, and a
// slow/fast flag. Every balancer and both runs see this exact same stream.
function makeStream() {
  const rand = mulberry32(CONFIG.seed);
  const cdf = new Float64Array(CONFIG.users);
  let total = 0;
  for (let k = 1; k <= CONFIG.users; k++) {
    total += 1 / Math.pow(k, CONFIG.zipfS);
    cdf[k - 1] = total;
  }
  const stream = new Array(CONFIG.requests);
  for (let i = 0; i < CONFIG.requests; i++) {
    const gap = -Math.log(1 - rand());
    const x = rand() * total;
    let lo = 0, hi = CONFIG.users - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < x) lo = mid + 1; else hi = mid;
    }
    const slow = rand() < CONFIG.slowFraction;
    stream[i] = { gap, user: lo + 1, slow };
  }
  // user traffic share of the heaviest users, for the README / video
  const counts = new Map();
  for (const r of stream) counts.set(r.user, (counts.get(r.user) || 0) + 1);
  const top = [...counts.values()].sort((a, b) => b - a);
  const top10Share = top.slice(0, 10).reduce((a, b) => a + b, 0) / CONFIG.requests;
  return { stream, topUserShare: top[0] / CONFIG.requests, top10Share };
}

// ---------- tiny binary min-heap of completion events ----------
class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  peek() { return this.a[0]; }
  push(x) {
    const a = this.a; a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].t <= a[i].t) break;
      [a[p], a[i]] = [a[i], a[p]]; i = p;
    }
  }
  pop() {
    const a = this.a; const top = a[0]; const last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l].t < a[m].t) m = l;
        if (r < a.length && a[r].t < a[m].t) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

// ---------- balancers ----------
const BALANCERS = {
  'round-robin': () => {
    let next = 0;
    return () => { const s = next; next = (next + 1) % CONFIG.servers; return s; };
  },
  'least-connections': () => {
    // "connections" = requests in flight + waiting on that server.
    // Ties are broken by a rotating start so no server is favoured.
    let start = 0;
    return (req, servers) => {
      let best = -1, bestLoad = Infinity;
      for (let k = 0; k < servers.length; k++) {
        const i = (start + k) % servers.length;
        const load = servers[i].active + (servers[i].queue.length - servers[i].qHead);
        if (load < bestLoad) { bestLoad = load; best = i; }
      }
      start = (start + 1) % servers.length;
      return best;
    };
  },
  'hash-user-id': () => (req) => fnv1a('user-' + req.user) % CONFIG.servers,
};

// ---------- simulation ----------
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

function simulate(stream, scenario, balancerName) {
  const S = CONFIG.servers;
  const servers = Array.from({ length: S }, () => ({
    active: 0, queue: [], qHead: 0, sent: 0, peakQueue: 0, workMs: 0,
  }));
  const pick = BALANCERS[balancerName]();
  const heap = new MinHeap();
  const reqs = new Array(stream.length);

  const start = (srvIdx, req, now) => {
    servers[srvIdx].active++;
    heap.push({ t: now + req.service, srvIdx, req });
  };
  const complete = (ev) => {
    ev.req.finish = ev.t;
    const srv = servers[ev.srvIdx];
    srv.active--;
    if (srv.queue.length - srv.qHead > 0) {
      const next = srv.queue[srv.qHead++];
      start(ev.srvIdx, next, ev.t);
    }
  };

  let now = 0;
  for (let i = 0; i < stream.length; i++) {
    const base = stream[i];
    now += base.gap / scenario.ratePerMs;
    const slow = scenario.mixed && base.slow;
    const req = { arrive: now, service: slow ? CONFIG.slowMs : CONFIG.fastMs, slow, user: base.user, finish: 0 };
    reqs[i] = req;

    // finish everything that completes before (or exactly at) this arrival
    while (heap.size > 0 && heap.peek().t <= now) complete(heap.pop());

    const s = pick(req, servers);
    const srv = servers[s];
    srv.sent++;
    srv.workMs += req.service;
    if (srv.active < CONFIG.slotsPerServer) {
      start(s, req, now);
    } else {
      srv.queue.push(req);
      const depth = srv.queue.length - srv.qHead;
      if (depth > srv.peakQueue) srv.peakQueue = depth;
    }
  }
  const lastArrival = now;
  while (heap.size > 0) complete(heap.pop());

  const all = new Float64Array(reqs.length);
  const fast = [];
  for (let i = 0; i < reqs.length; i++) {
    const lat = reqs[i].finish - reqs[i].arrive;
    all[i] = lat;
    if (!reqs[i].slow) fast.push(lat);
  }
  all.sort();
  const fastSorted = Float64Array.from(fast).sort();

  const totalWork = servers.reduce((a, s) => a + s.workMs, 0);
  const slowCount = reqs.reduce((a, r) => a + (r.slow ? 1 : 0), 0);

  const perServer = servers.map((s, i) => ({
    server: i + 1,
    sharePct: round(100 * s.sent / reqs.length, 1),
    // offered load: work sent to this server / (its slots * traffic duration)
    offeredLoadPct: round(100 * s.workMs / (CONFIG.slotsPerServer * lastArrival), 1),
    peakQueue: s.peakQueue,
  }));

  return {
    scenario: scenario.name,
    balancer: balancerName,
    // realized, from the sampled stream: offered work / (all slots * traffic duration)
    realizedUtilizationPct: round(100 * totalWork / (S * CONFIG.slotsPerServer * lastArrival), 1),
    realizedSlowPct: round(100 * slowCount / reqs.length, 2),
    arrivalRatePerSec: round(1000 * reqs.length / lastArrival, 1),
    p50Ms: round(percentile(all, 0.50), 1),
    p99Ms: round(percentile(all, 0.99), 1),
    p99FastOnlyMs: round(percentile(fastSorted, 0.99), 1),
    maxMs: round(all[all.length - 1], 1),
    maxSharePct: Math.max(...perServer.map((p) => p.sharePct)),
    maxOfferedLoadPct: Math.max(...perServer.map((p) => p.offeredLoadPct)),
    peakQueueMax: Math.max(...perServer.map((p) => p.peakQueue)),
    perServer,
  };
}

function round(x, d) { const f = 10 ** d; return Math.round(x * f) / f; }

// ---------- run everything ----------
const t0 = Date.now();
const { stream, topUserShare, top10Share } = makeStream();

const capacity = (meanServiceMs) => (CONFIG.servers * CONFIG.slotsPerServer) / meanServiceMs; // req per ms
const mixedMean = CONFIG.fastMs * (1 - CONFIG.slowFraction) + CONFIG.slowMs * CONFIG.slowFraction;
const ratePerMs = CONFIG.targetUtilization * capacity(mixedMean);
// Same arrival rate (and so identical arrival times) in both runs; only service times differ.
const SCENARIOS = [
  { name: 'mixed', mixed: true, ratePerMs },
  { name: 'control', mixed: false, ratePerMs },
];

const runs = [];
for (const sc of SCENARIOS) {
  for (const b of Object.keys(BALANCERS)) runs.push(simulate(stream, sc, b));
}
const get = (sc, b) => runs.find((r) => r.scenario === sc && r.balancer === b);

const LABEL = { 'round-robin': 'round robin', 'least-connections': 'least connections', 'hash-user-id': 'user-ID hashing' };

// human-readable table (the RESULT line below is the machine-readable one)
for (const r of runs) {
  console.log(
    `${r.scenario.padEnd(8)} ${r.balancer.padEnd(18)} p50 ${String(r.p50Ms).padStart(7)} ms  ` +
    `p99 ${String(r.p99Ms).padStart(7)} ms  p99(fast) ${String(r.p99FastOnlyMs).padStart(7)} ms  ` +
    `max share ${r.maxSharePct}%  busiest load ${r.maxOfferedLoadPct}%  peak queue ${r.peakQueueMax}  ` +
    `(realized load ${r.realizedUtilizationPct}%, slow ${r.realizedSlowPct}%)`
  );
}

const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(here, 'results.json'), JSON.stringify({
  lab: 'sd-16',
  kind: 'simulation',
  config: CONFIG,
  targetArrivalRatePerSec: round(ratePerMs * 1000, 1),
  realized: Object.fromEntries(SCENARIOS.map((s) => {
    const r = runs.find((x) => x.scenario === s.name);
    return [s.name, { arrivalRatePerSec: r.arrivalRatePerSec, utilizationPct: r.realizedUtilizationPct, slowPct: r.realizedSlowPct }];
  })),
  traffic: { topUserSharePct: round(100 * topUserShare, 1), top10UsersSharePct: round(100 * top10Share, 1) },
  runs,
}, null, 2) + '\n');

// ---------- RESULT line ----------
const mRR = get('mixed', 'round-robin'), mLC = get('mixed', 'least-connections'), mH = get('mixed', 'hash-user-id');
const cRR = get('control', 'round-robin'), cLC = get('control', 'least-connections'), cH = get('control', 'hash-user-id');

const metrics = [
  { name: 'mixed p99 round robin', value: mRR.p99Ms, unit: 'ms' },
  { name: 'mixed p99 least connections', value: mLC.p99Ms, unit: 'ms' },
  { name: 'mixed p99 user-ID hash', value: mH.p99Ms, unit: 'ms' },
  { name: 'mixed p50 round robin', value: mRR.p50Ms, unit: 'ms' },
  { name: 'mixed p50 least connections', value: mLC.p50Ms, unit: 'ms' },
  { name: 'mixed p50 user-ID hash', value: mH.p50Ms, unit: 'ms' },
  { name: 'mixed p99 of fast (20 ms) requests, round robin', value: mRR.p99FastOnlyMs, unit: 'ms' },
  { name: 'mixed p99 of fast (20 ms) requests, least connections', value: mLC.p99FastOnlyMs, unit: 'ms' },
  { name: 'mixed p99 of fast (20 ms) requests, user-ID hash', value: mH.p99FastOnlyMs, unit: 'ms' },
  { name: 'mixed peak queue round robin', value: mRR.peakQueueMax, unit: 'requests' },
  { name: 'mixed peak queue least connections', value: mLC.peakQueueMax, unit: 'requests' },
  { name: 'mixed peak queue user-ID hash', value: mH.peakQueueMax, unit: 'requests' },
  { name: 'user-ID hash busiest server share', value: mH.maxSharePct, unit: '%' },
  { name: 'user-ID hash busiest server load', value: mH.maxOfferedLoadPct, unit: '%' },
  { name: 'control p99 round robin', value: cRR.p99Ms, unit: 'ms' },
  { name: 'control p99 least connections', value: cLC.p99Ms, unit: 'ms' },
  { name: 'control p99 user-ID hash', value: cH.p99Ms, unit: 'ms' },
  { name: 'mixed realized slot load', value: mRR.realizedUtilizationPct, unit: '%' },
  { name: 'mixed realized slow-request share', value: mRR.realizedSlowPct, unit: '%' },
  { name: 'control realized slot load', value: cRR.realizedUtilizationPct, unit: '%' },
  { name: 'realized arrival rate (both runs)', value: mRR.arrivalRatePerSec, unit: 'req/s' },
];

// Rank by the reported (rounded) p99 and group exact ties, so the sentence never
// implies an order the printed numbers do not show.
function rankWithTies(list) {
  const groups = [];
  for (const r of [...list].sort((a, b) => a.p99Ms - b.p99Ms)) {
    const g = groups[groups.length - 1];
    if (g && g.p99Ms === r.p99Ms) g.names.push(LABEL[r.balancer]);
    else groups.push({ p99Ms: r.p99Ms, names: [LABEL[r.balancer]] });
  }
  const joinNames = (n) => (n.length === 1 ? n[0] : n.slice(0, -1).join(', ') + ' and ' + n[n.length - 1]);
  if (groups.length === 1) return `all three had the same p99 (${groups[0].p99Ms} ms)`;
  return groups.map((g, i) => {
    const who = joinNames(g.names);
    const tied = g.names.length > 1 ? ' (tied)' : '';
    if (i === 0) return `${who} had the lowest p99${tied} (${g.p99Ms} ms)`;
    return `${who}${tied} (${g.p99Ms} ms)`;
  }).join(', then ');
}

const mixedSlowPct = mRR.realizedSlowPct;
let controlCompare;
if (cRR.p99Ms === cLC.p99Ms) {
  controlCompare = `round robin and least connections had equal p99 (${cRR.p99Ms} ms)`;
} else {
  const close = Math.abs(cRR.p99Ms - cLC.p99Ms) <= Math.max(2, 0.1 * Math.min(cRR.p99Ms, cLC.p99Ms));
  controlCompare = `round robin and least connections were ${close ? 'within a few ms' : 'clearly different'} ` +
    `(${cRR.p99Ms} vs ${cLC.p99Ms} ms p99)`;
}
const conclusion =
  `With ${mixedSlowPct}% of requests slow, ${rankWithTies([mRR, mLC, mH])}; ` +
  `on the same arrivals with every request at ${CONFIG.fastMs} ms (${cRR.realizedUtilizationPct}% load instead of ${mRR.realizedUtilizationPct}%), ` +
  `${controlCompare}, and hashing sent ${mH.maxSharePct}% of requests to its busiest server.`;

const setup =
  `simulation, seed ${CONFIG.seed}; ${CONFIG.servers} servers x ${CONFIG.slotsPerServer} slots, FIFO queue per server; ` +
  `${CONFIG.requests} Poisson arrivals, same arrival times in both runs (target ${round(ratePerMs * 1000, 0)}/s, realized ${round(mRR.arrivalRatePerSec, 0)}/s); ` +
  `mixed: each request slow with probability ${CONFIG.slowFraction} (${CONFIG.slowMs} ms, else ${CONFIG.fastMs} ms), realized ${mixedSlowPct}% slow, ` +
  `target ${Math.round(CONFIG.targetUtilization * 100)}% slot load, realized ${mRR.realizedUtilizationPct}%; ` +
  `control: same arrivals, all ${CONFIG.fastMs} ms, realized ${cRR.realizedUtilizationPct}% slot load; ` +
  `${CONFIG.users} users, Zipf s=${CONFIG.zipfS} (top user ${round(100 * topUserShare, 1)}%, top 10 ${round(100 * top10Share, 1)}%); ` +
  `hash = FNV-1a(user id) mod ${CONFIG.servers}; least connections = fewest in-flight + queued; wall time ${Date.now() - t0} ms`;

console.log('RESULT ' + JSON.stringify({ metrics, conclusion, setup }));
