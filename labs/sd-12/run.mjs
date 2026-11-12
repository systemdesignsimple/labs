// sd-12 lab: "One database writes, ten read"
// Replication simulated in-process on a virtual clock (discrete-event simulation).
// Node.js 22 ESM, standard library only. No network, no files, no child processes.
// Every run uses a fixed seed, so the numbers repeat exactly.

const CFG = {
  seed: 12,
  readMs: 2, // fixed service time of one read on any node
  writeMs: 0.5, // fixed service time of one write on a primary
  shipMsPerReplica: 0.01, // extra primary time per write per replica, to send the change
  replicaCounts: [0, 1, 3, 10],
  // Part 1: saturate the system with busy clients (no think time), 90/10 read/write
  capacity: { clients: 200, warmupMs: 1000, measureMs: 10000, readShare: 0.9 },
  // Part 1b: write-only clients, to find the write ceiling
  writeCeiling: { clients: 100, warmupMs: 500, measureMs: 5000, readShare: 0 },
  // Part 2: light traffic; each user writes, then reads the same row back a moment later
  stale: { lagsMs: [50, 500], sessionsPerSec: 200, durationMs: 20000, gapMinMs: 20, gapMaxMs: 1000, lagJitter: 0.1 },
  // Part 3: two primaries both accepting writes to the same 100 keys, last-write-wins
  mm: { lagsMs: [50, 500], keys: 100, writesPerSec: 400, durationMs: 10000 },
};

// ---------- seeded random numbers ----------
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let runCounter = 0;
const nextRng = () => mulberry32(CFG.seed * 1000 + runCounter++);
const expGap = (rng, perSec) => (-Math.log(1 - rng()) * 1000) / perSec;

// ---------- discrete-event simulator (virtual milliseconds) ----------
const less = (a, b) => a.t < b.t || (a.t === b.t && a.s < b.s);
class Sim {
  constructor() {
    this.t = 0;
    this.h = [];
    this.n = 0;
  }
  at(t, fn) {
    const e = { t, s: this.n++, fn };
    const h = this.h;
    h.push(e);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (less(h[p], e)) break;
      h[i] = h[p];
      i = p;
    }
    h[i] = e;
  }
  after(d, fn) {
    this.at(this.t + d, fn);
  }
  pop() {
    const h = this.h;
    const top = h[0];
    const last = h.pop();
    if (h.length > 0) {
      const n = h.length;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && less(h[r], h[l]) ? r : l;
        if (less(last, h[c])) break;
        h[i] = h[c];
        i = c;
      }
      h[i] = last;
    }
    return top;
  }
  run(until = Infinity) {
    while (this.h.length && this.h[0].t <= until) {
      const e = this.pop();
      this.t = e.t;
      e.fn();
    }
  }
}

// A database node: one worker, FIFO queue, fixed service time per job.
class Node {
  constructor(sim, name) {
    this.sim = sim;
    this.name = name;
    this.q = [];
    this.qi = 0;
    this.busy = false;
    this.data = new Map();
  }
  submit(serviceMs, onStart, onDone) {
    this.q.push({ serviceMs, onStart, onDone });
    if (!this.busy) this._next();
  }
  _next() {
    if (this.qi >= this.q.length) {
      this.q = [];
      this.qi = 0;
      this.busy = false;
      return;
    }
    if (this.qi > 4096) {
      this.q = this.q.slice(this.qi);
      this.qi = 0;
    }
    const job = this.q[this.qi++];
    this.busy = true;
    const started = job.onStart ? job.onStart() : undefined;
    this.sim.after(job.serviceMs, () => {
      if (job.onDone) job.onDone(started);
      this._next();
    });
  }
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = Float64Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}
const r1 = (x) => Math.round(x * 10) / 10;
const r0 = (x) => Math.round(x);

// ---------- Part 1: capacity (closed loop, busy clients) ----------
// Writes go to the primary. Reads go round-robin to replicas; with 0 replicas the primary serves reads too.
function capacityRun(R, opts) {
  const rng = nextRng();
  const { clients, warmupMs, measureMs, readShare } = opts;
  const sim = new Sim();
  const primary = new Node(sim, "primary");
  const replicas = Array.from({ length: R }, (_, i) => new Node(sim, "replica" + i));
  const end = warmupMs + measureMs;
  const inWindow = (t) => t >= warmupMs && t < end;
  let rr = 0;
  let reads = 0;
  let writes = 0;
  const lat = [];
  function issue() {
    const t0 = sim.t;
    if (rng() < readShare) {
      const node = R > 0 ? replicas[rr++ % R] : primary;
      node.submit(CFG.readMs, null, () => {
        if (inWindow(sim.t)) {
          reads++;
          lat.push(sim.t - t0);
        }
        issue();
      });
    } else {
      primary.submit(CFG.writeMs + R * CFG.shipMsPerReplica, null, () => {
        if (inWindow(sim.t)) writes++;
        issue();
      });
    }
  }
  for (let c = 0; c < clients; c++) issue();
  sim.run(end);
  const secs = measureMs / 1000;
  return { readsPerSec: reads / secs, writesPerSec: writes / secs, p95ReadMs: pct(lat, 0.95) };
}

// ---------- Part 2: stale read-your-write ----------
// Each user writes a new row on the primary, waits a short random gap, then reads it back from a replica.
// Stale = the replica does not have the row yet when it serves the read.
function staleRun(R, lagMs) {
  const rng = nextRng();
  const { sessionsPerSec, durationMs, gapMinMs, gapMaxMs, lagJitter } = CFG.stale;
  const sim = new Sim();
  const primary = new Node(sim, "primary");
  const replicas = Array.from({ length: R }, (_, i) => new Node(sim, "replica" + i));
  const lastArrive = new Array(R).fill(0); // replication stays in order per replica
  let key = 0;
  let rr = 0;
  let probes = 0;
  let stale = 0;
  function session() {
    const k = key++;
    primary.submit(CFG.writeMs + R * CFG.shipMsPerReplica, null, () => {
      primary.data.set(k, 1); // committed and acknowledged now
      for (let i = 0; i < R; i++) {
        const delay = lagMs * (1 - lagJitter + 2 * lagJitter * rng());
        const arrive = Math.max(lastArrive[i], sim.t + delay);
        lastArrive[i] = arrive;
        const rep = replicas[i];
        sim.at(arrive, () => rep.data.set(k, 1));
      }
      const gap = gapMinMs + (gapMaxMs - gapMinMs) * rng();
      sim.after(gap, () => {
        const node = R > 0 ? replicas[rr++ % R] : primary;
        node.submit(
          CFG.readMs,
          () => node.data.has(k),
          (found) => {
            probes++;
            if (!found) stale++;
          },
        );
      });
    });
  }
  function arrivals() {
    if (sim.t >= durationMs) return;
    session();
    sim.after(expGap(rng, sessionsPerSec), arrivals);
  }
  sim.at(0, arrivals);
  sim.run();
  return { probes, staleRate: probes ? stale / probes : 0 };
}

// ---------- Part 3: master-master with last-write-wins ----------
// Each write remembers which version it was built on (its parent).
// After the run, follow the parent chain back from each key's final value.
// Acknowledged writes that are not on that chain were silently overwritten: lost.
function masterMasterRun(lagMs) {
  const rng = nextRng();
  const { keys, writesPerSec, durationMs } = CFG.mm;
  const sim = new Sim();
  const nodes = [new Node(sim, "A"), new Node(sim, "B")];
  const all = [];
  let nextId = 1;
  const newer = (a, b) => !b || a.ts > b.ts || (a.ts === b.ts && a.id > b.id);
  function write() {
    const ni = rng() < 0.5 ? 0 : 1;
    const node = nodes[ni];
    const other = nodes[1 - ni];
    const k = Math.floor(rng() * keys);
    node.submit(CFG.writeMs + CFG.shipMsPerReplica, null, () => {
      const cur = node.data.get(k);
      const w = { id: nextId++, key: k, ts: sim.t, parent: cur ? cur.id : 0 };
      node.data.set(k, w); // a local write is always the newest this node has seen
      all.push(w);
      sim.after(lagMs, () => {
        const c = other.data.get(k);
        if (newer(w, c)) other.data.set(k, w); // last-write-wins; an older incoming write is ignored
      });
    });
  }
  function arrivals() {
    if (sim.t >= durationMs) return;
    write();
    sim.after(expGap(rng, writesPerSec), arrivals);
  }
  sim.at(0, arrivals);
  sim.run();
  const byId = new Map(all.map((w) => [w.id, w]));
  let kept = 0;
  let diverged = 0;
  for (let k = 0; k < keys; k++) {
    const a = nodes[0].data.get(k);
    const b = nodes[1].data.get(k);
    if (a !== b) diverged++;
    let w = a;
    while (w) {
      kept++;
      w = w.parent ? byId.get(w.parent) : null;
    }
  }
  const dropped = all.length - kept;
  return { writes: all.length, dropped, dropRate: all.length ? dropped / all.length : 0, diverged };
}

// ---------- run everything ----------
console.log("sd-12 replication lab (simulated on one laptop, not a real cluster)\n");

const cap = {};
const ceil = {};
for (const R of CFG.replicaCounts) {
  cap[R] = capacityRun(R, CFG.capacity);
  ceil[R] = capacityRun(R, CFG.writeCeiling);
}
console.log("Part 1: capacity, 200 busy clients, 90% reads / 10% writes");
console.log("replicas  reads/s   writes/s  p95 read ms  write ceiling/s");
for (const R of CFG.replicaCounts) {
  const c = cap[R];
  console.log(
    String(R).padEnd(10) +
      String(r0(c.readsPerSec)).padEnd(10) +
      String(r0(c.writesPerSec)).padEnd(10) +
      String(r1(c.p95ReadMs)).padEnd(13) +
      String(r0(ceil[R].writesPerSec)),
  );
}

const st = {};
for (const lag of CFG.stale.lagsMs) {
  st[lag] = {};
  for (const R of CFG.replicaCounts) st[lag][R] = staleRun(R, lag);
}
console.log("\nPart 2: stale read-backs (write, wait 20 to 1000 ms, read the same row)");
console.log("lag ms    " + CFG.replicaCounts.map((R) => (R + " repl").padEnd(10)).join(""));
for (const lag of CFG.stale.lagsMs) {
  console.log(
    String(lag).padEnd(10) +
      CFG.replicaCounts.map((R) => (r1(st[lag][R].staleRate * 100) + "%").padEnd(10)).join(""),
  );
}

const mm = {};
for (const lag of CFG.mm.lagsMs) mm[lag] = masterMasterRun(lag);
console.log("\nPart 3: two primaries, same 100 keys, last-write-wins");
console.log("lag ms    writes    lost      lost %    diverged keys");
for (const lag of CFG.mm.lagsMs) {
  const m = mm[lag];
  console.log(
    String(lag).padEnd(10) +
      String(m.writes).padEnd(10) +
      String(m.dropped).padEnd(10) +
      (r1(m.dropRate * 100) + "%").padEnd(10) +
      m.diverged,
  );
}
console.log("");

// ---------- summary ----------
const withReplicas = CFG.replicaCounts.filter((R) => R > 0);
const staleAvg = (lag) => (withReplicas.reduce((s, R) => s + st[lag][R].staleRate, 0) / withReplicas.length) * 100;
const staleSpread = (lag) => {
  const v = withReplicas.map((R) => st[lag][R].staleRate * 100);
  return Math.max(...v) - Math.min(...v);
};
const [lagLo, lagHi] = CFG.stale.lagsMs;
const speedup = cap[10].readsPerSec / cap[0].readsPerSec;
const flatEnough = staleSpread(lagLo) < 3 && staleSpread(lagHi) < 3;

const metrics = [];
for (const R of CFG.replicaCounts) metrics.push({ name: `reads per second, ${R} replicas`, value: r0(cap[R].readsPerSec), unit: "reads/s" });
metrics.push({ name: "read speedup, 10 replicas vs primary only", value: r1(speedup), unit: "x" });
metrics.push({ name: "p95 read latency, 0 replicas", value: r1(cap[0].p95ReadMs), unit: "ms" });
metrics.push({ name: "p95 read latency, 10 replicas", value: r1(cap[10].p95ReadMs), unit: "ms" });
metrics.push({ name: "write ceiling, 0 replicas", value: r0(ceil[0].writesPerSec), unit: "writes/s" });
metrics.push({ name: "write ceiling, 10 replicas", value: r0(ceil[10].writesPerSec), unit: "writes/s" });
for (const lag of CFG.stale.lagsMs)
  for (const R of withReplicas)
    metrics.push({ name: `stale read-backs, ${lag} ms lag, ${R} replicas`, value: r1(st[lag][R].staleRate * 100), unit: "%" });
metrics.push({ name: "stale read-backs, primary only", value: r1(st[lagHi][0].staleRate * 100), unit: "%" });
for (const lag of CFG.mm.lagsMs)
  metrics.push({ name: `master-master lost writes, ${lag} ms lag`, value: r1(mm[lag].dropRate * 100), unit: "%" });

const writeWord = ceil[10].writesPerSec < ceil[0].writesPerSec * 0.98 ? "fell" : "stayed flat";
const conclusion =
  `In this simulation 10 read replicas served ${r1(speedup)}x the reads of one primary while the write ceiling ${writeWord} ` +
  `(${r0(ceil[0].writesPerSec)} to ${r0(ceil[10].writesPerSec)} writes/s), reading your own write back was stale ` +
  `${r1(staleAvg(lagLo))}% of the time at ${lagLo} ms lag and ${r1(staleAvg(lagHi))}% at ${lagHi} ms` +
  (flatEnough ? ", about the same for 1, 3 or 10 replicas" : " (it varied with replica count)") +
  `, and two primaries with last-write-wins silently lost ${r1(mm[CFG.mm.lagsMs[0]].dropRate * 100)}% of writes at ${CFG.mm.lagsMs[0]} ms lag.`;

const setup =
  `Simulated in-process on a virtual clock, seed ${CFG.seed}. Read ${CFG.readMs} ms and write ${CFG.writeMs} ms fixed service time per node, ` +
  `+${CFG.shipMsPerReplica} ms primary time per replica per write. Replicas 0/1/3/10; reads round-robin to replicas (primary serves reads only with 0 replicas). ` +
  `Capacity: ${CFG.capacity.clients} busy clients, 90/10 read/write, ${CFG.capacity.measureMs / 1000} s measured. ` +
  `Stale: ${CFG.stale.sessionsPerSec} users/s write then read back after ${CFG.stale.gapMinMs} to ${CFG.stale.gapMaxMs} ms, lag ${CFG.stale.lagsMs.join(" and ")} ms (+/-${CFG.stale.lagJitter * 100}%). ` +
  `Master-master: 2 primaries, ${CFG.mm.keys} keys, ${CFG.mm.writesPerSec} writes/s for ${CFG.mm.durationMs / 1000} s, lag ${CFG.mm.lagsMs.join(" and ")} ms. Not real cluster numbers.`;

console.log("RESULT " + JSON.stringify({ metrics, conclusion, setup }));
