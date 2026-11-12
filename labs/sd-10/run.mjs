// sd-10 lab: availability in sequence vs parallel.
// Node.js 22 ESM, standard library only. Everything runs in-process on a
// simulated clock, so the run is repeatable from the seed and finishes fast.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ---------- parameters ----------
const SEED = 1010;
const REQUESTS = 200_000;          // requests per path
const RATE_PER_SEC = 100;          // simulated arrival rate
const UP_MEAN_MS = 1980;           // mean length of an "up" stretch (exponential)
const DOWN_MIN_MS = 10;            // each outage lasts 10..30 ms (uniform), mean 20 ms
const DOWN_MAX_MS = 30;            // so target uptime = 1980 / (1980 + 20) = 99%
const HOP_MS = 1;                  // chain: A calls B 1 ms after A receives the request
const RETRY_DELAY_MS = 5;          // parallel: if A refuses, the client tries B 5 ms later
const MAX_DELAY_MS = Math.max(HOP_MS, RETRY_DELAY_MS); // latest offset any path asks a server about

// ---------- seeded PRNG (mulberry32) ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- arrivals first, so the outage schedules cover every request ----------
// One arrival stream (fixed seed) shared by all paths, so every path sees the same request times.
const arrivalRnd = mulberry32(SEED);
const arrivals = new Float64Array(REQUESTS);
{
  let t = 0;
  for (let i = 0; i < REQUESTS; i++) {
    t += -Math.log(1 - arrivalRnd()) * (1000 / RATE_PER_SEC);
    arrivals[i] = t;
  }
}
const lastArrival = arrivals[REQUESTS - 1];
// Schedules run through the last arrival plus the largest delay any path adds.
const HORIZON_MS = lastArrival + MAX_DELAY_MS;

// ---------- a simulated server with its own chaos schedule ----------
class Server {
  constructor(name, seed) {
    this.name = name;
    this.down = []; // sorted [start, end) outage windows
    const rnd = mulberry32(seed);
    let t = 0;
    while (t < HORIZON_MS) {
      t += -Math.log(1 - rnd()) * UP_MEAN_MS;            // up stretch
      const len = DOWN_MIN_MS + rnd() * (DOWN_MAX_MS - DOWN_MIN_MS);
      if (t >= HORIZON_MS) break;
      this.down.push([t, t + len]);                       // outage (may end past the horizon)
      t += len;
    }
    this.handled = 0;
    this.refused = 0;
  }
  isUp(t) {
    if (!(t >= 0 && t <= HORIZON_MS)) {
      throw new RangeError(`${this.name}: asked about t=${t} ms, outside the simulated 0..${HORIZON_MS} ms`);
    }
    let lo = 0, hi = this.down.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const [s, e] = this.down[mid];
      if (t < s) hi = mid - 1;
      else if (t >= e) lo = mid + 1;
      else return false;
    }
    return true;
  }
  handle(t) {
    if (this.isUp(t)) { this.handled++; return true; }
    this.refused++; return false;
  }
  measuredUptime(until) {
    if (until > HORIZON_MS) throw new RangeError(`${this.name}: uptime asked past the simulated horizon`);
    let downMs = 0;
    for (const [s, e] of this.down) {
      if (s >= until) break;
      downMs += Math.min(e, until) - s;
    }
    return 1 - downMs / until;
  }
}

// ---------- the three paths ----------
const started = new Date();
const solo = new Server('solo', SEED * 7 + 1);
const A = new Server('A', SEED * 7 + 2);
const B = new Server('B', SEED * 7 + 3);

const paths = {
  single:   { ok: 0, fail: 0, run: (t) => solo.handle(t) },
  // sequence: request must pass A, then A must reach B
  sequence: { ok: 0, fail: 0, run: (t) => A.handle(t) && B.handle(t + HOP_MS) },
  // parallel: try A; if A refuses, retry on B a few ms later (no request deadline is modelled)
  parallel: { ok: 0, fail: 0, fellBack: 0, run(t) {
    if (A.handle(t)) return true;
    this.fellBack++;
    return B.handle(t + RETRY_DELAY_MS);
  } },
};

for (const path of Object.values(paths)) {
  for (let i = 0; i < REQUESTS; i++) {
    if (path.run(arrivals[i])) path.ok++; else path.fail++;
  }
}

// ---------- compare with the formulas ----------
const span = HORIZON_MS;
const pSolo = solo.measuredUptime(span);
const pA = A.measuredUptime(span);
const pB = B.measuredUptime(span);
const rate = (p) => p.ok / REQUESTS;
const pct = (x, d = 3) => +(x * 100).toFixed(d);

const predicted = {
  single: pSolo,
  sequence: pA * pB,
  parallel: 1 - (1 - pA) * (1 - pB),
};
const measured = {
  single: rate(paths.single),
  sequence: rate(paths.sequence),
  parallel: rate(paths.parallel),
};
const failRatio = paths.single.fail > 0 ? paths.sequence.fail / paths.single.fail : null;

const finished = new Date();
const record = {
  lab: 'sd-10 availability in sequence vs parallel',
  seed: SEED,
  requestsPerPath: REQUESTS,
  startedAt: started.toISOString(),
  finishedAt: finished.toISOString(),
  simulatedSeconds: +(span / 1000).toFixed(1),
  params: { RATE_PER_SEC, UP_MEAN_MS, DOWN_MIN_MS, DOWN_MAX_MS, HOP_MS, RETRY_DELAY_MS },
  servers: [solo, A, B].map((s) => ({
    name: s.name,
    outages: s.down.filter(([st]) => st < span).length,
    measuredUptimePct: pct(s.measuredUptime(span), 4),
  })),
  paths: Object.fromEntries(Object.keys(paths).map((k) => [k, {
    ok: paths[k].ok,
    fail: paths[k].fail,
    measuredSuccessPct: pct(measured[k], 4),
    formulaPct: pct(predicted[k], 4),
    ...(k === 'parallel' ? { fellBackToB: paths.parallel.fellBack } : {}),
  }])),
  formulas: { single: 'pSolo', sequence: 'pA * pB', parallel: '1 - (1 - pA) * (1 - pB)' },
};
const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(here, 'run-result.json'), JSON.stringify(record, null, 2) + '\n');

// ---------- human-readable table ----------
console.log(`sd-10 lab · seed ${SEED} · ${REQUESTS.toLocaleString('en-US')} requests per path · ${record.simulatedSeconds}s simulated`);
for (const s of record.servers) {
  console.log(`  server ${s.name.padEnd(5)} uptime ${s.measuredUptimePct}%  (${s.outages} outages)`);
}
console.log('  path       ok        fail   measured    formula');
for (const k of Object.keys(paths)) {
  const p = record.paths[k];
  console.log(`  ${k.padEnd(9)} ${String(p.ok).padStart(7)} ${String(p.fail).padStart(8)}   ${String(p.measuredSuccessPct).padStart(8)}%  ${String(p.formulaPct).padStart(8)}%`);
}
console.log(`  parallel fell back to B ${paths.parallel.fellBack} times`);
console.log('  saved run-result.json');

// ---------- conclusion: only say what the numbers show ----------
const chainWorse = paths.sequence.fail > paths.single.fail;
const parallelBest = paths.parallel.fail < paths.single.fail;
const ratioText = failRatio === null ? 'more' : `${failRatio.toFixed(1)}x as many`;
const conclusion = chainWorse && parallelBest
  ? `With each server targeting 99% uptime (measured solo ${pct(pSolo, 2)}%, A ${pct(pA, 2)}%, B ${pct(pB, 2)}%), two servers in a row failed ${ratioText} requests as one server (${paths.sequence.fail} vs ${paths.single.fail} of ${REQUESTS}), while two side-by-side servers failed only ${paths.parallel.fail}.`
  : `In this run the expected ordering did not fully hold (single ${paths.single.fail}, sequence ${paths.sequence.fail}, parallel ${paths.parallel.fail} failures of ${REQUESTS}), so the sample is too small or the settings need checking.`;

const result = {
  metrics: [
    { name: 'solo server uptime (measured)', value: pct(pSolo, 3), unit: '%' },
    { name: 'server A uptime (measured)', value: pct(pA, 3), unit: '%' },
    { name: 'server B uptime (measured)', value: pct(pB, 3), unit: '%' },
    { name: 'single server success', value: pct(measured.single, 3), unit: '%' },
    { name: 'two in a row success', value: pct(measured.sequence, 3), unit: '%' },
    { name: 'two in a row formula pA*pB', value: pct(predicted.sequence, 3), unit: '%' },
    { name: 'two side by side success', value: pct(measured.parallel, 3), unit: '%' },
    { name: 'two side by side formula 1-(1-pA)*(1-pB)', value: pct(predicted.parallel, 3), unit: '%' },
    { name: 'single server failures', value: paths.single.fail, unit: 'requests' },
    { name: 'two in a row failures', value: paths.sequence.fail, unit: 'requests' },
    { name: 'two side by side failures', value: paths.parallel.fail, unit: 'requests' },
    { name: 'requests per path', value: REQUESTS, unit: 'requests' },
  ],
  conclusion,
  setup: `seed ${SEED}; ${REQUESTS} requests per path at ${RATE_PER_SEC}/s simulated; 3 in-process servers, each with its own random outages (up stretches mean ${UP_MEAN_MS} ms, outages ${DOWN_MIN_MS} to ${DOWN_MAX_MS} ms, target 99% up); chain hop ${HOP_MS} ms; parallel retries B ${RETRY_DELAY_MS} ms after A refuses, no request deadline; outage schedules cover the last arrival plus ${MAX_DELAY_MS} ms`,
};
console.log('RESULT ' + JSON.stringify(result));
