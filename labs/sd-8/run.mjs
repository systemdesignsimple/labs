// sd-8 lab: weak vs eventual vs strong (quorum) consistency on a 3-replica setup.
// Node.js 22 ESM, standard library only. Discrete-event simulation on a virtual
// clock (no real timers), fixed seeds, so every run prints the same numbers.

const CFG = {
  seed: 42,
  clientOneWayMs: [0.5, 1.5], // client <-> any replica, one way
  ackOneWayMs: [0.5, 1.5], // follower -> leader "I applied it" ack
  replLagMs: [0, 200], // leader apply -> follower apply, uniform
  dropRate: 0.02, // share of replication messages lost
  retryMs: 100, // eventual/strong resend a lost message after this timeout
  likes: { durationMs: 20000, writesPerSec: 20, readsPerSec: 200 },
  balance: { trials: 300, startBalance: 300, amount: 100, attempts: 6, meanGapMs: 60 },
};
const MODES = ['weak', 'eventual', 'strong'];
const CHECKS = ['client', 'leader'];

// ---------- helpers ----------
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const uni = (r, [lo, hi]) => lo + (hi - lo) * r();
const expo = (r, mean) => -Math.log(1 - r()) * mean;
function q(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}
const r1 = (x) => Math.round(x * 10) / 10;

// ---------- tiny event loop ----------
class Sim {
  constructor() {
    this.now = 0;
    this.h = [];
    this.n = 0;
  }
  static less(a, b) {
    return a.t < b.t || (a.t === b.t && a.s < b.s);
  }
  at(t, fn) {
    const h = this.h;
    h.push({ t, s: this.n++, fn });
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (Sim.less(h[p], h[i])) break;
      [h[p], h[i]] = [h[i], h[p]];
      i = p;
    }
  }
  pop() {
    const h = this.h;
    const top = h[0];
    const last = h.pop();
    if (h.length) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && Sim.less(h[l], h[m])) m = l;
        if (r < h.length && Sim.less(h[r], h[m])) m = r;
        if (m === i) break;
        [h[m], h[i]] = [h[i], h[m]];
        i = m;
      }
    }
    return top;
  }
  run() {
    while (this.h.length) {
      const e = this.pop();
      this.now = e.t;
      e.fn();
    }
  }
}

// ---------- 3-replica cluster: replica 0 is the leader ----------
// weak:     follower updates are fire-and-forget; a lost message is never resent.
// eventual: lost messages are resent until delivered; followers converge.
// strong:   same reliable delivery, applied in order (FIFO), write acked only when
//           W=2 replicas have it, reads ask R=2 replicas and keep the newest version.
//           This gives freshness against writes acked before the read started. It is
//           NOT full linearizability: a read can see a not-yet-acked write on the
//           leader, and a later read that misses the leader can return an older value.
function makeCluster(sim, mode, net, initial) {
  const reps = [0, 1, 2].map((id) => ({ id, value: initial, version: 0, lastDeliver: 0 }));
  const leader = reps[0];
  const stats = { lags: [], dropped: 0, lastLeaderApply: 0, lastFollowerApply: 0 };
  let seq = 0;

  function leaderApply(delta, onQuorum) {
    leader.value += delta;
    const k = ++seq;
    leader.version = k;
    const t0 = sim.now;
    stats.lastLeaderApply = t0;
    let acks = 1;
    let done = false;
    for (const f of reps.slice(1)) {
      let send = t0;
      if (mode === 'weak') {
        if (net() < CFG.dropRate) {
          stats.dropped++;
          continue;
        }
      } else {
        while (net() < CFG.dropRate) send += CFG.retryMs;
      }
      let arrive = send + uni(net, CFG.replLagMs);
      if (mode === 'strong') {
        arrive = Math.max(arrive, f.lastDeliver);
        f.lastDeliver = arrive;
      }
      sim.at(arrive, () => {
        f.value += delta;
        f.version = Math.max(f.version, k);
        stats.lags.push(sim.now - t0);
        stats.lastFollowerApply = Math.max(stats.lastFollowerApply, sim.now);
        if (onQuorum) {
          sim.at(sim.now + uni(net, CFG.ackOneWayMs), () => {
            acks++;
            if (!done && acks >= 2) {
              done = true;
              onQuorum(k);
            }
          });
        }
      });
    }
    return k;
  }

  // Client issues a read to the given replicas now; cb(value, latencyMs) when all answer.
  // Each replica answers from its current state at once. A read never waits for
  // replication, so in this protocol the waiting is paid on the write ack (W=2); the
  // only extra read cost is waiting for the slower of two round trips.
  function read(ids, cb) {
    const t0 = sim.now;
    let pending = ids.length;
    let best = null;
    for (const id of ids) {
      const there = uni(net, CFG.clientOneWayMs);
      const back = uni(net, CFG.clientOneWayMs);
      sim.at(t0 + there, () => {
        const snap = { value: reps[id].value, version: reps[id].version };
        sim.at(sim.now + back, () => {
          if (!best || snap.version > best.version) best = snap;
          if (--pending === 0) cb(best.value, sim.now - t0);
        });
      });
    }
  }

  return { reps, leader, stats, leaderApply, read };
}

function pickReplicas(work) {
  const a = Math.floor(work() * 3);
  const b = (a + 1 + Math.floor(work() * 2)) % 3;
  return [a, b];
}

// ---------- run 1: like counter ----------
function likesRun(mode, mi) {
  const L = CFG.likes;
  const sim = new Sim();
  const work = mulberry32(CFG.seed); // same workload for every mode
  const net = mulberry32(CFG.seed * 1000 + mi);
  const cl = makeCluster(sim, mode, net, 0);
  let ackedMax = 0;
  const writeLat = [];
  const readLat = [];
  const behind = [];
  const readLog = []; // { start, end, value } for the "did a later read go back?" check

  let t = 0;
  while ((t += expo(work, 1000 / L.writesPerSec)) < L.durationMs) {
    const t0 = t;
    sim.at(t0, () => {
      sim.at(sim.now + uni(net, CFG.clientOneWayMs), () => {
        const ack = (k) =>
          sim.at(sim.now + uni(net, CFG.clientOneWayMs), () => {
            ackedMax = Math.max(ackedMax, k);
            writeLat.push(sim.now - t0);
          });
        if (mode === 'strong') cl.leaderApply(1, ack);
        else ack(cl.leaderApply(1));
      });
    });
  }

  t = 0;
  while ((t += expo(work, 1000 / L.readsPerSec)) < L.durationMs) {
    const [a, b] = pickReplicas(work);
    sim.at(t, () => {
      const mustSee = ackedMax; // every write acked to a client before this read started
      const start = sim.now;
      cl.read(mode === 'strong' ? [a, b] : [a], (v, lat) => {
        readLat.push(lat);
        behind.push(Math.max(0, mustSee - v));
        readLog.push({ start, end: sim.now, value: v });
      });
    });
  }
  sim.run();

  const stale = behind.filter((x) => x > 0);
  const followers = cl.reps.slice(1);
  const converged = followers.every((f) => f.value === cl.leader.value);

  // Read ordering: a read "went back" if it returned fewer likes than some read that
  // had already finished before this one started. Freshness against acked writes does
  // not rule this out; linearizability would.
  const byEnd = [...readLog].sort((x, y) => x.end - y.end);
  const byStart = [...readLog].sort((x, y) => x.start - y.start);
  let j = 0;
  let seenMax = -Infinity;
  let wentBack = 0;
  for (const r of byStart) {
    while (j < byEnd.length && byEnd[j].end < r.start) seenMax = Math.max(seenMax, byEnd[j++].value);
    if (r.value < seenMax) wentBack++;
  }

  return {
    reads: behind.length,
    stalePct: (100 * stale.length) / behind.length,
    behindMedianWhenStale: q(stale, 0.5),
    behindMax: Math.max(0, ...behind),
    wentBackPct: (100 * wentBack) / readLog.length,
    readP50: q(readLat, 0.5),
    readP99: q(readLat, 0.99),
    writeP50: q(writeLat, 0.5),
    writeP99: q(writeLat, 0.99),
    lagP50: q(cl.stats.lags, 0.5),
    lagP99: q(cl.stats.lags, 0.99),
    // Time from the last leader write to the last follower update. It only counts as
    // "converged" when every follower ended equal to the leader.
    lastFollowerUpdateMs: cl.stats.lastFollowerApply - cl.stats.lastLeaderApply,
    converged,
    convergeMs: converged ? cl.stats.lastFollowerApply - cl.stats.lastLeaderApply : null,
    lostIncrements: Math.max(...followers.map((f) => cl.leader.value - f.value)),
    finalLikes: cl.leader.value,
  };
}

// ---------- run 2: balance with "withdraw only if balance >= amount" ----------
// Two separate experiments, each run in all three modes with identical semantics:
//   check 'client': the client reads the balance (R per mode), checks it, then sends a
//                   plain "minus 100".
//   check 'leader': same read and client check, then the leader re-checks the rule in
//                   one serial place and applies it atomically (atomic conditional
//                   withdrawal).
// Writes are acked per mode (weak/eventual: when the leader has it; strong: W=2).
function balanceRun(mode, mi, check) {
  const B = CFG.balance;
  const work = mulberry32(CFG.seed + 7); // same workload for every mode and check
  const net = mulberry32(CFG.seed * 2000 + mi); // same network per mode for both checks
  let approved = 0;
  let overdrafts = 0;
  let leaderRejects = 0;
  let declined = 0;
  let moneyMissing = 0;
  const latApproved = [];

  for (let trial = 0; trial < B.trials; trial++) {
    const sim = new Sim();
    const cl = makeCluster(sim, mode, net, B.startBalance);
    let t = 0;
    for (let i = 0; i < B.attempts; i++) {
      t += expo(work, B.meanGapMs);
      const [a, b] = pickReplicas(work);
      sim.at(t, () => {
        const t0 = sim.now;
        cl.read(mode === 'strong' ? [a, b] : [a], (seen) => {
          if (seen < B.amount) {
            declined++;
            return;
          }
          sim.at(sim.now + uni(net, CFG.clientOneWayMs), () => {
            const finish = () =>
              sim.at(sim.now + uni(net, CFG.clientOneWayMs), () => latApproved.push(sim.now - t0));
            if (check === 'leader' && cl.leader.value < B.amount) {
              leaderRejects++;
              return;
            }
            if (mode === 'strong') cl.leaderApply(-B.amount, finish);
            else {
              cl.leaderApply(-B.amount);
              finish();
            }
            approved++;
            if (cl.leader.value < 0) overdrafts++;
          });
        });
      });
    }
    sim.run();
    moneyMissing += Math.max(0, -cl.leader.value);
  }
  return {
    approved,
    overdrafts,
    leaderRejects,
    declined,
    moneyMissing,
    withdrawP50: q(latApproved, 0.5),
    withdrawP99: q(latApproved, 0.99),
  };
}

// ---------- run everything ----------
const likes = {};
const bal = { client: {}, leader: {} };
MODES.forEach((m, i) => {
  likes[m] = likesRun(m, i);
  for (const c of CHECKS) bal[c][m] = balanceRun(m, i, c);
});

const convTxt = (x) => (x.converged ? `${r1(x.convergeMs)} ms` : 'never (followers still differ)');
console.log('Like counter (' + likes.weak.reads + ' reads per mode, ' + likes.weak.finalLikes + ' likes written)');
for (const m of MODES) {
  const x = likes[m];
  console.log(
    `  ${m.padEnd(8)} stale ${r1(x.stalePct)}%  behind(median when stale) ${x.behindMedianWhenStale}  ` +
      `went back ${r1(x.wentBackPct)}%  read p50/p99 ${r1(x.readP50)}/${r1(x.readP99)} ms  ` +
      `write p50/p99 ${r1(x.writeP50)}/${r1(x.writeP99)} ms  lost on a follower ${x.lostIncrements}  ` +
      `converged ${convTxt(x)}  last follower update ${r1(x.lastFollowerUpdateMs)} ms after last write`
  );
}
for (const c of CHECKS) {
  const label = c === 'client' ? 'client-side check, then plain decrement' : 'atomic check at the leader';
  console.log(
    `Balance, ${label} (${CFG.balance.trials} accounts x ${CFG.balance.attempts} withdrawals of ` +
      `${CFG.balance.amount} from ${CFG.balance.startBalance})`
  );
  for (const m of MODES) {
    const x = bal[c][m];
    console.log(
      `  ${m.padEnd(8)} approved ${x.approved}  overdrafts ${x.overdrafts}  missing money ${x.moneyMissing}  ` +
        `stopped at leader ${x.leaderRejects}  withdraw p50/p99 ${r1(x.withdrawP50)}/${r1(x.withdrawP99)} ms`
    );
  }
}

const metrics = [
  { name: 'weak_stale_reads', value: r1(likes.weak.stalePct), unit: '%' },
  { name: 'eventual_stale_reads', value: r1(likes.eventual.stalePct), unit: '%' },
  { name: 'strong_stale_reads_vs_acked_writes', value: r1(likes.strong.stalePct), unit: '%' },
  { name: 'strong_reads_went_back', value: r1(likes.strong.wentBackPct), unit: '%' },
  { name: 'eventual_behind_median_when_stale', value: likes.eventual.behindMedianWhenStale, unit: 'likes' },
  { name: 'weak_likes_lost_on_a_follower', value: likes.weak.lostIncrements, unit: 'likes' },
  { name: 'eventual_likes_lost_on_a_follower', value: likes.eventual.lostIncrements, unit: 'likes' },
  { name: 'weak_last_follower_update_after_last_write', value: r1(likes.weak.lastFollowerUpdateMs), unit: 'ms' },
];
for (const m of ['weak', 'eventual']) {
  // Only report a convergence time when the followers really ended equal to the leader.
  if (likes[m].converged) {
    metrics.push({ name: `${m}_converge_after_last_write`, value: r1(likes[m].convergeMs), unit: 'ms' });
  }
}
metrics.push(
  { name: 'eventual_replica_lag_p99', value: r1(likes.eventual.lagP99), unit: 'ms' },
  { name: 'eventual_read_p50', value: r1(likes.eventual.readP50), unit: 'ms' },
  { name: 'strong_read_p50', value: r1(likes.strong.readP50), unit: 'ms' },
  { name: 'strong_read_p99', value: r1(likes.strong.readP99), unit: 'ms' },
  { name: 'eventual_write_p50', value: r1(likes.eventual.writeP50), unit: 'ms' },
  { name: 'strong_write_p50', value: r1(likes.strong.writeP50), unit: 'ms' },
  { name: 'strong_write_p99', value: r1(likes.strong.writeP99), unit: 'ms' }
);
for (const c of CHECKS) {
  for (const m of MODES) {
    metrics.push({ name: `${m}_overdrafts_${c}_check`, value: bal[c][m].overdrafts, unit: 'withdrawals' });
  }
}
metrics.push(
  { name: 'strong_stopped_at_leader_leader_check', value: bal.leader.strong.leaderRejects, unit: 'withdrawals' },
  { name: 'eventual_withdraw_p50_leader_check', value: r1(bal.leader.eventual.withdrawP50), unit: 'ms' },
  { name: 'strong_withdraw_p50_leader_check', value: r1(bal.leader.strong.withdrawP50), unit: 'ms' }
);

// Built only from the computed numbers, so it states whatever the run produced.
const od = (c) => MODES.map((m) => `${m} ${bal[c][m].overdrafts}`).join(', ');
const conclusion =
  `In this lab, eventual reads came back in ${r1(likes.eventual.readP50)} ms but were stale ` +
  `${r1(likes.eventual.stalePct)}% of the time (median ${likes.eventual.behindMedianWhenStale} likes behind), ` +
  `quorum reads missed an already-acked write ${r1(likes.strong.stalePct)}% of the time with ` +
  `${r1(likes.strong.readP50)} ms reads but ${r1(likes.strong.writeP50)} ms writes instead of ` +
  `${r1(likes.eventual.writeP50)} ms, and balance overdrafts were ${od('client')} with a client-side check ` +
  `versus ${od('leader')} with an atomic check at the leader.`;

const setup = JSON.stringify({
  replicas: '3 (replica 0 = leader, 1 and 2 = followers), virtual clock, leader never fails',
  ...CFG,
  derivedSeeds: {
    likesWorkload: CFG.seed,
    likesNetwork: Object.fromEntries(MODES.map((m, i) => [m, CFG.seed * 1000 + i])),
    balanceWorkload: CFG.seed + 7,
    balanceNetwork: Object.fromEntries(MODES.map((m, i) => [m, CFG.seed * 2000 + i])),
  },
  modes: {
    weak: 'write acked when the leader applies it; read 1 random replica; lost replication message never resent; any-order apply',
    eventual: `write acked when the leader applies it; read 1 random replica; lost message resent every ${CFG.retryMs} ms; any-order apply`,
    strong: `write acked after W=2 (leader + first follower ack, follower ack one-way ${CFG.ackOneWayMs.join('-')} ms); read R=2 replicas, newest version wins, answered at once without waiting for replication; lost message resent every ${CFG.retryMs} ms; followers apply in order`,
  },
  balanceChecks: {
    client: 'all modes: read, client checks balance >= amount, then sends a plain decrement',
    leader: 'all modes: same read and client check, then the leader re-checks balance >= amount and applies atomically',
  },
  staleDefinition: 'read returns fewer likes than the writes acked to clients before the read started',
  wentBackDefinition: 'read returns fewer likes than some read that finished before it started',
});

console.log('RESULT ' + JSON.stringify({ metrics, conclusion, setup }));
