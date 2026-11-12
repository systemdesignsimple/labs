// sd #3 lab: "How would you build Instagram on one napkin?"
// Question: how many home-feed requests per second can one in-process feed
// handler serve on one core, how close does a napkin estimate get to that, and
// what does a simulated FIFO queue in front of it do as offered load rises?
//
// Node.js 22 ESM, standard library only. No network, no child processes, no files.
// There is NO HTTP server here (that would need the network). What is measured is
// the CPU cost of a synchronous handler function. Queueing under rising load is
// simulated with that measured cost and seeded arrivals. Sizing numbers are
// hypothetical "handler-core equivalents", not real server counts.

import { performance } from 'node:perf_hooks';

const SEED = 20261102;

// Overall time budget. The rules say under 60 s; we stop well before that so
// there is always time left to print the RESULT line.
const T0 = performance.now();
const BUDGET_MS = 40_000;
const elapsedMs = () => performance.now() - T0;
const overBudget = () => elapsedMs() > BUDGET_MS;

const CFG = {
  users: 10_000,
  followsPerUser: 150,
  postsPerUser: 20,
  feedSize: 20,
  textLen: 120,
  warmupMs: 1500,
  throughputMs: 4000,
  latencySampleMax: 20_000,
  latencySampleMs: 1500,
  simSecondsPerLevel: 5,
  simMaxArrivalsPerLevel: 300_000, // work cap: the window shrinks if 5 s would exceed it
  loadLevels: [0.25, 0.5, 0.75, 0.9, 0.95, 1.0, 1.1, 1.25],
  // Hypothetical load for the "how many handler cores" step. NOT real Instagram numbers.
  hypoDAU: 100_000_000,
  feedsPerUserPerDay: 10,
  peakFactor: 3,
  targetUtil: 0.5,
};

// ---------------------------------------------------------------------------
// 1. Napkin estimate, written down BEFORE anything is measured.
//    A feed request touches ~150 followee timelines (~0.5 us each to look at the
//    newest post and keep a small heap), merges out 20 posts, and serializes
//    ~2.5 KB of JSON (~25 us). Round up for overhead: ~100 us per request.
//    100 us per request -> 10,000 requests per second on one core.
// ---------------------------------------------------------------------------
const NAPKIN = {
  perFolloweeUs: 0.5,
  followees: 150,
  serializeUs: 25,
  overheadUs: 0, // filled below so the total is a round 100 us
};
NAPKIN.overheadUs = 100 - (NAPKIN.perFolloweeUs * NAPKIN.followees + NAPKIN.serializeUs);
const napkinUs = NAPKIN.perFolloweeUs * NAPKIN.followees + NAPKIN.serializeUs + NAPKIN.overheadUs;
const napkinRps = 1e6 / napkinUs;

// ---------------------------------------------------------------------------
// Seeded PRNG
// ---------------------------------------------------------------------------
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// If the time budget runs out, print one honest RESULT line and stop.
function bail(stage, metrics = []) {
  console.log('RESULT ' + JSON.stringify({
    metrics: [...metrics, { name: 'elapsed_at_abort', value: Math.round(elapsedMs()), unit: 'ms' }],
    conclusion: `The run hit its ${BUDGET_MS / 1000} s time budget during ${stage}, so no capacity conclusion is drawn.`,
    setup: `Node ${process.version}, aborted during ${stage}; seed ${SEED}`,
  }));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 2. Synthetic in-memory store: users, posts, follows.
// ---------------------------------------------------------------------------
const rng = mulberry32(SEED);
const WORDS = ('cache shard replica feed photo story like follow server queue edge ' +
  'latency index write read fanout timeline user post comment region load balancer').split(' ');

function makeText() {
  let s = '';
  while (s.length < CFG.textLen) s += WORDS[(rng() * WORDS.length) | 0] + ' ';
  return s.slice(0, CFG.textLen);
}

const BASE_TS = 1_700_000_000;
const timelines = new Array(CFG.users); // per user: posts sorted newest first
for (let u = 0; u < CFG.users; u++) {
  if ((u & 1023) === 0 && overBudget()) bail('data generation');
  const posts = [];
  for (let k = 0; k < CFG.postsPerUser; k++) {
    posts.push({
      id: `p${u}_${k}`,
      author: `u${u}`,
      ts: BASE_TS + Math.floor(rng() * 604_800),
      likes: Math.floor(rng() * 5000),
      text: makeText(),
    });
  }
  posts.sort((a, b) => b.ts - a.ts);
  timelines[u] = posts;
}

const follows = new Array(CFG.users);
for (let u = 0; u < CFG.users; u++) {
  if ((u & 1023) === 0 && overBudget()) bail('follow graph generation');
  const set = new Set();
  while (set.size < CFG.followsPerUser) {
    const v = (rng() * CFG.users) | 0;
    if (v !== u) set.add(v);
  }
  follows[u] = Int32Array.from(set);
}

// ---------------------------------------------------------------------------
// 3. The request handler: build the home feed (20 newest posts across followees)
//    with a k-way merge over a max-heap, then serialize to JSON.
// ---------------------------------------------------------------------------
const HT = new Float64Array(CFG.followsPerUser);
const HA = new Int32Array(CFG.followsPerUser);
const HP = new Int32Array(CFG.followsPerUser);
let hn = 0;

function hSwap(i, j) {
  let t = HT[i]; HT[i] = HT[j]; HT[j] = t;
  t = HA[i]; HA[i] = HA[j]; HA[j] = t;
  t = HP[i]; HP[i] = HP[j]; HP[j] = t;
}
function hUp(i) {
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (HT[p] >= HT[i]) return;
    hSwap(i, p);
    i = p;
  }
}
function hDown(i) {
  for (;;) {
    const l = 2 * i + 1, r = l + 1;
    let m = i;
    if (l < hn && HT[l] > HT[m]) m = l;
    if (r < hn && HT[r] > HT[m]) m = r;
    if (m === i) return;
    hSwap(i, m);
    i = m;
  }
}

function homeFeed(uid) {
  const f = follows[uid];
  hn = 0;
  for (let i = 0; i < f.length; i++) {
    const a = f[i];
    const tl = timelines[a];
    if (tl.length === 0) continue;
    HT[hn] = tl[0].ts; HA[hn] = a; HP[hn] = 0;
    hUp(hn++);
  }
  const items = [];
  while (items.length < CFG.feedSize && hn > 0) {
    const a = HA[0], p = HP[0];
    const tl = timelines[a];
    items.push(tl[p]);
    if (p + 1 < tl.length) {
      HT[0] = tl[p + 1].ts; HP[0] = p + 1;
    } else {
      hn--;
      HT[0] = HT[hn]; HA[0] = HA[hn]; HP[0] = HP[hn];
    }
    hDown(0);
  }
  return JSON.stringify({ user: `u${uid}`, items });
}

// Seeded request stream (which user asks for their feed).
const MASK = (1 << 20) - 1;
const reqUsers = new Int32Array(MASK + 1);
for (let i = 0; i <= MASK; i++) reqUsers[i] = (rng() * CFG.users) | 0;
if (overBudget()) bail('request stream generation');

// Sanity check: the feed is really the 20 newest posts, newest first.
{
  const feed = JSON.parse(homeFeed(0)).items;
  const all = [];
  for (const a of follows[0]) for (const p of timelines[a]) all.push(p.ts);
  all.sort((x, y) => y - x);
  const ok = feed.length === CFG.feedSize && feed.every((p, i) => p.ts === all[i]);
  if (!ok) throw new Error('feed handler returned the wrong posts');
}

// ---------------------------------------------------------------------------
// 4. Measure: warm up, then a throughput pass (no per-request timers), then a
//    latency pass that times individual requests. Each pass also stops if the
//    overall budget runs out.
// ---------------------------------------------------------------------------
let sink = 0;
let cursor = 0;

function runFor(ms) {
  let count = 0;
  const start = performance.now();
  const end = start + ms;
  for (;;) {
    for (let k = 0; k < 64; k++) sink += homeFeed(reqUsers[cursor++ & MASK]).length;
    count += 64;
    const now = performance.now();
    if (now >= end || now - T0 > BUDGET_MS) break;
  }
  return { count, elapsedMs: performance.now() - start };
}

console.log(`napkin estimate (written before measuring): ${napkinUs} us/request -> ${Math.round(napkinRps)} req/s on one core`);
runFor(CFG.warmupMs);
if (overBudget()) bail('warmup');
const tp = runFor(CFG.throughputMs);
if (overBudget()) bail('throughput pass');
const measuredRps = tp.count / (tp.elapsedMs / 1000);
const measuredUs = 1e6 / measuredRps;
console.log(`measured in-process handler: ${tp.count} requests in ${tp.elapsedMs.toFixed(0)} ms -> ${Math.round(measuredRps)} req/s (${measuredUs.toFixed(1)} us/request)`);

const samples = [];
{
  const end = performance.now() + CFG.latencySampleMs;
  while (samples.length < CFG.latencySampleMax && performance.now() < end && !overBudget()) {
    const t0 = performance.now();
    sink += homeFeed(reqUsers[cursor++ & MASK]).length;
    samples.push(performance.now() - t0); // ms
  }
}
const measuredMetric = [{ name: 'measured_rps_one_core', value: Math.round(measuredRps), unit: 'req/s' }];
if (overBudget() || samples.length === 0) bail('latency sampling', measuredMetric);
const avgBytes = Math.round(Buffer.byteLength(homeFeed(1)));

// Per-request timers add their own overhead, so scale the sampled service times
// to match the mean cost from the throughput pass. Shape kept, mean corrected.
const sampleMean = samples.reduce((s, x) => s + x, 0) / samples.length;
const scale = (1000 / measuredRps) / sampleMean;
const service = Float64Array.from(samples, (x) => (x * scale) / 1000); // seconds

function pct(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}
const svcSorted = Float64Array.from(service).sort();
console.log(`service time: p50 ${(pct(svcSorted, 0.5) * 1e6).toFixed(1)} us, p99 ${(pct(svcSorted, 0.99) * 1e6).toFixed(1)} us (${samples.length} samples)`);

// ---------------------------------------------------------------------------
// 5. Simulate one single-threaded handler (FIFO queue) at rising offered load,
//    using the measured service-time distribution and seeded Poisson arrivals.
//    Arrivals stop at the end of the window W; the queue is then drained with
//    nothing dropped. Two latency populations are reported, because they differ
//    under overload:
//      - "in-window": requests that arrived AND completed inside W (this is the
//        set counted as served throughput);
//      - "all": every request that arrived in W, including the backlog finished
//        after W (eventual latency).
//    Backlog = requests that arrived in W but were not finished by its end.
//    W is 5 s, shortened only if 5 s would exceed the per-level arrival cap.
// ---------------------------------------------------------------------------
function simulate(load, levelIdx) {
  const r = mulberry32(SEED + 1000 + levelIdx);
  const lambda = load * measuredRps;
  const W = Math.min(CFG.simSecondsPerLevel, CFG.simMaxArrivalsPerLevel / lambda);
  let t = 0, free = 0, n = 0;
  const latAll = [];
  const latIn = [];
  for (;;) {
    t += -Math.log(1 - r()) / lambda;
    if (t > W || n >= CFG.simMaxArrivalsPerLevel) break;
    if ((n & 16383) === 0 && overBudget()) return null;
    n++;
    const s = service[(r() * service.length) | 0];
    const startAt = t > free ? t : free;
    free = startAt + s;
    latAll.push(free - t);
    if (free <= W) latIn.push(free - t);
  }
  const all = Float64Array.from(latAll).sort();
  const inw = Float64Array.from(latIn).sort();
  return {
    load,
    windowS: W,
    offered: lambda,
    throughput: inw.length / W,
    backlog: latAll.length - latIn.length,
    p50ms: pct(all, 0.5) * 1000,
    p99ms: pct(all, 0.99) * 1000,
    p99InMs: inw.length ? pct(inw, 0.99) * 1000 : 0,
  };
}

const levels = [];
for (let i = 0; i < CFG.loadLevels.length; i++) {
  const x = simulate(CFG.loadLevels[i], i);
  if (!x) bail('queue simulation', measuredMetric);
  levels.push(x);
}
console.log('simulated queue (latency "all" includes backlog drained after the window):');
console.log('load  window s  offered req/s  served req/s  backlog  p50 all ms  p99 all ms  p99 in-window ms');
for (const x of levels) {
  console.log(
    `${(x.load * 100).toFixed(0).padStart(3)}%  ${x.windowS.toFixed(2).padStart(8)}  ${Math.round(x.offered).toString().padStart(13)}  ` +
    `${Math.round(x.throughput).toString().padStart(12)}  ${String(x.backlog).padStart(7)}  ${x.p50ms.toFixed(3).padStart(10)}  ` +
    `${x.p99ms.toFixed(3).padStart(10)}  ${x.p99InMs.toFixed(3).padStart(16)}`,
  );
}
const at = (l) => levels.find((x) => x.load === l);
const half = at(0.5), over = at(1.1), sat = at(1.25);

// ---------------------------------------------------------------------------
// 6. Napkin vs measured, and the "how many handler cores" step for a
//    HYPOTHETICAL load. These are handler-core equivalents, not servers.
// ---------------------------------------------------------------------------
const ratio = measuredRps / napkinRps;
const offBy = ratio >= 1 ? ratio : 1 / ratio;
const avgRps = (CFG.hypoDAU * CFG.feedsPerUserPerDay) / 86_400;
const peakRps = avgRps * CFG.peakFactor;
const coresMeasured = Math.ceil(peakRps / (measuredRps * CFG.targetUtil));
const coresNapkin = Math.ceil(peakRps / (napkinRps * CFG.targetUtil));

console.log(`napkin vs measured: measured/napkin = ${ratio.toFixed(2)}x (off by a factor of ${offBy.toFixed(2)})`);
console.log(`hypothetical ${CFG.hypoDAU / 1e6}M DAU x ${CFG.feedsPerUserPerDay} feeds/day: avg ${Math.round(avgRps)} req/s, peak (x${CFG.peakFactor}) ${Math.round(peakRps)} req/s`);
console.log(`hypothetical handler-core equivalents at ${CFG.targetUtil * 100}% target utilization: ${coresMeasured} (measured) vs ${coresNapkin} (napkin)`);

const r1 = (x) => Math.round(x);
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;

// Pick the conclusion from the actual comparisons; never assert an effect the
// numbers did not show.
function buildConclusion() {
  const dir = ratio >= 1 ? 'faster' : 'slower';
  const napkinPart = offBy <= 3
    ? `the measured in-process handler (${r1(measuredRps)} req/s on one core) came within a factor of ${offBy.toFixed(1)} of the ${r1(napkinRps)} req/s napkin guess (${dir} than guessed)`
    : `the measured in-process handler (${r1(measuredRps)} req/s on one core) was ${offBy.toFixed(1)}x ${dir} than the ${r1(napkinRps)} req/s napkin guess, a bigger miss than a napkin should allow`;
  // "Flattened": going from 110% to 125% offered load adds under 5% served
  // throughput, and served stays within 10% of the measured capacity.
  const flattened = sat.throughput < over.throughput * 1.05 && sat.throughput <= measuredRps * 1.1;
  // "Rose": p99 (all arrivals) at 110% is more than double p99 at 50%.
  const p99Rose = over.p99ms > half.p99ms * 2;
  let queuePart;
  if (flattened && p99Rose) {
    queuePart = `in the queue simulation served throughput flattened near ${r1(sat.throughput)} req/s past saturation while p99 latency (all arrivals) rose from ${r3(half.p99ms)} ms at 50% load to ${r3(over.p99ms)} ms at 110%`;
  } else if (p99Rose) {
    queuePart = `in the queue simulation p99 latency rose from ${r3(half.p99ms)} ms at 50% load to ${r3(over.p99ms)} ms at 110%, but served throughput did not clearly flatten (${r1(over.throughput)} vs ${r1(sat.throughput)} req/s at 110% and 125%)`;
  } else if (flattened) {
    queuePart = `in the queue simulation served throughput flattened near ${r1(sat.throughput)} req/s, but p99 did not clearly rise (${r3(half.p99ms)} ms at 50% vs ${r3(over.p99ms)} ms at 110%)`;
  } else {
    queuePart = `the queue simulation did not show the expected saturation shape (served ${r1(over.throughput)} vs ${r1(sat.throughput)} req/s at 110% and 125%, p99 ${r3(half.p99ms)} vs ${r3(over.p99ms)} ms at 50% and 110%)`;
  }
  return `In-process, ${napkinPart}, and ${queuePart}.`;
}

const result = {
  metrics: [
    { name: 'napkin_estimate_rps', value: r1(napkinRps), unit: 'req/s' },
    { name: 'measured_rps_one_core', value: r1(measuredRps), unit: 'req/s' },
    { name: 'measured_cost_per_request', value: r2(measuredUs), unit: 'us' },
    { name: 'measured_over_napkin', value: r2(ratio), unit: 'x' },
    { name: 'response_size', value: avgBytes, unit: 'bytes' },
    { name: 'sim_p99_all_at_50pct_load', value: r3(half.p99ms), unit: 'ms' },
    { name: 'sim_p99_all_at_110pct_load', value: r3(over.p99ms), unit: 'ms' },
    { name: 'sim_p99_in_window_at_110pct_load', value: r3(over.p99InMs), unit: 'ms' },
    { name: 'sim_backlog_at_110pct_load', value: over.backlog, unit: 'requests' },
    { name: 'sim_served_at_110pct_load', value: r1(over.throughput), unit: 'req/s' },
    { name: 'sim_served_at_125pct_load', value: r1(sat.throughput), unit: 'req/s' },
    { name: 'hypothetical_peak_rps', value: r1(peakRps), unit: 'req/s' },
    { name: 'hypothetical_handler_cores_measured', value: coresMeasured, unit: 'handler-core equivalents' },
    { name: 'hypothetical_handler_cores_napkin', value: coresNapkin, unit: 'handler-core equivalents' },
    { name: 'elapsed', value: r1(elapsedMs()), unit: 'ms' },
  ],
  conclusion: buildConclusion(),
  setup:
    `Node ${process.version}, one core, synchronous in-process handler (no HTTP, network, disk or database); ${CFG.users} synthetic users x ${CFG.postsPerUser} posts, ` +
    `${CFG.followsPerUser} follows each, feed = ${CFG.feedSize} newest via k-way merge + JSON; ${CFG.throughputMs} ms throughput pass after ${CFG.warmupMs} ms warmup; ` +
    `FIFO queue simulated up to ${CFG.simSecondsPerLevel} s (max ${CFG.simMaxArrivalsPerLevel} arrivals) per load level with seeded Poisson arrivals and measured service times, ` +
    `served = completed inside the window, "all" latency includes backlog drained after it with no drops; ` +
    `hypothetical load ${CFG.hypoDAU / 1e6}M DAU x ${CFG.feedsPerUserPerDay} feeds/day, peak x${CFG.peakFactor}, target utilization ${CFG.targetUtil * 100}%; ` +
    `time budget ${BUDGET_MS / 1000} s; seed ${SEED}`,
};

if (sink === -1) console.log('unreachable');
console.log('RESULT ' + JSON.stringify(result));
