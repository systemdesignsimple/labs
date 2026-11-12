// sd-15 lab: load balancer vs reverse proxy, simulated in-process.
// Node.js 22 ESM, standard library only. No network, no child processes.
// Everything runs on a virtual clock (discrete event simulation) with a fixed
// seed, so the numbers are identical on every run and every machine.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------- parameters
const P = {
  seed: 15,
  requests: 2000,
  concurrency: 30,          // clients in flight at once (closed loop)
  serviceMs: 20,            // fixed simulated work per request on a backend
  backendCapacity: 4,       // requests a backend works on at the same time
  backends: 3,              // used by setup B
  hopMs: 0.2,               // extra hop through the load balancer or proxy
  cacheTtlMs: 5000,         // reverse proxy cache lifetime
  hotShare: 0.8,            // share of requests asking for the same page
  hotPath: '/home',
};

// ---------------------------------------------------------- seeded random
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The same 2,000 requests are replayed in every setup.
const rng = mulberry32(P.seed);
const WORKLOAD = Array.from({ length: P.requests }, (_, i) =>
  rng() < P.hotShare ? P.hotPath : `/article/${i}`);

// ------------------------------------------------------- virtual event loop
class Sim {
  constructor() { this.now = 0; this.heap = []; this.seq = 0; }
  after(delay, fn) { this.#push({ t: this.now + delay, s: this.seq++, fn }); }
  run() {
    while (this.heap.length) {
      const e = this.#pop();
      this.now = e.t;
      e.fn();
    }
  }
  #less(a, b) { return a.t < b.t || (a.t === b.t && a.s < b.s); }
  #push(e) {
    const h = this.heap; h.push(e);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.#less(h[i], h[p])) break;
      [h[i], h[p]] = [h[p], h[i]]; i = p;
    }
  }
  #pop() {
    const h = this.heap; const top = h[0]; const last = h.pop();
    if (h.length) {
      h[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < h.length && this.#less(h[l], h[m])) m = l;
        if (r < h.length && this.#less(h[r], h[m])) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m], h[i]]; i = m;
      }
    }
    return top;
  }
}

// ------------------------------------------------------------------ backend
// A server that works on at most `capacity` requests at once; the rest wait
// in a FIFO queue. Each request costs a fixed `serviceMs`.
class Backend {
  constructor(sim, name) {
    this.sim = sim; this.name = name;
    this.active = 0; this.queue = []; this.received = 0; this.maxQueue = 0;
  }
  handle(path, done) {
    this.received++;
    if (this.active < P.backendCapacity) this.#start(done);
    else {
      this.queue.push(done);
      this.maxQueue = Math.max(this.maxQueue, this.queue.length);
    }
  }
  #start(done) {
    this.active++;
    this.sim.after(P.serviceMs, () => {
      this.active--;
      if (this.queue.length) this.#start(this.queue.shift());
      done();
    });
  }
}

// ---------------------------------------------------------------- front doors
// Setup A: clients talk to one server directly.
function direct(backend) {
  return (path, done) => backend.handle(path, done);
}

// Setup B: round-robin load balancer. It only picks a server; it does no
// work for the request and makes nothing faster by itself.
function roundRobin(sim, backends) {
  let next = 0;
  return (path, done) => {
    const b = backends[next]; next = (next + 1) % backends.length;
    sim.after(P.hopMs, () => b.handle(path, () => sim.after(P.hopMs, done)));
  };
}

// Setup C: reverse proxy with a response cache in front of one server.
// Fresh cached answers are returned by the proxy without touching the server.
// No request coalescing, so concurrent misses for the same page all go through.
function cachingProxy(sim, backend, stats) {
  const cache = new Map(); // path -> expiresAt
  return (path, done) => {
    sim.after(P.hopMs, () => {
      const exp = cache.get(path);
      if (exp !== undefined && exp > sim.now) {
        stats.hits++;
        sim.after(P.hopMs, done);
        return;
      }
      stats.misses++;
      if (path === P.hotPath) stats.hotMisses++;
      backend.handle(path, () => {
        cache.set(path, sim.now + P.cacheTtlMs);
        sim.after(P.hopMs, done);
      });
    });
  };
}

// ------------------------------------------------------------ load generator
// `concurrency` clients each send a request, wait for the answer, then send
// the next one, until all 2,000 requests from the shared workload are done.
function loadTest(sim, send) {
  const latencies = [];
  let nextIndex = 0;
  let finishedAt = 0;
  const client = () => {
    if (nextIndex >= WORKLOAD.length) return;
    const path = WORKLOAD[nextIndex++];
    const sentAt = sim.now;
    send(path, () => {
      latencies.push(sim.now - sentAt);
      finishedAt = sim.now;
      client();
    });
  };
  for (let c = 0; c < P.concurrency; c++) client();
  sim.run();
  return { latencies, totalMs: finishedAt };
}

function pct(sorted, p) {
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)];
}
const r1 = (x) => Math.round(x * 10) / 10;

function summarize(name, { latencies, totalMs }, backends, extra = {}) {
  const s = [...latencies].sort((a, b) => a - b);
  return {
    setup: name,
    requests: s.length,
    totalMs: r1(totalMs),
    p50Ms: r1(pct(s, 50)),
    p95Ms: r1(pct(s, 95)),
    perBackend: Object.fromEntries(backends.map((b) => [b.name, b.received])),
    maxQueue: Object.fromEntries(backends.map((b) => [b.name, b.maxQueue])),
    ...extra,
  };
}

// --------------------------------------------------------------------- runs
function runA() {
  const sim = new Sim();
  const s1 = new Backend(sim, 'server-1');
  return summarize('A direct, 1 server', loadTest(sim, direct(s1)), [s1]);
}

function runB() {
  const sim = new Sim();
  const bs = Array.from({ length: P.backends }, (_, i) => new Backend(sim, `server-${i + 1}`));
  return summarize('B load balancer, 3 servers', loadTest(sim, roundRobin(sim, bs)), bs);
}

function runC() {
  const sim = new Sim();
  const s1 = new Backend(sim, 'server-1');
  const stats = { hits: 0, misses: 0, hotMisses: 0 };
  const res = loadTest(sim, cachingProxy(sim, s1, stats));
  return summarize('C reverse proxy + cache, 1 server', res, [s1], {
    cacheHits: stats.hits,
    cacheMisses: stats.misses,
    hotPageMisses: stats.hotMisses,
    cacheHitRate: r1((stats.hits / P.requests) * 100),
  });
}

const A = runA();
const B = runB();
const C = runC();

// --------------------------------------------------------------- reporting
const hotCount = WORKLOAD.filter((p) => p === P.hotPath).length;
const results = {
  lab: 'sd-15 load balancer vs reverse proxy',
  note: 'Discrete event simulation on a virtual clock. Shows the shape of the effect, not production numbers.',
  params: { ...P, hotRequestsInWorkload: hotCount },
  setups: { A, B, C },
};
const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(here, 'results.json'), JSON.stringify(results, null, 2) + '\n');

for (const r of [A, B, C]) {
  console.log(`${r.setup}`);
  console.log(`  total ${r.totalMs} ms · p50 ${r.p50Ms} ms · p95 ${r.p95Ms} ms`);
  console.log(`  requests per backend: ${JSON.stringify(r.perBackend)}`);
  if (r.cacheHits !== undefined) {
    console.log(`  cache hits ${r.cacheHits} · misses ${r.cacheMisses} (hot page misses ${r.hotPageMisses}) · hit rate ${r.cacheHitRate}%`);
  }
}

const bCounts = Object.values(B.perBackend);
const cBackend = C.perBackend['server-1'];
const metrics = [
  { name: 'A_total_time', value: A.totalMs, unit: 'ms' },
  { name: 'A_p50_latency', value: A.p50Ms, unit: 'ms' },
  { name: 'A_p95_latency', value: A.p95Ms, unit: 'ms' },
  { name: 'B_total_time', value: B.totalMs, unit: 'ms' },
  { name: 'B_p50_latency', value: B.p50Ms, unit: 'ms' },
  { name: 'B_p95_latency', value: B.p95Ms, unit: 'ms' },
  ...bCounts.map((v, i) => ({ name: `B_server_${i + 1}_requests`, value: v, unit: 'requests' })),
  { name: 'C_total_time', value: C.totalMs, unit: 'ms' },
  { name: 'C_p50_latency', value: C.p50Ms, unit: 'ms' },
  { name: 'C_p95_latency', value: C.p95Ms, unit: 'ms' },
  { name: 'C_backend_requests', value: cBackend, unit: 'requests' },
  { name: 'C_cache_hit_rate', value: C.cacheHitRate, unit: '%' },
  { name: 'C_hot_page_backend_fetches', value: C.hotPageMisses, unit: 'requests' },
];

const speedupB = r1(A.totalMs / B.totalMs);
const conclusion =
  `Spreading the same ${P.requests} requests over ${P.backends} servers cut total time from ${A.totalMs} ms to ${B.totalMs} ms ` +
  `(${speedupB}x) while each request still took the same ${P.serviceMs} ms of work, and the caching reverse proxy let one server ` +
  `receive only ${cBackend} of ${P.requests} requests (p50 ${C.p50Ms} ms vs ${A.p50Ms} ms direct) by answering the repeated page itself.`;

const setup =
  `simulated in-process, virtual clock, seed ${P.seed}; ${P.requests} requests, ${P.concurrency} concurrent clients; ` +
  `backend ${P.serviceMs} ms per request, ${P.backendCapacity} at a time; LB round-robin over ${P.backends}; ` +
  `proxy cache TTL ${P.cacheTtlMs} ms, ${P.hotShare * 100}% of requests for ${P.hotPath}; ${P.hopMs} ms per extra hop`;

console.log('RESULT ' + JSON.stringify({ metrics, conclusion, setup }));
