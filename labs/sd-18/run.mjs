// sd-18 lab: One giant server or a thousand small ones? (horizontal vs vertical scaling)
// Node.js 22 ESM, standard library only. A queueing simulation in virtual time with a fixed seed,
// so every run prints the same numbers. No network, no child processes, no files.
//
// Nothing here measures real CPU work, real cores or a real HTTP server. Every service time,
// lock hold, hop and contention penalty below is an ASSUMED cost, and the scaling behaviour the
// run reports follows from those assumptions. The run varies the key assumptions so you can see
// how much of each difference they explain.

const P = {
  seed: 1818,
  sizes: [1, 2, 4, 8],           // cores for vertical, single-core instances for horizontal
  maxVerticalCores: 8,           // configured cap standing in for "the biggest machine"; not detected
  cpuMs: 5,                      // assumed mean CPU work per request (Erlang-2 distributed)
  // Baseline vertical assumption: in-process store behind one mutex; a worker holds its core while it waits.
  lockHoldMs: 0.4,               // assumed mean lock hold per store read
  contentionPerExtraCore: 0.03,  // assumed CPU inflation per extra core sharing one memory space
  contentionSweep: [0, 0.015, 0.03, 0.06],
  // Baseline horizontal assumption: separate single-threaded store service (Redis-like), read without holding a core.
  lbHopMs: 0.3,                  // load balancer hop, each way
  netHopMs: 0.25,                // instance to store, each way
  storeServiceMs: 0.15,          // mean store service time per read
  serializeMs: 0.3,              // extra CPU per request to encode/decode the store reply
  // Sustainable-throughput ramp
  p95LimitMs: 200,
  stepSeconds: 4,                // arrivals run for this long at each step
  warmupSeconds: 1,              // observation window = [warmup, step end)
  tailMs: 400,                   // extra time after arrivals stop, only to resolve latencies of the window cohort
  backlogSlack: 0.02,            // allowed backlog growth over the window: max(size, 2% of window arrivals)
  rampStartRps: 20,
  coarseFactor: 1.2,
  fineFactor: 1.02,
  rampMaxRps: 5000,
  // Failure test
  fail: {
    seconds: 10,
    killAtMs: 4000,
    restartMs: 3000,
    healthEveryMs: 250,
    healthFailsToEject: 2,
    loadShare: 0.7,              // share of the weaker 8-core setup's sustained completion rate
    bucketMs: 100,
  },
  deadlineMs: 50000,             // wall-clock guard, checked between steps and inside the event loop
};

// ---------- wall-clock deadline ----------
const t0 = performance.now();
class DeadlineError extends Error {}
function checkDeadline() {
  if (performance.now() - t0 > P.deadlineMs) throw new DeadlineError('wall-clock deadline reached');
}

// ---------- deterministic randomness ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashSeed(...parts) {
  let h = 2166136261;
  for (const ch of parts.join('|')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
const expo = (rand, mean) => -mean * Math.log(1 - rand());
const erlang2 = (rand, mean) => expo(rand, mean / 2) + expo(rand, mean / 2);

// ---------- event loop in virtual milliseconds ----------
const less = (a, b) => a.t < b.t || (a.t === b.t && a.s < b.s);
class Sim {
  constructor() { this.now = 0; this.q = []; this.n = 0; }
  at(t, fn) {
    const e = { t, s: this.n++, fn };
    const q = this.q;
    let i = q.length;
    q.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (less(q[p], e)) break;
      q[i] = q[p];
      i = p;
    }
    q[i] = e;
  }
  after(d, fn) { this.at(this.now + d, fn); }
  pop() {
    const q = this.q;
    const top = q[0];
    const last = q.pop();
    const n = q.length;
    if (n) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && less(q[r], q[l]) ? r : l;
        if (less(last, q[c])) break;
        q[i] = q[c];
        i = c;
      }
      q[i] = last;
    }
    return top;
  }
  run(untilMs) {
    let k = 0;
    while (this.q.length && this.q[0].t <= untilMs) {
      if ((++k & 0xffff) === 0) checkDeadline();
      const e = this.pop();
      this.now = e.t;
      e.fn();
    }
  }
}

class Deque {
  constructor() { this.a = []; this.h = 0; }
  push(x) { this.a.push(x); }
  shift() {
    if (this.h >= this.a.length) return undefined;
    const x = this.a[this.h];
    this.a[this.h++] = undefined;
    if (this.h > 1024 && this.h * 2 > this.a.length) { this.a = this.a.slice(this.h); this.h = 0; }
    return x;
  }
  get length() { return this.a.length - this.h; }
}

// Single-threaded FIFO store service; callers wait asynchronously (no core held).
function makeStore(sim, rand) {
  const st = { busy: false, queue: new Deque() };
  function pump() {
    if (st.busy || !st.queue.length) return;
    st.busy = true;
    const cb = st.queue.shift();
    sim.after(expo(rand, P.storeServiceMs), () => { st.busy = false; cb(); pump(); });
  }
  return { read(cb) { st.queue.push(cb); pump(); } };
}

// ---------- configurations ----------
// vertical: { store: 'mutex' (baseline) | 'service' (matched to horizontal), contention }
// horizontal: { hops: true (baseline) | false (matched: no LB/network hops, no serialize cost) }
const V = (size, o = {}) => ({ kind: 'vertical', size, store: 'mutex', contention: P.contentionPerExtraCore, ...o });
const H = (size, o = {}) => ({ kind: 'horizontal', size, hops: true, ...o });
const cfgKey = (c) => (c.kind === 'vertical' ? `v/${c.size}/${c.store}/${c.contention}` : `h/${c.size}/${c.hops}`);

// ---------- vertical: one instance, N worker cores, one shared queue ----------
function buildVertical(sim, rand, cfg, out) {
  const cores = cfg.size;
  if (cores > P.maxVerticalCores) throw new Error('vertical size exceeds the configured core cap');
  const mult = 1 + cfg.contention * (cores - 1);
  const store = cfg.store === 'service' ? makeStore(sim, rand) : null;
  const s = { alive: true, epoch: 0, queue: new Deque(), busy: 0, pending: new Set(), lockHeld: false, waiters: new Deque() };

  function pump() {
    while (s.alive && s.busy < cores && s.queue.length) {
      const r = s.queue.shift();
      s.busy++;
      if (store) cpu(r);                                   // store already read asynchronously
      else if (!s.lockHeld) { s.lockHeld = true; hold(r); }
      else s.waiters.push(r);                              // worker blocks on the lock, holding its core
    }
  }
  function hold(r) {
    const e = s.epoch;
    sim.after(expo(rand, P.lockHoldMs), () => {
      if (e !== s.epoch) return;
      const w = s.waiters.shift();
      if (w) hold(w); else s.lockHeld = false;
      cpu(r);
    });
  }
  function cpu(r) {
    const e = s.epoch;
    sim.after(erlang2(rand, P.cpuMs) * mult, () => {
      if (e !== s.epoch) return;
      s.busy--;
      s.pending.delete(r);
      out.complete(r);
      pump();
    });
  }
  return {
    submit(r) {
      if (!s.alive) { out.fail(r); return; } // connection refused while down
      r.inst = 0;
      s.pending.add(r);
      if (store) {
        const e = s.epoch;
        store.read(() => { if (e !== s.epoch) return; s.queue.push(r); pump(); });
      } else {
        s.queue.push(r);
        pump();
      }
    },
    kill() {
      s.epoch++;
      s.alive = false;
      for (const r of s.pending) out.fail(r);
      s.pending.clear();
      s.queue = new Deque();
      s.waiters = new Deque();
      s.lockHeld = false;
      s.busy = 0;
      sim.after(P.fail.restartMs, () => { s.alive = true; });
    },
    startHealthChecks() {},
  };
}

// ---------- horizontal: N single-core instances, round-robin LB, one shared store service ----------
function buildHorizontal(sim, rand, cfg, out) {
  const n = cfg.size;
  const lb = cfg.hops ? P.lbHopMs : 0;
  const net = cfg.hops ? P.netHopMs : 0;
  const ser = cfg.hops ? P.serializeMs : 0;
  const inst = Array.from({ length: n }, () => ({
    alive: true, inRotation: true, epoch: 0, queue: new Deque(), busy: false, pending: new Set(), badChecks: 0,
  }));
  const store = makeStore(sim, rand);
  let rr = 0;

  function pick() {
    for (let k = 0; k < n; k++) {
      const idx = (rr + k) % n;
      if (inst[idx].inRotation) { rr = (idx + 1) % n; return idx; }
    }
    return -1;
  }
  function deliver(x, r) {
    if (!x.alive) { out.fail(r); return; }
    x.pending.add(r);
    const e = x.epoch;
    sim.after(net, () => {
      if (e !== x.epoch) return;
      store.read(() => sim.after(net, () => {
        if (e !== x.epoch) return;
        x.queue.push(r);
        pump(x);
      }));
    });
  }
  function pump(x) {
    if (!x.alive || x.busy || !x.queue.length) return;
    x.busy = true;
    const r = x.queue.shift();
    const e = x.epoch;
    sim.after(erlang2(rand, P.cpuMs) + ser, () => {
      if (e !== x.epoch) return;
      x.busy = false;
      x.pending.delete(r);
      r.replied = true;                     // reply is on its way back through the LB
      sim.after(lb, () => out.complete(r));
      pump(x);
    });
  }
  return {
    submit(r) {
      const idx = pick();
      if (idx < 0) { out.fail(r); return; }
      r.inst = idx;
      const x = inst[idx];
      sim.after(lb, () => deliver(x, r));
    },
    kill(i) {
      const x = inst[i];
      x.epoch++;
      x.alive = false;
      for (const r of x.pending) out.fail(r);
      x.pending.clear();
      x.queue = new Deque();
      x.busy = false;
      sim.after(P.fail.restartMs, () => { x.alive = true; });
    },
    startHealthChecks(untilMs) {
      const tick = () => {
        for (const x of inst) {
          if (x.alive) { x.badChecks = 0; x.inRotation = true; }
          else if (++x.badChecks >= P.fail.healthFailsToEject) x.inRotation = false;
        }
        if (sim.now + P.fail.healthEveryMs < untilMs) sim.after(P.fail.healthEveryMs, tick);
      };
      sim.at(P.fail.healthEveryMs / 2, tick);
    },
  };
}

// ---------- one load run ----------
// Arrivals run for `seconds`; the sim continues for tailMs only to resolve the window cohort.
// Ramp runs observe [warmup, end); kill runs observe [0, end) and also keep 100 ms buckets.
function runLoad(cfg, rps, seconds, kill = false) {
  checkDeadline();
  const sim = new Sim();
  const rand = mulberry32(hashSeed(P.seed, cfgKey(cfg), Math.round(rps * 100), seconds, kill ? 1 : 0));
  const endMs = seconds * 1000;
  const stopMs = endMs + P.tailMs;
  const warmMs = kill ? 0 : P.warmupSeconds * 1000;
  const winS = (endMs - warmMs) / 1000;
  const bMs = P.fail.bucketMs;
  const nb = Math.ceil(stopMs / bMs) + 1;
  const bucket = (t) => Math.min(nb - 1, Math.floor(t / bMs));
  const arrByArr = new Array(nb).fill(0);   // arrivals, by arrival time
  const failByArr = new Array(nb).fill(0);  // failures, by the failed request's arrival time (cohort view)
  const compByEv = new Array(nb).fill(0);   // completions, by completion time (event view)
  const failByEv = new Array(nb).fill(0);   // failures, by failure time (event view)
  const inWin = (t) => t >= warmMs && t < endMs;

  const open = new Set();                   // every accepted request not yet completed or failed
  const lat = [];
  let cohortN = 0, cohortFailed = 0, errors = 0, total = 0;
  let winArr = 0, winComp = 0, winFail = 0, backlogStart = 0, backlogEnd = 0;
  let minFailArr = Infinity;

  const out = {
    complete(r) {
      if (r.st) return;
      r.st = 1;
      open.delete(r);
      compByEv[bucket(sim.now)]++;
      if (inWin(sim.now)) winComp++;
      if (r.m) lat.push(sim.now - r.arr);
    },
    fail(r) {
      if (r.st) return;
      r.st = 2;
      open.delete(r);
      errors++;
      failByEv[bucket(sim.now)]++;
      failByArr[bucket(r.arr)]++;
      if (inWin(sim.now)) winFail++;
      if (r.m) cohortFailed++;
      if (r.arr < minFailArr) minFailArr = r.arr;
    },
  };
  const sys = cfg.kind === 'vertical' ? buildVertical(sim, rand, cfg, out) : buildHorizontal(sim, rand, cfg, out);

  const gap = 1000 / rps;
  const arrive = () => {
    const r = { arr: sim.now, m: inWin(sim.now), st: 0, inst: -1, replied: false };
    total++;
    arrByArr[bucket(sim.now)]++;
    if (r.m) { cohortN++; winArr++; }
    open.add(r);
    sys.submit(r);
    const next = sim.now + expo(rand, gap);
    if (next < endMs) sim.at(next, arrive);
  };
  sim.at(Math.min(expo(rand, gap), endMs - 1e-6), arrive);
  sim.at(warmMs, () => { backlogStart = open.size; });
  sim.at(endMs, () => { backlogEnd = open.size; });

  let killInfo = null;
  if (kill) {
    sys.startHealthChecks(stopMs);
    sim.at(P.fail.killAtMs, () => {
      // in flight = every accepted unfinished request, including ones travelling through the LB.
      // lost = those bound for the killed instance that have not yet left it with a reply.
      let lost = 0;
      for (const r of open) if (r.inst === 0 && !r.replied) lost++;
      killInfo = { inFlight: open.size, lost };
      sys.kill(0);
    });
  }
  sim.run(stopMs);

  // p95 over the window cohort; failed or still-unfinished cohort requests count as above the limit.
  const sorted = Float64Array.from(lat).sort();
  const k = Math.max(0, Math.ceil(cohortN * 0.95) - 1);
  const p95 = cohortN && k < sorted.length ? sorted[k] : Infinity;
  const growth = backlogEnd - backlogStart;
  const stable = errors === 0 && p95 <= P.p95LimitMs && growth <= Math.max(cfg.size, P.backlogSlack * winArr);
  return {
    rps, p95, errors, total, stable, cohortFailed,
    arrivalRps: winArr / winS,
    completionRps: winComp / winS,
    backlogGrowthPerS: growth / winS,
    arrByArr, failByArr, compByEv, failByEv, killInfo, minFailArr,
  };
}

// ---------- ramp: highest step whose queues stay stable with p95 under the limit and no errors ----------
function ramp(cfg) {
  let good = null, bad = null;
  for (let rps = P.rampStartRps; rps <= P.rampMaxRps; rps *= P.coarseFactor) {
    const r = runLoad(cfg, rps, P.stepSeconds);
    if (r.stable) good = r; else { bad = r; break; }
  }
  if (good && bad) {
    for (let rps = good.rps * P.fineFactor; rps < bad.rps; rps *= P.fineFactor) {
      const r = runLoad(cfg, rps, P.stepSeconds);
      if (r.stable) good = r; else { bad = r; break; }
    }
  }
  return { good, bad, sustained: good ? good.completionRps : 0 };
}

// ---------- failure test summary ----------
function killSummary(cfg, rps) {
  const r = runLoad(cfg, rps, P.fail.seconds, true);
  const b = P.fail.bucketMs;
  const k0 = Math.floor(P.fail.killAtMs / b);
  // event-time view: what clients see happening in each 100 ms window after the kill
  let majorityBuckets = 0, lastBadEv = -1;
  for (let i = k0; i < r.compByEv.length; i++) {
    const resolved = r.compByEv[i] + r.failByEv[i];
    if (!resolved) continue;
    const share = r.failByEv[i] / resolved;
    if (share >= 0.5) majorityBuckets++;
    if (share > 0.01) lastBadEv = i;
  }
  // arrival-cohort view: which arrival windows had more than 1% of their requests fail (any time later)
  let lastBadArr = -1;
  for (let i = 0; i < r.arrByArr.length; i++) {
    if (r.arrByArr[i] && r.failByArr[i] / r.arrByArr[i] > 0.01) lastBadArr = i;
  }
  const ki = r.killInfo ?? { inFlight: 0, lost: 0 };
  return {
    errors: r.errors,
    total: r.total,
    errorPct: (100 * r.errors) / r.total,
    inFlightAtKill: ki.inFlight,
    lostAtKill: ki.lost,
    lostPct: ki.inFlight ? (100 * ki.lost) / ki.inFlight : 0,
    majorityFailedS: (majorityBuckets * b) / 1000,
    failuresEndS: lastBadEv < 0 ? 0 : ((lastBadEv + 1) * b - P.fail.killAtMs) / 1000,
    cohortEndS: lastBadArr < 0 ? 0 : ((lastBadArr + 1) * b - P.fail.killAtMs) / 1000,
    oldestFailedArrivalMs: Number.isFinite(r.minFailArr) ? Math.max(0, P.fail.killAtMs - r.minFailArr) : 0,
  };
}

// ---------- run everything ----------
const round = (x, d = 0) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : -1);
const pct = (c) => `${round(c * 100, 1)}pct`;

function main() {
  const big = Math.max(...P.sizes);
  const base = { vertical: {}, horizontal: {} };
  for (const size of P.sizes) base.vertical[size] = ramp(V(size));
  for (const size of P.sizes) base.horizontal[size] = ramp(H(size));

  // sensitivity: same vertical 8-core setup, different assumed contention penalty
  const sweep = {};
  for (const c of P.contentionSweep) {
    sweep[c] = c === P.contentionPerExtraCore ? base.vertical[big] : ramp(V(big, { contention: c }));
  }
  // matched comparison: same async single-threaded store for both, no contention, no hops, no serialize cost.
  // The only remaining difference is one shared queue for 8 cores vs 8 round-robin queues of 1 core.
  const matchedV = ramp(V(big, { store: 'service', contention: 0 }));
  const matchedH = ramp(H(big, { hops: false }));

  const v1 = base.vertical[1].sustained, h1 = base.horizontal[1].sustained;
  const v8 = base.vertical[big].sustained, h8 = base.horizontal[big].sustained;

  const halfRps = 0.5 * Math.min(v8, h8);
  const vHalf = runLoad(V(big), halfRps, P.stepSeconds);
  const hHalf = runLoad(H(big), halfRps, P.stepSeconds);

  const failRps = P.fail.loadShare * Math.min(v8, h8);
  const vFail = killSummary(V(big), failRps);
  const hFail = killSummary(H(big), failRps);

  const row = (x) => {
    const g = x.good, b = x.bad;
    const s = g ? `${round(g.rps)} offered, ${round(g.arrivalRps)} arrived, ${round(g.completionRps)} done/s, p95 ${round(g.p95)} ms` : 'none stable';
    const nxt = b ? `; next step ${round(b.rps)}: backlog ${b.backlogGrowthPerS >= 0 ? '+' : ''}${round(b.backlogGrowthPerS)}/s, ` +
      `p95 ${Number.isFinite(b.p95) ? round(b.p95) + ' ms' : 'unresolved'}, errors ${b.errors}` : '';
    return s + nxt;
  };
  console.log('sd-18 horizontal vs vertical scaling: queueing simulation with assumed costs, not a benchmark');
  for (const size of P.sizes) console.log(`vertical   ${size} core   | ${row(base.vertical[size])}`);
  for (const size of P.sizes) console.log(`horizontal ${size} x 1core | ${row(base.horizontal[size])}`);
  for (const c of P.contentionSweep) console.log(`vertical ${big} core, contention ${pct(c)} | ${row(sweep[c])}`);
  console.log(`matched store, vertical ${big} core   | ${row(matchedV)}`);
  console.log(`matched store, horizontal ${big} x 1  | ${row(matchedH)}`);
  console.log(`p95 at ${round(halfRps)} req/s on ${big} cores: vertical ${round(vHalf.p95, 1)} ms, horizontal ${round(hHalf.p95, 1)} ms`);
  for (const [name, f] of [['vertical', vFail], ['horizontal', hFail]]) {
    console.log(`kill ${name} at ${round(failRps)} req/s: ${f.errors}/${f.total} failed, in flight at kill ${f.inFlightAtKill} (lost ${f.lostAtKill}), ` +
      `>=50% failed windows ${f.majorityFailedS}s, >1% failures until kill+${f.failuresEndS}s, oldest failed arrival ${round(f.oldestFailedArrivalMs)} ms before kill`);
  }
  console.log(`wall time ${round((performance.now() - t0) / 1000, 1)}s (deadline ${P.deadlineMs / 1000}s)`);

  const m = [{ name: 'run_completed', value: 1, unit: 'flag' }];
  for (const size of P.sizes) m.push({ name: `vertical_sustained_${size}core`, value: round(base.vertical[size].sustained), unit: 'completions/s' });
  for (const size of P.sizes) m.push({ name: `horizontal_sustained_${size}x1core`, value: round(base.horizontal[size].sustained), unit: 'completions/s' });
  m.push(
    { name: `vertical_scaling_efficiency_${big}`, value: round((100 * v8) / (big * v1), 1), unit: '%' },
    { name: `horizontal_scaling_efficiency_${big}`, value: round((100 * h8) / (big * h1), 1), unit: '%' },
    { name: `vertical_p95_at_sustained_${big}`, value: round(base.vertical[big].good?.p95, 1), unit: 'ms' },
    { name: `horizontal_p95_at_sustained_${big}`, value: round(base.horizontal[big].good?.p95, 1), unit: 'ms' },
    { name: `vertical_backlog_growth_next_step_${big}`, value: round(base.vertical[big].bad?.backlogGrowthPerS ?? NaN), unit: 'requests/s' },
    { name: `horizontal_backlog_growth_next_step_${big}`, value: round(base.horizontal[big].bad?.backlogGrowthPerS ?? NaN), unit: 'requests/s' },
  );
  for (const c of P.contentionSweep) m.push({ name: `vertical_sustained_${big}core_contention_${pct(c)}`, value: round(sweep[c].sustained), unit: 'completions/s' });
  m.push(
    { name: `matched_store_vertical_sustained_${big}core`, value: round(matchedV.sustained), unit: 'completions/s' },
    { name: `matched_store_horizontal_sustained_${big}x1core`, value: round(matchedH.sustained), unit: 'completions/s' },
    { name: 'vertical_p95_at_half_load', value: round(vHalf.p95, 1), unit: 'ms' },
    { name: 'horizontal_p95_at_half_load', value: round(hHalf.p95, 1), unit: 'ms' },
    { name: 'kill_test_offered_rate', value: round(failRps), unit: 'req/s' },
  );
  for (const [name, f] of [['vertical', vFail], ['horizontal', hFail]]) {
    m.push(
      { name: `${name}_kill_failed_requests`, value: f.errors, unit: 'requests' },
      { name: `${name}_kill_failed_share`, value: round(f.errorPct, 2), unit: '% of all requests' },
      { name: `${name}_inflight_at_kill`, value: f.inFlightAtKill, unit: 'requests (all accepted, unfinished)' },
      { name: `${name}_inflight_lost_at_kill`, value: round(f.lostPct, 1), unit: '%' },
      { name: `${name}_majority_failed_windows`, value: f.majorityFailedS, unit: 's (100 ms event-time windows with >=50% failed)' },
      { name: `${name}_failures_end_after_kill`, value: f.failuresEndS, unit: 's (end of last 100 ms event-time window with >1% failed)' },
      { name: `${name}_cohort_failures_end_after_kill`, value: f.cohortEndS, unit: 's (end of last 100 ms arrival window with >1% failed)' },
      { name: `${name}_oldest_failed_arrival_before_kill`, value: round(f.oldestFailedArrivalMs), unit: 'ms' },
    );
  }

  const V8 = round(v8), H8 = round(h8), MV = round(matchedV.sustained), MH = round(matchedH.sustained);
  const c0 = round(sweep[P.contentionSweep[0]].sustained);
  const cMax = P.contentionSweep[P.contentionSweep.length - 1];
  const cHi = round(sweep[cMax].sustained);
  const conclusion =
    `In this queueing model with assumed costs, on ${big} cores the big server sustained ${V8} and ${big} small servers ${H8} ` +
    `completions/s, a gap that follows the assumptions (the big server ranged from ${c0} at 0% to ${cHi} at ${round(cMax * 100)}% assumed ` +
    `per-core contention, and with matched store costs it was ${MV} vs ${MH}), while killing the single server failed ` +
    `${round(vFail.errorPct, 1)}% of requests with ${vFail.majorityFailedS}s of majority-failed windows and killing one of ${big} ` +
    `small servers lost ${round(hFail.lostPct, 1)}% of in-flight requests with failures above 1% ending ${hFail.failuresEndS}s after the kill.`;

  console.log('RESULT ' + JSON.stringify({ metrics: m, conclusion, setup: setupText(big) }));
}

function setupText(big) {
  return `queueing simulation, assumed costs, seed ${P.seed}; request = Erlang-2 CPU ${P.cpuMs} ms + one shared store read; ` +
    `vertical baseline: 1 instance with 1/2/4/8 cores (cap ${P.maxVerticalCores} is configured), in-process store behind one mutex ` +
    `(hold ${P.lockHoldMs} ms, worker keeps its core while waiting), +${P.contentionPerExtraCore * 100}% CPU per extra core; ` +
    `horizontal baseline: 1/2/4/8 single-core instances, round-robin LB (${P.lbHopMs} ms each way), async single-threaded store ` +
    `(${P.storeServiceMs} ms service, ${P.netHopMs} ms hop each way), +${P.serializeMs} ms CPU; sensitivity: vertical ${big}-core contention ` +
    `${P.contentionSweep.map((c) => c * 100 + '%').join('/')}; matched: both use the async store, no contention, no hops; ` +
    `ramp: Poisson, x${P.coarseFactor} then x${P.fineFactor} steps of ${P.stepSeconds}s, observe ${P.warmupSeconds}-${P.stepSeconds}s, ` +
    `stable = no errors, cohort p95 <= ${P.p95LimitMs} ms (unfinished counts as over), backlog growth <= max(size, ${P.backlogSlack * 100}% of arrivals); ` +
    `kill test ${P.fail.seconds}s at ${P.fail.loadShare * 100}% of the weaker ${big}-core sustained rate, kill at ${P.fail.killAtMs / 1000}s, ` +
    `restart ${P.fail.restartMs / 1000}s, health check ${P.fail.healthEveryMs} ms x${P.fail.healthFailsToEject}, no retries; ` +
    `wall-clock deadline ${P.deadlineMs / 1000}s`;
}

try {
  main();
} catch (err) {
  if (!(err instanceof DeadlineError)) throw err;
  console.log(`stopped: wall time passed the ${P.deadlineMs / 1000}s deadline before the run finished`);
  console.log('RESULT ' + JSON.stringify({
    metrics: [
      { name: 'run_completed', value: 0, unit: 'flag' },
      { name: 'deadline', value: P.deadlineMs / 1000, unit: 's' },
    ],
    conclusion: `The run hit its ${P.deadlineMs / 1000}-second wall-clock deadline before finishing, so it reports no comparison.`,
    setup: setupText(Math.max(...P.sizes)),
  }));
}
