// sd-9 lab: Availability in nines.
// Three in-process services (A calls B calls C) get random outage windows.
// A prober health-checks each service alone, and the full A to B to C chain,
// every 50 ms of simulated time for a 20 minute simulated run. Failure ratios
// are then scaled to a 365 day year. Node.js 22, standard library only.
// Virtual clock: nothing sleeps, so the whole lab finishes in well under a second.

const PROBE_MS = 50;                 // one health check per target every 50 ms
const RUN_MS = 20 * 60 * 1000;       // 20 simulated minutes per run
const HOURS_PER_YEAR = 365 * 24;     // 8,760
const HOP_MS_MIN = 1;                // network hop latency between services
const HOP_MS_MAX = 3;
const WINDOW_MS_MIN = 100;           // one outage lasts 100 to 400 ms
const WINDOW_MS_MAX = 400;
const SEED_BASE = 9009;

const BUDGETS = [
  { label: '99%', downFraction: 0.01 },
  { label: '99.9%', downFraction: 0.001 },
  { label: '99.99%', downFraction: 0.0001 },
];

// Small seeded PRNG (mulberry32) so every run is repeatable.
function rngFrom(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fault injector: total downtime = downFraction x run length, split into
// short windows placed at random, never overlapping each other.
// Every window stays inside WINDOW_MS_MIN..WINDOW_MS_MAX: a short leftover at
// the end is merged into the previous window, or, if that would be too long,
// the two are split into equal halves (each then lands between 200 and 250 ms).
function makeOutageWindows(rng, downFraction, runMs) {
  const totalDown = downFraction * runMs;
  if (totalDown < WINDOW_MS_MIN) {
    throw new Error(`fault budget ${totalDown} ms is shorter than one ${WINDOW_MS_MIN} ms window`);
  }
  const lengths = [];
  let sum = 0;
  while (sum < totalDown - 1e-9) {
    let len = WINDOW_MS_MIN + rng() * (WINDOW_MS_MAX - WINDOW_MS_MIN);
    if (sum + len > totalDown) len = totalDown - sum;
    lengths.push(len);
    sum += len;
  }
  const last = lengths[lengths.length - 1];
  if (last < WINDOW_MS_MIN && lengths.length > 1) {
    lengths.pop();
    const prev = lengths.pop();
    const merged = prev + last;
    if (merged <= WINDOW_MS_MAX) lengths.push(merged);
    else lengths.push(merged / 2, merged / 2);
  }
  for (const len of lengths) {
    if (len < WINDOW_MS_MIN - 1e-9 || len > WINDOW_MS_MAX + 1e-9) {
      throw new Error(`outage window ${len} ms is outside ${WINDOW_MS_MIN} to ${WINDOW_MS_MAX} ms`);
    }
  }
  const freeTime = runMs - totalDown;
  const cuts = lengths.map(() => rng() * freeTime).sort((x, y) => x - y);
  const windows = [];
  let before = 0;
  for (let i = 0; i < lengths.length; i++) {
    const start = cuts[i] + before;
    windows.push([start, start + lengths[i]]);
    before += lengths[i];
  }
  return { windows, scheduledDownMs: sum };
}

class Service {
  constructor(name, windows, downstream, rng) {
    this.name = name;
    this.windows = windows; // sorted [start, end) pairs
    this.downstream = downstream;
    this.rng = rng;
  }

  isUp(t) {
    let lo = 0;
    let hi = this.windows.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const [s, e] = this.windows[mid];
      if (t < s) hi = mid - 1;
      else if (t >= e) lo = mid + 1;
      else return false;
    }
    return true;
  }

  // Health check of this service alone.
  health(t) {
    return this.isUp(t);
  }

  // A real request: this service must be up, then it calls the next one.
  handle(t) {
    if (!this.isUp(t)) return false;
    if (!this.downstream) return true;
    const hop = HOP_MS_MIN + this.rng() * (HOP_MS_MAX - HOP_MS_MIN);
    return this.downstream.handle(t + hop);
  }
}

function runBudget(budget, index) {
  const seed = SEED_BASE + index * 100;
  const names = ['C', 'B', 'A'];
  const services = {};
  const scheduled = {};
  let downstream = null;
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const { windows, scheduledDownMs } = makeOutageWindows(rngFrom(seed + i + 1), budget.downFraction, RUN_MS);
    services[name] = new Service(name, windows, downstream, rngFrom(seed + 50 + i));
    scheduled[name] = { windows: windows.length, downMs: scheduledDownMs };
    downstream = services[name];
  }

  const targets = ['A', 'B', 'C', 'chain'];
  const counts = Object.fromEntries(targets.map((k) => [k, { ok: 0, fail: 0 }]));
  for (let t = 0; t < RUN_MS; t += PROBE_MS) {
    for (const name of ['A', 'B', 'C']) {
      if (services[name].health(t)) counts[name].ok++;
      else counts[name].fail++;
    }
    if (services.A.handle(t)) counts.chain.ok++;
    else counts.chain.fail++;
  }

  const stats = {};
  for (const k of targets) {
    const total = counts[k].ok + counts[k].fail;
    const failRatio = counts[k].fail / total;
    stats[k] = {
      checks: total,
      failed: counts[k].fail,
      availabilityPct: (1 - failRatio) * 100,
      downHoursPerYear: (counts[k].fail * HOURS_PER_YEAR) / total, // from failed counts
    };
  }
  const singles = ['A', 'B', 'C'].map((k) => stats[k]);
  const single = {
    availabilityPct: singles.reduce((s, x) => s + x.availabilityPct, 0) / 3,
    downHoursPerYear: singles.reduce((s, x) => s + x.downHoursPerYear, 0) / 3,
    failedAvg: singles.reduce((s, x) => s + x.failed, 0) / 3,
  };
  const productPct = singles.reduce((p, x) => p * (x.availabilityPct / 100), 1) * 100;
  return { budget, scheduled, stats, single, productPct };
}

// Decimal half-up rounding used for BOTH printed lines and RESULT JSON, so they always agree.
// (Plain toFixed rounds the double nearest 26.645 down to 26.64; Math.round(x * 100) rounds it up.)
const roundTo = (x, d) => Number(`${Math.round(Number(`${Number(x.toPrecision(12))}e${d}`))}e-${d}`);
const fx = (x, d) => roundTo(x, d).toFixed(d);
const r4 = (x) => roundTo(x, 4);
const r2 = (x) => roundTo(x, 2);
const r1 = (x) => roundTo(x, 1);

const started = Date.now();
const results = BUDGETS.map(runBudget);
const wallMs = Date.now() - started;

console.log('sd-9 lab: availability in nines (compressed-time simulation on one machine)');
console.log(`each run: ${RUN_MS / 60000} simulated minutes, a check every ${PROBE_MS} ms, ${results[0].stats.A.checks} checks per target`);
console.log('');
for (const r of results) {
  console.log(`fault budget ${fx(r.budget.downFraction * 100, 2)}% per service (target ${r.budget.label})`);
  for (const k of ['A', 'B', 'C']) {
    const s = r.stats[k];
    console.log(
      `  service ${k}: ${r.scheduled[k].windows} outage windows, ${s.failed}/${s.checks} checks failed, ` +
        `${fx(s.availabilityPct, 4)}% up, ${fx(s.downHoursPerYear, 2)} h down per year`,
    );
  }
  const c = r.stats.chain;
  console.log(
    `  chain A to B to C: ${c.failed}/${c.checks} checks failed, ${fx(c.availabilityPct, 4)}% up, ` +
      `${fx(c.downHoursPerYear, 2)} h down per year (product of the three singles: ${fx(r.productPct, 4)}%)`,
  );
  console.log(
    `  mean of A, B, C: ${fx(r.single.availabilityPct, 4)}% up, ${fx(r.single.downHoursPerYear, 2)} h down per year`,
  );
  console.log('');
}
console.log(`wall time ${wallMs} ms`);

const [p99, p999, p9999] = results;
const metrics = [];
for (const r of results) {
  const tag = r.budget.label;
  metrics.push({ name: `simulated availability, mean of services A, B, C (${tag} budget)`, value: r4(r.single.availabilityPct), unit: '%' });
  metrics.push({ name: `annualized downtime estimate, mean of services A, B, C (${tag} budget)`, value: r2(r.single.downHoursPerYear), unit: 'hours' });
  metrics.push({ name: `failed probes, mean of services A, B, C (${tag} budget)`, value: r1(r.single.failedAvg), unit: 'checks' });
  metrics.push({ name: `simulated availability, chain A to B to C (${tag} budget)`, value: r4(r.stats.chain.availabilityPct), unit: '%' });
  metrics.push({ name: `annualized downtime estimate, chain A to B to C (${tag} budget)`, value: r2(r.stats.chain.downHoursPerYear), unit: 'hours' });
}
metrics.push({ name: 'annualized downtime estimate, mean of services A, B, C (99% budget)', value: r2(p99.single.downHoursPerYear / 24), unit: 'days' });
metrics.push({ name: 'annualized downtime estimate, mean of services A, B, C (99.99% budget)', value: r1(p9999.single.downHoursPerYear * 60), unit: 'minutes' });
metrics.push({ name: 'product of A, B, C simulated availabilities (99.9% budget)', value: r4(p999.productPct), unit: '%' });
metrics.push({ name: 'probes per target per run', value: p999.stats.A.checks, unit: 'checks' });

const conclusion =
  `In this simulation, at a 0.1% fault budget per service, services A, B and C averaged ` +
  `${fx(p999.single.availabilityPct, 3)}% of probes passing, an annualized estimate of about ` +
  `${fx(p999.single.downHoursPerYear, 1)} hours down per year each, while probes through the A to B to C chain passed ` +
  `${fx(p999.stats.chain.availabilityPct, 3)}% of the time, about ${fx(p999.stats.chain.downHoursPerYear, 1)} hours a year, ` +
  `about ${fx(p999.stats.chain.downHoursPerYear / p999.single.downHoursPerYear, 1)}x the per-service mean.`;

const setup =
  `in-process simulation, virtual clock, fixed seeds from ${SEED_BASE}; 3 services A calls B calls C with ` +
  `${HOP_MS_MIN} to ${HOP_MS_MAX} ms simulated hops; each service up or down per a schedule of random non-overlapping ` +
  `outage windows of ${WINDOW_MS_MIN} to ${WINDOW_MS_MAX} ms (all windows, including the last, kept in that range) ` +
  `totalling 1%, 0.1% and 0.01% of each run; simulated probe every ${PROBE_MS} ms for ${RUN_MS / 60000} simulated minutes ` +
  `(${p999.stats.A.checks} probes per target); single-service values are the mean of A, B and C; ` +
  `annualized downtime = simulated failure ratio x ${HOURS_PER_YEAR} h, assuming that ratio represents a full year ` +
  `(says nothing about outage timing); no real HTTP servers, process stops or health-check code; ` +
  `compressed-time simulation on one Mac, not a production measurement`;

console.log('RESULT ' + JSON.stringify({ metrics, conclusion, setup }));
