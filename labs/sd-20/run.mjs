// sd #20 lab: 500 services. How do they find each other?
// Question: when 10% of 500 instances die, how long do callers keep sending
// requests to dead addresses, with a hardcoded list vs a registry (10 s TTL, 2 s TTL)?
//
// Node.js 22 ESM, standard library only. Everything runs in one process on a
// virtual clock (10 ms ticks), so results are repeatable and the run is fast.
// The only real timings are the CPU micro-benchmarks for lookup cost at the end.

// ---------- parameters ----------
const SEED = 20;
const INSTANCES = 500;
const KILL_FRACTION = 0.1;            // 50 instances die
const CALLERS = 20;                   // client services calling the 500
const REQ_PER_CALLER_PER_S = 100;     // 2,000 requests per second in total
const TICK_MS = 10;
const RUN_MS = 60_000;                // 60 virtual seconds per setup
const KILL_AT_MS = 20_000;            // instances die at t = 20 s
const CALLER_CACHE_MS = 3_000;        // callers cache the registry answer for 3 s
const RTT_BASE_MS = 0.25;             // modeled network round trip to the registry
const RTT_EXTRA_MEAN_MS = 0.5;        // plus an exponential tail with this mean

const SETUPS = [
  { key: 'hardcoded', label: 'Hardcoded list', kind: 'static' },
  { key: 'ttl10', label: 'Registry, 10 s TTL', kind: 'registry', ttlMs: 10_000, heartbeatMs: 2_500 },
  { key: 'ttl2', label: 'Registry, 2 s TTL', kind: 'registry', ttlMs: 2_000, heartbeatMs: 500 },
];

// ---------- seeded random ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Same kill set for every setup, so the comparison is fair.
const killSet = (() => {
  const rng = mulberry32(SEED * 7919);
  const ids = Array.from({ length: INSTANCES }, (_, i) => i);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids.slice(0, Math.round(INSTANCES * KILL_FRACTION));
})();

// ---------- registry ----------
class Registry {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.lastHeartbeat = new Float64Array(INSTANCES).fill(-Infinity);
    this.heartbeats = 0;
    this.lookups = 0;
  }
  register(id, now) { this.lastHeartbeat[id] = now; }
  heartbeat(id, now) { this.lastHeartbeat[id] = now; this.heartbeats++; }
  // Healthy = heard from within the TTL. Expiry is checked at lookup time.
  lookup(now) {
    this.lookups++;
    const out = [];
    for (let i = 0; i < INSTANCES; i++) {
      if (now - this.lastHeartbeat[i] <= this.ttlMs) out.push(i);
    }
    return out;
  }
}

// ---------- one setup ----------
// Same caller workload for every setup: start positions and cache phases come from
// their own seeded generator, so no setup consumes random numbers another does not.
const callerStarts = (() => {
  const rng = mulberry32(SEED);
  return Array.from({ length: CALLERS }, () => ({
    rr: Math.floor(rng() * INSTANCES),
    cachePhaseMs: rng() * CALLER_CACHE_MS,
  }));
})();

function runSetup(setup) {
  const rng = mulberry32(SEED + 2);   // heartbeat phase and jitter only
  const rttRng = mulberry32(SEED + 1); // assumed registry round trip only
  const alive = new Uint8Array(INSTANCES).fill(1);
  const registry = setup.kind === 'registry' ? new Registry(setup.ttlMs) : null;
  const staticList = Array.from({ length: INSTANCES }, (_, i) => i);

  // Instances register at t = 0 and heartbeat with a random phase and +/-10% jitter.
  const nextHeartbeat = new Float64Array(INSTANCES);
  if (registry) {
    for (let i = 0; i < INSTANCES; i++) {
      registry.register(i, 0);
      nextHeartbeat[i] = rng() * setup.heartbeatMs;
    }
  }

  // Callers: each has its own cached list, cache expiry (staggered) and round-robin pointer.
  const callers = [];
  for (let c = 0; c < CALLERS; c++) {
    callers.push({
      list: registry ? registry.lookup(0) : staticList,
      expiresAt: callerStarts[c].cachePhaseMs,
      rr: callerStarts[c].rr,
      pending: null, // { list, readyAt }: a refresh in flight on the virtual clock
    });
  }
  if (registry) registry.lookups = 0; // do not count the warm-up lookups

  const reqPerTick = (REQ_PER_CALLER_PER_S * TICK_MS) / 1000;
  const bucketMs = 5_000;
  const buckets = new Array(RUN_MS / bucketMs).fill(0);
  let requests = 0, failed = 0, lastFailAt = -1, refreshes = 0, rttSum = 0;

  for (let t = 0; t < RUN_MS; t += TICK_MS) {
    if (t === KILL_AT_MS) for (const id of killSet) alive[id] = 0;

    if (registry) {
      for (let i = 0; i < INSTANCES; i++) {
        if (alive[i] && t >= nextHeartbeat[i]) {
          registry.heartbeat(i, t);
          nextHeartbeat[i] = t + setup.heartbeatMs * (0.9 + 0.2 * rng());
        }
      }
    }

    for (const caller of callers) {
      // A refresh whose assumed round trip has elapsed lands now. Until then the
      // caller keeps routing with its old (possibly stale) list.
      if (caller.pending && t >= caller.pending.readyAt) {
        caller.list = caller.pending.list;
        caller.pending = null;
      }
      for (let r = 0; r < reqPerTick; r++) {
        if (registry && !caller.pending && t >= caller.expiresAt) {
          // Non-blocking refresh: the registry answers with its view at send time,
          // and the answer arrives after the assumed round trip (next tick at the earliest).
          const rtt = RTT_BASE_MS - RTT_EXTRA_MEAN_MS * Math.log(1 - rttRng());
          caller.pending = { list: registry.lookup(t), readyAt: t + rtt };
          caller.expiresAt = t + rtt + CALLER_CACHE_MS;
          refreshes++;
          rttSum += rtt;
        }
        const id = caller.list[caller.rr++ % caller.list.length];
        requests++;
        if (!alive[id]) {
          failed++;
          lastFailAt = t;
          buckets[Math.floor(t / bucketMs)]++;
        }
      }
    }
  }

  const stillFailingAtEnd = lastFailAt >= RUN_MS - 1_000;
  return {
    ...setup,
    requests,
    failed,
    staleWindowS: lastFailAt < 0 ? 0 : (lastFailAt + TICK_MS - KILL_AT_MS) / 1000,
    stillFailingAtEnd,
    buckets,
    heartbeatsPerS: registry ? registry.heartbeats / (RUN_MS / 1000) : 0,
    lookupsPerS: registry ? registry.lookups / (RUN_MS / 1000) : 0,
    refreshes,
    meanRttMs: refreshes ? rttSum / refreshes : 0,
  };
}

// ---------- CPU cost of a lookup (real measurement, in-process) ----------
function benchCachedPickMs() {
  const list = Array.from({ length: INSTANCES }, (_, i) => i);
  const ops = 2_000_000;
  let rr = 0, sink = 0, expiresAt = Infinity;
  const t0 = process.hrtime.bigint();
  for (let k = 0; k < ops; k++) {
    if (k >= expiresAt) sink--;
    sink += list[rr++ % list.length];
  }
  const ns = Number(process.hrtime.bigint() - t0) / ops;
  if (sink === -1) console.log(''); // keep the loop from being optimised away
  return ns / 1e6;
}

function benchRegistryQueryMs() {
  const reg = new Registry(2_000);
  for (let i = 0; i < INSTANCES; i++) reg.register(i, 1_000);
  const ops = 5_000;
  let sink = 0;
  const t0 = process.hrtime.bigint();
  for (let k = 0; k < ops; k++) sink += reg.lookup(2_000).length;
  const ns = Number(process.hrtime.bigint() - t0) / ops;
  if (sink === -1) console.log('');
  return ns / 1e6;
}

// ---------- run ----------
const wallStart = Date.now();
const results = SETUPS.map(runSetup);
const by = Object.fromEntries(results.map((r) => [r.key, r]));

const cachedMs = benchCachedPickMs();
const queryCpuMs = benchRegistryQueryMs();
const assumedRttMs = by.ttl2.meanRttMs; // assumed, not measured: drawn from the RTT model
const uncachedEstimateMs = queryCpuMs + assumedRttMs; // estimate = measured CPU + assumed network
// Refreshes run in the background, so requests never wait on them. Registry CPU per
// request is the refresh CPU spread over all requests.
const registryCpuPerRequestMs = (by.ttl2.refreshes * queryCpuMs) / by.ttl2.requests;

const r1 = (x) => Math.round(x * 10) / 10;
const r4 = (x) => Math.round(x * 10_000) / 10_000;

console.log(`sd #20 service discovery lab`);
console.log(`${INSTANCES} instances, ${killSet.length} killed at t=${KILL_AT_MS / 1000}s, ${CALLERS} callers x ${REQ_PER_CALLER_PER_S} req/s, run ${RUN_MS / 1000}s, caller cache ${CALLER_CACHE_MS / 1000}s\n`);

console.log('Failed requests per 5 s window (kill happens at 20 s):');
const header = 'setup                 ' + results[0].buckets.map((_, i) => String(i * 5).padStart(6)).join('');
console.log(header);
for (const r of results) console.log(r.label.padEnd(22) + r.buckets.map((b) => String(b).padStart(6)).join(''));
console.log('');

for (const r of results) {
  const stale = r.stillFailingAtEnd ? `${r1(r.staleWindowS)} s and still failing at end of run` : `${r1(r.staleWindowS)} s`;
  const traffic = r.kind === 'registry'
    ? `, heartbeats ${r1(r.heartbeatsPerS)}/s, registry lookups ${r1(r.lookupsPerS)}/s`
    : ', no registry traffic';
  console.log(`${r.label.padEnd(22)} failed ${String(r.failed).padStart(5)} of ${r.requests}, stale window ${stale}${traffic}`);
}
console.log('');
console.log(`Cached pick: ${r4(cachedMs)} ms (measured CPU)`);
console.log(`Registry query: ${r4(queryCpuMs)} ms (measured CPU, in-process)`);
console.log(`Registry round trip: ${r4(assumedRttMs)} ms mean (assumed from the RTT model, not measured)`);
console.log(`Uncached lookup estimate: ${r4(uncachedEstimateMs)} ms (measured CPU + assumed round trip)`);
console.log(`2 s TTL setup: ${by.ttl2.refreshes} background refreshes for ${by.ttl2.requests} requests, registry CPU ${r4(registryCpuPerRequestMs)} ms per request; requests never wait on a refresh`);
console.log(`Wall time ${((Date.now() - wallStart) / 1000).toFixed(1)} s\n`);

const hbRatio = by.ttl10.heartbeatsPerS ? by.ttl2.heartbeatsPerS / by.ttl10.heartbeatsPerS : 0;
const result = {
  metrics: [
    { name: 'Failed requests, hardcoded list', value: by.hardcoded.failed, unit: 'requests' },
    { name: 'Failed requests, registry 10 s TTL', value: by.ttl10.failed, unit: 'requests' },
    { name: 'Failed requests, registry 2 s TTL', value: by.ttl2.failed, unit: 'requests' },
    { name: 'Stale window, hardcoded list (until end of run)', value: r1(by.hardcoded.staleWindowS), unit: 's' },
    { name: 'Stale window, registry 10 s TTL', value: r1(by.ttl10.staleWindowS), unit: 's' },
    { name: 'Stale window, registry 2 s TTL', value: r1(by.ttl2.staleWindowS), unit: 's' },
    { name: 'Heartbeats to registry, 10 s TTL', value: r1(by.ttl10.heartbeatsPerS), unit: 'per s' },
    { name: 'Heartbeats to registry, 2 s TTL', value: r1(by.ttl2.heartbeatsPerS), unit: 'per s' },
    { name: 'Cached pick, measured CPU', value: r4(cachedMs), unit: 'ms' },
    { name: 'Registry query, measured CPU', value: r4(queryCpuMs), unit: 'ms' },
    { name: 'Registry round trip, assumed (not measured)', value: r4(assumedRttMs), unit: 'ms' },
    { name: 'Uncached lookup estimate (measured CPU + assumed round trip)', value: r4(uncachedEstimateMs), unit: 'ms' },
  ],
  conclusion:
    `A hardcoded list kept sending traffic to dead instances for all ${r1(by.hardcoded.staleWindowS)} s after the crash (${by.hardcoded.failed} failed requests), ` +
    `while a registry stopped it after ${r1(by.ttl10.staleWindowS)} s with a 10 s TTL (${by.ttl10.failed} failures) and ${r1(by.ttl2.staleWindowS)} s with a 2 s TTL (${by.ttl2.failed} failures), ` +
    `and the faster configuration (2 s TTL with heartbeats every 0.5 s instead of 2.5 s) paid for that with ${r1(hbRatio)}x the heartbeat traffic.`,
  setup:
    `${INSTANCES} in-process instances, ${killSet.length} killed at ${KILL_AT_MS / 1000} s, ${CALLERS} callers at ${REQ_PER_CALLER_PER_S} req/s each, ` +
    `${RUN_MS / 1000} s virtual run in ${TICK_MS} ms ticks, caller cache ${CALLER_CACHE_MS / 1000} s, ` +
    `TTL 10 s with 2.5 s heartbeat vs TTL 2 s with 0.5 s heartbeat (+/-10% jitter), ` +
    `same caller start positions and cache phases in all setups, ` +
    `registry round trip assumed as ${RTT_BASE_MS} ms + exp(mean ${RTT_EXTRA_MEAN_MS} ms) and scheduled on the virtual clock (a refresh lands on the first tick at or after it), ` +
    `no retries, seed ${SEED}`,
};
console.log('RESULT ' + JSON.stringify(result));
