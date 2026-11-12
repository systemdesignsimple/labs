// sd-11 lab: fail-over, active-passive vs active-active.
// Node.js 22 ESM, standard library only. Everything runs in one process on a
// virtual clock (discrete-event simulation), so results are repeatable and the
// whole run takes well under a second of real time.

const CFG = {
  rps: 50,                 // steady client load
  durationMs: 30000,       // virtual length of one run
  killAtMs: 10000,         // primary is killed here
  runs: 5,                 // repeats per mode
  baseSeed: 1100,          // run k uses seed baseSeed + k (same seeds for both modes)
  arrivalJitterMs: 4,      // each request is sent 0..4 ms after its 20 ms slot
  hopMs: 1,                // one network hop (client/proxy to server, and back)
  workersPerServer: 2,     // requests a server handles at once; the rest wait in its queue
  serviceMinMs: 8,         // service time = 8 ms + exponential(mean 22 ms), capped
  serviceExpMeanMs: 22,
  serviceCapMs: 400,
  hcIntervalMs: 1000,      // active-passive health check every 1 s
  hcFailThreshold: 3,      // switch after 3 failed checks in a row
  coldRequests: 50,        // an idle standby is "cold" for its first 50 requests
  coldExtraMs: 30,         // extra service time on the first cold request, fading to 0
  steadyAfterKillMs: 5000, // "after" latency window starts 5 s after the kill
};

// ---------- seeded random ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- event loop on a virtual clock ----------
class Sim {
  constructor() { this.t = 0; this.heap = []; this.seq = 0; }
  at(t, fn) {
    const h = this.heap;
    h.push({ t, s: this.seq++, fn });
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.less(h[i], h[p])) { [h[i], h[p]] = [h[p], h[i]]; i = p; } else break;
    }
  }
  less(a, b) { return a.t < b.t || (a.t === b.t && a.s < b.s); }
  pop() {
    const h = this.heap;
    const top = h[0];
    const last = h.pop();
    if (h.length) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < h.length && this.less(h[l], h[m])) m = l;
        if (r < h.length && this.less(h[r], h[m])) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m], h[i]];
        i = m;
      }
    }
    return top;
  }
  run() {
    while (this.heap.length) {
      const e = this.pop();
      this.t = e.t;
      e.fn();
    }
  }
}

// ---------- a server with a few workers and a queue ----------
class Server {
  constructor(sim, name, rng, cold) {
    this.sim = sim; this.name = name; this.rng = rng;
    this.alive = true; this.busy = 0; this.queue = []; this.running = new Set();
    this.coldLeft = cold ? CFG.coldRequests : 0;
  }
  // job.onDone(ok, reason) is called at the server; the caller adds the return hop.
  handle(job) {
    if (!this.alive) { job.onDone(false, 'refused'); return; } // process gone, port closed
    if (this.busy < CFG.workersPerServer) this.start(job); else this.queue.push(job);
  }
  start(job) {
    this.busy++;
    const u = this.rng();
    let svc = CFG.serviceMinMs - CFG.serviceExpMeanMs * Math.log(1 - u);
    svc = Math.min(svc, CFG.serviceCapMs);
    if (this.coldLeft > 0) {
      svc += (CFG.coldExtraMs * this.coldLeft) / CFG.coldRequests;
      this.coldLeft--;
    }
    job.cancelled = false;
    this.running.add(job);
    this.sim.at(this.sim.t + svc, () => {
      if (job.cancelled) return;
      this.running.delete(job);
      this.busy--;
      job.onDone(true, 'ok');
      if (this.queue.length) this.start(this.queue.shift());
    });
  }
  kill() {
    this.alive = false;
    for (const j of this.running) { j.cancelled = true; j.onDone(false, 'reset'); }
    for (const j of this.queue) j.onDone(false, 'reset');
    this.running.clear(); this.queue = []; this.busy = 0;
  }
}

// ---------- proxies ----------
// Active-passive: all traffic to the primary; health check every 1 s;
// switch to the standby after 3 failed checks in a row.
function activePassiveProxy(sim, primary, standby, rng) {
  const state = { active: primary, fails: 0, switchedAt: null };
  const tick = () => {
    if (sim.t > CFG.durationMs) return;
    const target = state.active;
    sim.at(sim.t + CFG.hopMs, () => {
      const ok = target.alive;
      sim.at(sim.t + CFG.hopMs, () => {
        if (target !== state.active) return;
        if (ok) { state.fails = 0; return; }
        state.fails++;
        if (state.fails >= CFG.hcFailThreshold && state.active === primary) {
          state.active = standby; state.fails = 0; state.switchedAt = sim.t;
        }
      });
    });
    sim.at(sim.t + CFG.hcIntervalMs, tick);
  };
  sim.at(rng() * CFG.hcIntervalMs, tick); // check phase differs per run
  return {
    state,
    pick: () => state.active,
    onResult: () => {},
  };
}

// Active-active: round-robin over both; a server is dropped as soon as one
// request to it fails. No retries, no health checks.
function activeActiveProxy(primary, standby) {
  const healthy = [primary, standby];
  let rr = 0;
  return {
    state: { healthy },
    pick: () => (healthy.length ? healthy[rr++ % healthy.length] : null),
    onResult: (srv, ok) => {
      if (ok) return;
      const i = healthy.indexOf(srv);
      if (i >= 0) healthy.splice(i, 1);
    },
  };
}

// ---------- one run ----------
function runOnce(mode, seed) {
  const sim = new Sim();
  const rngLoad = mulberry32(seed);
  const rngHc = mulberry32(seed * 7 + 3);
  const primary = new Server(sim, 'primary', mulberry32(seed * 31 + 1), false);
  // An idle passive standby starts cold; in active-active both are already warm.
  const standby = new Server(sim, 'standby', mulberry32(seed * 31 + 2), mode === 'active-passive');
  const proxy = mode === 'active-passive'
    ? activePassiveProxy(sim, primary, standby, rngHc)
    : activeActiveProxy(primary, standby);

  const recs = [];
  const n = Math.floor((CFG.durationMs / 1000) * CFG.rps);
  const slot = 1000 / CFG.rps;
  for (let i = 0; i < n; i++) {
    const sent = i * slot + rngLoad() * CFG.arrivalJitterMs;
    const rec = { id: i, sent, done: null, ok: null, reason: null, server: null };
    recs.push(rec);
    sim.at(sent, () => {
      const srv = proxy.pick();
      if (!srv) { rec.done = sim.t; rec.ok = false; rec.reason = 'no-backend'; return; }
      rec.server = srv.name;
      sim.at(sim.t + CFG.hopMs, () => {
        srv.handle({
          onDone: (ok, reason) => {
            sim.at(sim.t + CFG.hopMs, () => {
              rec.done = sim.t; rec.ok = ok; rec.reason = reason;
              proxy.onResult(srv, ok);
            });
          },
        });
      });
    });
  }
  sim.at(CFG.killAtMs, () => primary.kill());
  sim.run();

  const failed = recs.filter((r) => !r.ok);
  const firstFail = failed.length ? Math.min(...failed.map((r) => r.done)) : null;
  // Outage gap: first observed failure -> first successful completion of ANY
  // request after it (including requests already in flight on the survivor).
  // Recovery latency: first observed failure -> first success of a request
  // SENT after that failure (how long a brand-new user waits for service).
  let firstOkDone = null; // any request completing ok at/after the first failure
  let firstOkAfter = null; // newly sent request completing ok
  if (firstFail !== null) {
    for (const r of recs) {
      if (!r.ok || r.done < firstFail) continue;
      if (firstOkDone === null || r.done < firstOkDone) firstOkDone = r.done;
      if (r.sent >= firstFail && (!firstOkAfter || r.done < firstOkAfter.done)) firstOkAfter = r;
    }
  }
  const gapMs = firstFail !== null && firstOkDone !== null ? firstOkDone - firstFail : 0;
  const recoveryMs = firstFail !== null && firstOkAfter ? firstOkAfter.done - firstFail : 0;
  const lat = (filter) => recs.filter((r) => r.ok && filter(r)).map((r) => r.done - r.sent);
  const before = lat((r) => r.sent >= 1000 && r.sent < CFG.killAtMs);
  const after = lat((r) => r.sent >= CFG.killAtMs + CFG.steadyAfterKillMs && r.sent < CFG.durationMs);
  const takeoverStart = firstOkAfter ? firstOkAfter.sent : CFG.killAtMs;
  const takeover = lat((r) => r.sent >= takeoverStart && r.sent < takeoverStart + 1000);

  return {
    mode, seed,
    total: recs.length,
    failed: failed.length,
    reset: failed.filter((r) => r.reason === 'reset').length,
    refused: failed.filter((r) => r.reason === 'refused').length,
    gapMs,
    recoveryMs,
    p95BeforeMs: p95(before),
    p95AfterMs: p95(after),
    p95TakeoverMs: p95(takeover),
    switchedAt: proxy.state.switchedAt ?? null,
  };
}

// ---------- stats helpers ----------
function p95(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(0.95 * s.length) - 1)];
}
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const r1 = (x) => Math.round(x * 10) / 10;
const summary = (rows, key) => {
  const xs = rows.map((r) => r[key]);
  return { med: r1(median(xs)), min: r1(Math.min(...xs)), max: r1(Math.max(...xs)) };
};

// ---------- main ----------
const modes = ['active-passive', 'active-active'];
const results = {};
for (const mode of modes) {
  results[mode] = [];
  for (let k = 0; k < CFG.runs; k++) results[mode].push(runOnce(mode, CFG.baseSeed + k));
}

console.log(`sd-11 fail-over lab: ${CFG.rps} req/s for ${CFG.durationMs / 1000} s, primary killed at ${CFG.killAtMs / 1000} s, ${CFG.runs} runs per mode`);
console.log('gap = first failure to first success of any request; recovery = first failure to first success of a request sent after it');
console.log('mode            seed  failed (reset/refused)  gap ms  recovery ms  p95 before  p95 after  p95 1st s after takeover');
for (const mode of modes) {
  for (const r of results[mode]) {
    console.log(
      `${mode.padEnd(15)} ${String(r.seed).padStart(4)}  ${String(r.failed).padStart(6)} (${r.reset}/${r.refused})`.padEnd(46) +
      `${r1(r.gapMs).toString().padStart(6)}  ${r1(r.recoveryMs).toString().padStart(11)}  ${r1(r.p95BeforeMs).toString().padStart(10)}  ${r1(r.p95AfterMs).toString().padStart(9)}  ${r1(r.p95TakeoverMs).toString().padStart(10)}`
    );
  }
}

// Every measurement is reported as median, min and max over the runs.
const MEASURES = [
  { key: 'failed', label: 'failed requests', unit: 'requests' },
  { key: 'gapMs', label: 'outage gap (first failure to first success of any request)', unit: 'ms' },
  { key: 'recoveryMs', label: 'recovery latency (first failure to first success of a newly sent request)', unit: 'ms' },
  { key: 'p95BeforeMs', label: 'p95 latency before kill', unit: 'ms' },
  { key: 'p95TakeoverMs', label: 'p95 latency first second after takeover', unit: 'ms' },
  { key: 'p95AfterMs', label: 'p95 latency steady after kill', unit: 'ms' },
];
const S = {};
for (const mode of modes) {
  S[mode] = {};
  for (const m of MEASURES) S[mode][m.key] = summary(results[mode], m.key);
}
const ap = S['active-passive'];
const aa = S['active-active'];

console.log('');
for (const mode of modes) {
  console.log(`${mode}:`);
  for (const m of MEASURES) {
    const s = S[mode][m.key];
    console.log(`  ${m.label}: median ${s.med} ${m.unit} (range ${s.min} to ${s.max})`);
  }
}

const metrics = [];
for (const mode of modes) {
  for (const m of MEASURES) {
    const s = S[mode][m.key];
    for (const [stat, value] of [['median', s.med], ['min', s.min], ['max', s.max]]) {
      metrics.push({ name: `${mode} ${m.label} (${stat})`, value, unit: m.unit });
    }
  }
}

let conclusion;
if (ap.failed.med > aa.failed.med && ap.gapMs.med > aa.gapMs.med) {
  conclusion =
    `Killing the primary cost active-passive a median ${ap.failed.med} failed requests over a ${ap.gapMs.med} ms gap with no successes, ` +
    `while active-active lost only ${aa.failed.med} and kept serving (gap ${aa.gapMs.med} ms)` +
    (aa.p95AfterMs.med > aa.p95BeforeMs.med
      ? `, but its surviving server's p95 latency rose from ${aa.p95BeforeMs.med} ms to ${aa.p95AfterMs.med} ms under double load.`
      : '.');
} else {
  conclusion =
    `In this run active-passive lost a median ${ap.failed.med} requests (gap ${ap.gapMs.med} ms) and active-active lost ${aa.failed.med} (gap ${aa.gapMs.med} ms), so the expected difference did not appear with these settings.`;
}

const setup =
  `in-process simulation, virtual clock; ${CFG.rps} req/s for ${CFG.durationMs / 1000} s, primary killed at ${CFG.killAtMs / 1000} s; ` +
  `2 servers x ${CFG.workersPerServer} workers, service ${CFG.serviceMinMs} ms + exp(mean ${CFG.serviceExpMeanMs} ms), hop ${CFG.hopMs} ms; ` +
  `active-passive: health check every ${CFG.hcIntervalMs} ms, switch after ${CFG.hcFailThreshold} failures, cold standby +${CFG.coldExtraMs} ms fading over ${CFG.coldRequests} requests; ` +
  `active-active: round-robin, drop server on first failed request, no retries; ` +
  `${CFG.runs} runs per mode, seeds ${CFG.baseSeed} to ${CFG.baseSeed + CFG.runs - 1}, median, min and max reported for every measurement`;

console.log('RESULT ' + JSON.stringify({ metrics, conclusion, setup }));
