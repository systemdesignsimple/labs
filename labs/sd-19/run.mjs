// sd-19 lab: monolith vs split services, simulated in-process.
// Node.js 22 ESM, standard library only. Virtual clock, fixed seeds, repeatable.
// Usage: node run.mjs

const CONFIG = {
  seed: 19,
  rps: 200, // mixed requests per second hitting the shop
  mix: { checkout: 0.2, search: 0.4, recs: 0.4 },
  baseMs: { checkout: 20, search: 10, recs: 15 }, // base service time per call (drawn uniform 0.5x to 1.5x of this)
  tailChance: 0.03, // chance a call takes tailFactor times its drawn time (natural tail)
  tailFactor: 3,
  slowRecsMs: 2000, // recommendations goes slow: 2 s per call
  crashAfterMs: 50, // crash-loop: a recs call kills its process after 50 ms
  crashRestartMs: 2000, // time for a crashed process to come back
  timeoutMs: 1000, // client gives up after 1 s
  workersMonolith: 16, // one shared pool
  workersSplit: { checkout: 4, search: 6, recs: 6 }, // same 16 workers, split three ways
  hopOneWayMs: [0.8, 1.6], // simulated gateway to service hop, each direction (min, max)
  gatewayMs: 0.2, // gateway routing work per request
  durationMs: 20000, // traffic window per scenario (virtual time)
  warmupMs: 2000, // checkouts before this are not counted
  incidentAtMs: 2000, // when recommendations goes bad
  redeployAtMs: 8000, // when the recommendations feature is redeployed
  monolithRestartMs: 4000, // stop + boot + warm the whole app
  serviceRestartMs: 1500, // stop + boot + warm one small service
};

const SCENARIOS = ['baseline', 'slow', 'crash', 'redeploy'];
const ARCHS = ['monolith', 'split'];

// ---------- seeded RNG ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- min-heap of timed events ----------
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  less(i, j) {
    const x = this.a[i], y = this.a[j];
    return x.t < y.t || (x.t === y.t && x.seq < y.seq);
  }
  push(e) {
    const a = this.a; a.push(e);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      [a[i], a[p]] = [a[p], a[i]]; i = p;
    }
  }
  pop() {
    const a = this.a; const top = a[0]; const last = a.pop();
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && this.less(l, m)) m = l;
        if (r < a.length && this.less(r, m)) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]]; i = m;
      }
    }
    return top;
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

// ---------- one simulated run ----------
function simulate(arch, scenario) {
  const C = CONFIG;
  // Separate streams so both architectures see the exact same traffic.
  const trafficRng = mulberry32(C.seed);
  const hopRng = mulberry32(C.seed + 1000);
  const heap = new Heap();
  let seq = 0;
  let now = 0;
  const at = (t, fn) => heap.push({ t, seq: seq++, fn });

  const makePool = (name, workers) => ({ name, workers, busy: 0, queue: [], qHead: 0, down: false, gen: 0, inflight: new Set() });
  const pools = arch === 'monolith'
    ? { all: makePool('monolith', C.workersMonolith) }
    : {
        checkout: makePool('checkout', C.workersSplit.checkout),
        search: makePool('search', C.workersSplit.search),
        recs: makePool('recs', C.workersSplit.recs),
      };
  const poolFor = (type) => (arch === 'monolith' ? pools.all : pools[type]);

  const stats = {};
  for (const t of Object.keys(C.mix)) stats[t] = { ok: 0, fail: 0, lat: [] };

  const hop = () => C.hopOneWayMs[0] + hopRng() * (C.hopOneWayMs[1] - C.hopOneWayMs[0]);
  const record = (req, ok, latency) => {
    if (!req.measured || req.settled) return;
    req.settled = true;
    const s = stats[req.type];
    if (ok) { s.ok++; s.lat.push(latency); } else s.fail++;
  };
  const fail = (req) => record(req, false, now - req.arrival);

  const respond = (req) => {
    const back = arch === 'split' ? hop() : 0;
    const latency = now + back - req.arrival;
    record(req, latency <= C.timeoutMs, latency);
  };

  const takeDown = (pool, ms) => {
    pool.gen++;
    pool.down = true;
    for (const r of pool.inflight) fail(r);
    pool.inflight.clear();
    for (let i = pool.qHead; i < pool.queue.length; i++) fail(pool.queue[i]);
    pool.queue = []; pool.qHead = 0; pool.busy = 0;
    at(now + ms, () => { pool.down = false; tryStart(pool); });
  };

  const recsBroken = (t) => (scenario === 'slow' || scenario === 'crash') && t >= C.incidentAtMs;

  const start = (pool, req) => {
    pool.busy++;
    pool.inflight.add(req);
    const gen = pool.gen;
    if (scenario === 'crash' && req.type === 'recs' && recsBroken(now)) {
      at(now + C.crashAfterMs, () => { if (pool.gen === gen) takeDown(pool, C.crashRestartMs); });
      return;
    }
    at(now + req.svc, () => {
      if (pool.gen !== gen) return; // process died while this call was running
      pool.busy--;
      pool.inflight.delete(req);
      respond(req);
      tryStart(pool);
    });
  };

  const tryStart = (pool) => {
    while (!pool.down && pool.busy < pool.workers && pool.qHead < pool.queue.length) {
      const req = pool.queue[pool.qHead++];
      if (now - req.arrival > C.timeoutMs) { fail(req); continue; } // client already gave up
      start(pool, req);
    }
    if (pool.qHead > 1024 && pool.qHead * 2 > pool.queue.length) {
      pool.queue = pool.queue.slice(pool.qHead); pool.qHead = 0;
    }
  };

  const enqueue = (req) => {
    const pool = poolFor(req.type);
    if (pool.down) { fail(req); return; } // connection refused
    pool.queue.push(req);
    tryStart(pool);
  };

  const arrive = () => {
    const u = trafficRng();
    const type = u < C.mix.checkout ? 'checkout' : u < C.mix.checkout + C.mix.search ? 'search' : 'recs';
    let svc = C.baseMs[type] * (0.5 + trafficRng());
    if (trafficRng() < C.tailChance) svc *= C.tailFactor; // small natural tail
    if (type === 'recs' && scenario === 'slow' && recsBroken(now)) svc = C.slowRecsMs;
    const req = { type, svc, arrival: now, measured: now >= C.warmupMs, settled: false };
    if (arch === 'split') at(now + C.gatewayMs + hop(), () => enqueue(req));
    else enqueue(req);
    const next = now + (-Math.log(1 - trafficRng()) * 1000) / C.rps;
    if (next < C.durationMs) at(next, arrive);
  };

  at(0, arrive);
  if (scenario === 'redeploy') {
    at(C.redeployAtMs, () => takeDown(arch === 'monolith' ? pools.all : pools.recs,
      arch === 'monolith' ? C.monolithRestartMs : C.serviceRestartMs));
  }

  while (heap.size) {
    const e = heap.pop();
    now = e.t;
    e.fn();
  }

  const windowS = (C.durationMs - C.warmupMs) / 1000;
  const out = {};
  for (const [type, s] of Object.entries(stats)) {
    s.lat.sort((a, b) => a - b);
    const total = s.ok + s.fail;
    out[type] = {
      p50: percentile(s.lat, 0.5),
      p95: percentile(s.lat, 0.95),
      errPct: total ? (100 * s.fail) / total : 0,
      okPerS: s.ok / windowS,
      failed: s.fail,
      total,
    };
  }
  return out;
}

// ---------- run all scenarios ----------
const wallStart = Date.now();
const R = {};
for (const sc of SCENARIOS) {
  R[sc] = {};
  for (const arch of ARCHS) R[sc][arch] = simulate(arch, sc);
}

const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const fmt = (x, d = 1) => (x == null ? '-' : x.toFixed(d));

console.log('sd-19 lab: monolith vs split services (simulated, virtual clock, seed ' + CONFIG.seed + ')');
console.log('');
console.log('scenario   arch      checkout p50  p95      error%  orders/s   recs error%');
for (const sc of SCENARIOS) {
  for (const arch of ARCHS) {
    const c = R[sc][arch].checkout, rc = R[sc][arch].recs;
    console.log(
      sc.padEnd(10) + ' ' + arch.padEnd(9) + ' ' +
      (fmt(c.p50, 2) + ' ms').padEnd(13) + ' ' + (fmt(c.p95, 2) + ' ms').padEnd(8) + ' ' +
      fmt(c.errPct).padStart(6) + '  ' + fmt(c.okPerS).padStart(8) + '   ' + fmt(rc.errPct).padStart(10),
    );
  }
}
console.log('');
console.log('Note: the bad feature (recs) still fails in the split version. The split only stops it from taking checkout down with it.');
console.log('Wall time: ' + (Date.now() - wallStart) + ' ms');
console.log('');

const B = R.baseline, S = R.slow, K = R.crash, D = R.redeploy;
const hopCost = B.split.checkout.p50 == null || B.monolith.checkout.p50 == null
  ? null : B.split.checkout.p50 - B.monolith.checkout.p50;

const allMetrics = [
  { name: 'baseline checkout p50, monolith', value: r2(B.monolith.checkout.p50), unit: 'ms' },
  { name: 'baseline checkout p50, split', value: r2(B.split.checkout.p50), unit: 'ms' },
  { name: 'extra checkout p50 from the hop on a normal day', value: r2(hopCost), unit: 'ms' },
  { name: 'baseline checkout p95, monolith', value: r2(B.monolith.checkout.p95), unit: 'ms' },
  { name: 'baseline checkout p95, split', value: r2(B.split.checkout.p95), unit: 'ms' },
  { name: 'slow recs: checkout errors, monolith', value: r1(S.monolith.checkout.errPct), unit: '%' },
  { name: 'slow recs: checkout errors, split', value: r1(S.split.checkout.errPct), unit: '%' },
  { name: 'slow recs: orders per second, monolith', value: r1(S.monolith.checkout.okPerS), unit: 'orders/s' },
  { name: 'slow recs: orders per second, split', value: r1(S.split.checkout.okPerS), unit: 'orders/s' },
  { name: 'slow recs: checkout p95, split', value: r2(S.split.checkout.p95), unit: 'ms' },
  { name: 'crash-loop recs: checkout errors, monolith', value: r1(K.monolith.checkout.errPct), unit: '%' },
  { name: 'crash-loop recs: checkout errors, split', value: r1(K.split.checkout.errPct), unit: '%' },
  { name: 'crash-loop recs: orders per second, monolith', value: r1(K.monolith.checkout.okPerS), unit: 'orders/s' },
  { name: 'crash-loop recs: orders per second, split', value: r1(K.split.checkout.okPerS), unit: 'orders/s' },
  { name: 'redeploy recs: failed checkouts, monolith', value: D.monolith.checkout.failed, unit: 'orders' },
  { name: 'redeploy recs: failed checkouts, split', value: D.split.checkout.failed, unit: 'orders' },
  { name: 'baseline orders per second (both)', value: r1(B.monolith.checkout.okPerS), unit: 'orders/s' },
];
// A percentile with no successful requests behind it is unavailable, not zero: drop it and name it in setup.
const metrics = allMetrics.filter((m) => m.value != null);
const omitted = allMetrics.filter((m) => m.value == null).map((m) => m.name);

const conclusion =
  `In this toy shop the split cost about ${fmt(hopCost, 1)} ms extra checkout latency on a normal day, ` +
  `but when recommendations slowed to 2 s checkout errors were ${fmt(S.monolith.checkout.errPct)}% in the monolith ` +
  `versus ${fmt(S.split.checkout.errPct)}% split, and in a crash loop ${fmt(K.monolith.checkout.errPct)}% versus ` +
  `${fmt(K.split.checkout.errPct)}%.`;

const C = CONFIG;
const tailMult = 1 + C.tailChance * (C.tailFactor - 1);
const expMean = (t) => r2(C.baseMs[t] * tailMult);
const setup =
  `virtual-clock simulation, seed ${C.seed}, ${C.rps} req/s Poisson, mix checkout/search/recs ` +
  `${C.mix.checkout}/${C.mix.search}/${C.mix.recs}, base service time ${C.baseMs.checkout}/${C.baseMs.search}/${C.baseMs.recs} ms ` +
  `(uniform 0.5x to 1.5x, ${C.tailChance * 100}% of calls x${C.tailFactor}, so expected mean ` +
  `${expMean('checkout')}/${expMean('search')}/${expMean('recs')} ms), ` +
  `16 workers total (monolith 1x16, split ${C.workersSplit.checkout}/${C.workersSplit.search}/${C.workersSplit.recs}), ` +
  `simulated hop ${C.hopOneWayMs[0]} to ${C.hopOneWayMs[1]} ms each way + ${C.gatewayMs} ms gateway, ` +
  `client timeout ${C.timeoutMs} ms, ${C.durationMs / 1000} s per scenario (first ${C.warmupMs / 1000} s not counted), ` +
  `slow recs ${C.slowRecsMs} ms, crash after ${C.crashAfterMs} ms with ${C.crashRestartMs} ms restart, ` +
  `redeploy at ${C.redeployAtMs / 1000} s: monolith restart ${C.monolithRestartMs} ms vs one service ${C.serviceRestartMs} ms; ` +
  `hop, gateway and restart durations are assumed inputs, the metrics are their simulated effect on checkout` +
  (omitted.length ? `; omitted as unavailable (no successful checkouts to take a percentile of): ${omitted.join(', ')}` : '');

console.log('RESULT ' + JSON.stringify({ metrics, conclusion, setup }));
