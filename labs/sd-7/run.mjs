// sd-7 lab: "The cable to Asia breaks. Your bank must choose."
// CAP theorem, CP vs AP, measured on a simulated two-replica bank account.
// Node.js 22 ESM, standard library only. Simulated clock, so the run is instant and repeatable.

const CONFIG = {
  seed: 7,
  durationS: 60,          // simulated seconds of traffic
  cutStartS: 20,          // the cable breaks here
  cutEndS: 40,            // and is repaired here
  ratePerS: 20,           // requests per simulated second, split across both sides
  initialBalance: 1000,
  mix: { read: 0.5, deposit: 0.25, withdraw: 0.25 },
  amountMin: 5,
  amountMax: 25,
  // One scripted moment inside the cut: a customer in Europe and a customer in Asia
  // (same shared account) each ask for the same fixed amount at the same second.
  bigWithdrawAtS: 30,
  bigWithdrawAmount: 700,
};

const SIDES = ['Europe', 'Asia'];
const OTHER = { Europe: 'Asia', Asia: 'Europe' };

// ---------- seeded random (mulberry32) ----------
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- one fixed workload, reused by every mode ----------
// Every amount is decided here, before any mode runs, so all modes see identical requests.
function buildWorkload(cfg) {
  const rng = makeRng(cfg.seed);
  const reqs = [];
  let t = 0;
  let id = 0;
  while (true) {
    t += -Math.log(1 - rng()) / cfg.ratePerS;
    if (t >= cfg.durationS) break;
    const side = rng() < 0.5 ? 'Europe' : 'Asia';
    const r = rng();
    const type = r < cfg.mix.read ? 'read' : r < cfg.mix.read + cfg.mix.deposit ? 'deposit' : 'withdraw';
    const amount = type === 'read' ? 0 : cfg.amountMin + Math.floor(rng() * (cfg.amountMax - cfg.amountMin + 1));
    reqs.push({ id: id++, t, side, type, amount });
  }
  for (const side of SIDES) {
    reqs.push({ id: id++, t: cfg.bigWithdrawAtS, side, type: 'withdraw', amount: cfg.bigWithdrawAmount, scripted: true });
  }
  reqs.sort((x, y) => x.t - y.t || x.id - y.id);
  return reqs;
}

const phaseOf = (t, cfg) => (t < cfg.cutStartS ? 'before' : t < cfg.cutEndS ? 'during' : 'after');

// ---------- independent serial reference bank ----------
// One copy, no cut, every request in time order, its own accept/refuse decisions.
// Returns the set of withdrawal ids it accepted.
function serialReference(reqs, cfg) {
  let balance = cfg.initialBalance;
  const acceptedWithdrawals = new Set();
  for (const q of reqs) {
    if (q.type === 'deposit') balance += q.amount;
    else if (q.type === 'withdraw' && balance >= q.amount) {
      balance -= q.amount;
      acceptedWithdrawals.add(q.id);
    }
  }
  return { acceptedWithdrawals, finalBalance: balance };
}

// ---------- the simulation ----------
// Each replica holds only its own state: a balance, the time of its last write, and its own
// log of accepted operations. While the link is up, every accepted operation is copied to the
// other replica at once. During the cut, nothing crosses.
//
// The "ledger" below is a measurement oracle only: it records every operation any replica
// accepted, in time order. No replica ever reads it, and no repair step uses it.
//
// Modes:
//   CP        A witness vote sits in Europe, so Europe has the majority (2 of 3) and keeps
//             serving. Asia refuses every request during the cut. Repair: Asia copies the
//             operations it is missing from Europe's log and replays them.
//   AP-merge  Both sides serve from their own copy. Repair: the two replica logs are unioned
//             by operation id, sorted by timestamp, and replayed from the start balance.
//   AP-LWW    Both sides serve from their own copy. Repair: the replica whose last write is
//             later wins, and the other replica's balance is overwritten with it.
function simulate(mode, reqs, cfg, reference) {
  const replicas = {};
  for (const s of SIDES) replicas[s] = { balance: cfg.initialBalance, lastWriteT: -1, log: [] };

  let ledger = cfg.initialBalance; // oracle only
  let lowestLedger = ledger;
  let repair = null;

  const blank = () => ({
    total: 0, served: 0, refused: 0, staleReads: 0,
    declinedForFunds: 0, overdrawnLedgerWithdrawals: 0, refusedByReference: 0,
  });
  const phases = { before: blank(), during: blank(), after: blank() };

  const replay = (ops) => {
    let b = cfg.initialBalance;
    let low = b;
    for (const op of ops) {
      b += op.delta;
      if (b < low) low = b;
    }
    return { balance: b, low };
  };

  const doRepair = () => {
    const cutOps = { Europe: 0, Asia: 0 };
    for (const s of SIDES) {
      cutOps[s] = replicas[s].log.filter((op) => op.origin === s && op.t >= cfg.cutStartS && op.t < cfg.cutEndS).length;
    }
    const shownAtRepair = { Europe: replicas.Europe.balance, Asia: replicas.Asia.balance };
    const info = { shownAtRepair, cutOps, lostWrites: 0, lowestReplayed: null, winner: null };

    if (mode === 'CP' || mode === 'AP-merge') {
      const byId = new Map();
      for (const s of SIDES) for (const op of replicas[s].log) byId.set(op.id, op);
      const merged = [...byId.values()].sort((x, y) => x.t - y.t || x.id - y.id);
      const { balance, low } = replay(merged);
      info.lowestReplayed = low;
      for (const s of SIDES) {
        replicas[s].log = merged.slice();
        replicas[s].balance = balance;
        replicas[s].lastWriteT = merged.length ? merged[merged.length - 1].t : -1;
      }
    } else {
      const winner = replicas.Europe.lastWriteT >= replicas.Asia.lastWriteT ? 'Europe' : 'Asia';
      const loser = OTHER[winner];
      info.winner = winner;
      info.lostWrites = cutOps[loser];
      replicas[loser].balance = replicas[winner].balance;
      replicas[loser].lastWriteT = replicas[winner].lastWriteT;
      replicas[loser].log = replicas[winner].log.slice();
    }
    info.balanceAfterRepair = replicas.Europe.balance;
    info.ledgerAtRepair = ledger;
    info.errorVsLedger = replicas.Europe.balance - ledger;
    repair = info;
  };

  for (const q of reqs) {
    if (!repair && q.t >= cfg.cutEndS) doRepair();
    const phase = phaseOf(q.t, cfg);
    const linkUp = phase !== 'during';
    const s = phases[phase];
    s.total++;

    if (mode === 'CP' && !linkUp && q.side === 'Asia') {
      s.refused++;
      continue;
    }
    s.served++;

    const here = replicas[q.side];
    if (q.type === 'read') {
      if (here.balance !== ledger) s.staleReads++;
      continue;
    }
    const delta = q.type === 'deposit' ? q.amount : -q.amount;
    if (q.type === 'withdraw') {
      if (here.balance < q.amount) {
        s.declinedForFunds++;
        continue;
      }
      if (ledger < q.amount) s.overdrawnLedgerWithdrawals++;
      if (!reference.acceptedWithdrawals.has(q.id)) s.refusedByReference++;
    }
    const op = { id: q.id, t: q.t, origin: q.side, delta };
    const targets = linkUp ? SIDES : [q.side];
    for (const side of targets) {
      replicas[side].balance += delta;
      replicas[side].lastWriteT = q.t;
      replicas[side].log.push(op);
    }
    ledger += delta;
    if (ledger < lowestLedger) lowestLedger = ledger;
  }
  if (!repair) doRepair();

  const requestedWithdrawTotal = reqs.filter((q) => q.type === 'withdraw').reduce((a, q) => a + q.amount, 0);
  return {
    mode, phases, repair, lowestLedger,
    finalLedger: ledger,
    finalReplica: { Europe: replicas.Europe.balance, Asia: replicas.Asia.balance },
    requestedWithdrawTotal,
  };
}

// ---------- run every mode on the same workload ----------
const reqs = buildWorkload(CONFIG);
const reference = serialReference(reqs, CONFIG);
const runs = ['CP', 'AP-merge', 'AP-LWW'].map((m) => simulate(m, reqs, CONFIG, reference));
const [cp, apm, apl] = runs;

const pct = (n, d) => (d === 0 ? 0 : Math.round((1000 * n) / d) / 10);

console.log(`serial reference bank (one copy, no cut): final balance ${reference.finalBalance}`);
for (const r of runs) {
  console.log(`\n=== ${r.mode} === (requested withdrawals total ${r.requestedWithdrawTotal}, same for every mode)`);
  for (const [name, p] of Object.entries(r.phases)) {
    console.log(
      `${name.padEnd(6)} total=${p.total} served=${p.served} refused=${p.refused} staleReads=${p.staleReads} ` +
        `declinedForFunds=${p.declinedForFunds} overdrawnLedgerWithdrawals=${p.overdrawnLedgerWithdrawals} ` +
        `refusedByReference=${p.refusedByReference}`,
    );
  }
  const rp = r.repair;
  console.log(
    `at repair: Europe showed ${rp.shownAtRepair.Europe}, Asia showed ${rp.shownAtRepair.Asia}, ` +
      `cut writes Europe=${rp.cutOps.Europe} Asia=${rp.cutOps.Asia}` +
      (rp.winner ? `, LWW kept ${rp.winner} and dropped ${rp.lostWrites} writes` : `, replayed log low point ${rp.lowestReplayed}`) +
      `; balance after repair ${rp.balanceAfterRepair} vs ledger ${rp.ledgerAtRepair} (off by ${rp.errorVsLedger})`,
  );
  console.log(
    `lowest ledger balance=${r.lowestLedger}; end: ledger=${r.finalLedger}, ` +
      `Europe=${r.finalReplica.Europe}, Asia=${r.finalReplica.Asia}`,
  );
}

const cpD = cp.phases.during;
const apD = apm.phases.during;
const cutS = CONFIG.cutEndS - CONFIG.cutStartS;

const metrics = [
  { name: 'Requests during the cut (same stream and amounts, every mode)', value: cpD.total, unit: 'requests' },
  { name: 'CP refused during the cut', value: pct(cpD.refused, cpD.total), unit: '%' },
  { name: 'CP stale reads during the cut', value: cpD.staleReads, unit: 'reads' },
  { name: 'CP lowest balance in the accepted-operation ledger', value: cp.lowestLedger, unit: 'money units' },
  { name: 'AP served during the cut', value: pct(apD.served, apD.total), unit: '%' },
  { name: 'AP stale reads during the cut', value: apD.staleReads, unit: 'reads' },
  { name: 'AP withdrawals accepted while the accepted-operation ledger lacked funds', value: apD.overdrawnLedgerWithdrawals, unit: 'withdrawals' },
  { name: 'AP withdrawals accepted that the serial reference bank refused', value: apD.refusedByReference, unit: 'withdrawals' },
  { name: 'AP lowest balance in the accepted-operation ledger', value: apm.lowestLedger, unit: 'money units' },
  { name: 'AP-merge balance error after repair', value: apm.repair.errorVsLedger, unit: 'money units' },
  { name: 'AP-LWW writes dropped at repair', value: apl.repair.lostWrites, unit: 'writes' },
  { name: 'AP-LWW balance error after repair', value: apl.repair.errorVsLedger, unit: 'money units' },
  { name: 'AP-LWW reads after repair that differ from the ledger', value: apl.phases.after.staleReads, unit: 'reads' },
];

const conclusion =
  `During the ${cutS}s cut, CP refused ${pct(cpD.refused, cpD.total)}% of requests with ${cpD.staleReads} stale reads, ` +
  `while AP answered ${pct(apD.served, apD.total)}% but gave ${apD.staleReads} stale reads and accepted ` +
  `${apD.refusedByReference} withdrawals a serial bank refused (ledger low ${apm.lowestLedger}); ` +
  `merging logs at repair left a balance error of ${apm.repair.errorVsLedger}, ` +
  `while last-writer-wins dropped ${apl.repair.lostWrites} writes and left it off by ${apl.repair.errorVsLedger}.`;

const setup =
  `simulated 2-replica account (Europe, Asia), seed ${CONFIG.seed}, ${CONFIG.durationS}s at ${CONFIG.ratePerS} req/s, ` +
  `cut ${CONFIG.cutStartS}s to ${CONFIG.cutEndS}s, start balance ${CONFIG.initialBalance}, ` +
  `mix read/deposit/withdraw ${CONFIG.mix.read}/${CONFIG.mix.deposit}/${CONFIG.mix.withdraw}, amounts ${CONFIG.amountMin} to ${CONFIG.amountMax} precomputed, ` +
  `one scripted withdrawal of ${CONFIG.bigWithdrawAmount} on each side at ${CONFIG.bigWithdrawAtS}s, ` +
  `CP majority (with witness) in Europe, AP repaired two ways: per-replica log merge, and last-writer-wins on balance`;

console.log('RESULT ' + JSON.stringify({ metrics, conclusion, setup }));
