// ai-12 lab: exact full scan vs an HNSW vector index, built in-process.
// Node.js 22 ESM, standard library only. Fixed workload and fixed seeds, so the data,
// the graph, the comparison counts and recall repeat run to run. Latency depends on this machine.
import { performance } from 'node:perf_hooks';
const T0 = performance.now(); // whole-run clock, started before any work

// ---------- parameters (fixed workload; nothing shrinks on a slow machine) ----------
const SEED = 12;
const N = 20000;             // stored vectors ("photos"), always all indexed
const D = 64;                // dimensions per vector (multiple of 4)
const LATENT = 8;            // hidden dimensions each cluster really varies in
const CLUSTERS = 100;        // groups of similar photos
const Q = 200;               // timed queries
const WARMUP = 20;           // untimed queries to warm the JIT
const K = 10;                // we want the 10 closest matches
const M = 12;                // HNSW links per node (upper layers and new links)
const M0 = 24;               // max links per node on the bottom layer
const EF_C = 60;             // HNSW build-time search width
const EF_SWEEP = [10, 20, 40, 80, 160, 320]; // HNSW query-time search width
const TARGET_RECALL = 0.95;
const DEADLINE_MS = 50000;   // hard stop for the whole run (rule: under 60 s). The workload is
                             // sized to finish far inside it; hitting it means INCOMPLETE, not a result.

class DeadlineHit extends Error {}
let stage = 'start';
function checkDeadline() {
  if (performance.now() - T0 > DEADLINE_MS) throw new DeadlineHit(stage);
}

// ---------- seeded random ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const levelRand = mulberry32(SEED + 1);
function gauss() {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

// ---------- synthetic "photo embeddings" ----------
// Each point = cluster centre + (cluster's own 64x8 matrix * 8 hidden values) + small noise.
// Real embeddings are clumpy and live near low-dimensional shapes; pure uniform noise is not.
const centers = new Float32Array(CLUSTERS * D);
for (let i = 0; i < centers.length; i++) centers[i] = 2 * gauss();
const mats = new Float32Array(CLUSTERS * D * LATENT);
for (let i = 0; i < mats.length; i++) mats[i] = 0.25 * gauss();
const z = new Float64Array(LATENT);
function makePoint(arr, off) {
  const c = Math.floor(rand() * CLUSTERS);
  for (let j = 0; j < LATENT; j++) z[j] = gauss();
  for (let k = 0; k < D; k++) {
    let s = centers[c * D + k];
    const mo = (c * D + k) * LATENT;
    for (let j = 0; j < LATENT; j++) s += mats[mo + j] * z[j];
    arr[off + k] = s + 0.05 * gauss();
  }
}
const data = new Float32Array(N * D);
const queries = new Float32Array((Q + WARMUP) * D);

// ---------- distance (squared L2), counted two ways ----------
// distCount: every distance evaluation (the same vector can be evaluated again on another layer).
// uniqueCount: distinct vector ids touched since the last newQuery().
let distCount = 0;
let uniqueCount = 0;
const seen = new Uint32Array(N);
let seenStamp = 0;
function newQuery() {
  seenStamp++;
  if (seenStamp === 0xFFFFFFFF) { seen.fill(0); seenStamp = 1; }
  uniqueCount = 0;
}
function dist(a, ao, id) {
  distCount++;
  if (seen[id] !== seenStamp) { seen[id] = seenStamp; uniqueCount++; }
  const bo = id * D;
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
  for (let k = 0; k < D; k += 4) {
    const t0 = a[ao + k] - data[bo + k];
    const t1 = a[ao + k + 1] - data[bo + k + 1];
    const t2 = a[ao + k + 2] - data[bo + k + 2];
    const t3 = a[ao + k + 3] - data[bo + k + 3];
    s0 += t0 * t0; s1 += t1 * t1; s2 += t2 * t2; s3 += t3 * t3;
  }
  return s0 + s1 + s2 + s3;
}

// ---------- binary min-heap on key ----------
class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  topKey() { return this.k[0]; }
  topVal() { return this.v[0]; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v;
    const top = v[0];
    const lk = k.pop(), lv = v.pop();
    const n = k.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const m = r < n && k[r] < k[l] ? r : l;
        if (k[m] >= lk) break;
        k[i] = k[m]; v[i] = v[m]; i = m;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

// ---------- HNSW ----------
const links = new Array(N); // links[node][layer] = array of node ids
const levels = new Int32Array(N);
const visited = new Uint32Array(N);
let stamp = 0;
let entry = -1;
let maxLevel = -1;
const mL = 1 / Math.log(M);

function searchLayer(q, qo, eps, ef, layer) {
  stamp++;
  if (stamp === 0xFFFFFFFF) { visited.fill(0); stamp = 1; }
  const cand = new Heap(); // closest first
  const res = new Heap();  // keys are -dist, so the worst result is on top
  for (const e of eps) {
    if (visited[e] === stamp) continue;
    visited[e] = stamp;
    const d = dist(q, qo, e);
    cand.push(d, e); res.push(-d, e);
  }
  while (res.size > ef) res.pop();
  while (cand.size) {
    if (res.size >= ef && cand.topKey() > -res.topKey()) break;
    const c = cand.pop();
    const nb = links[c][layer];
    for (let j = 0; j < nb.length; j++) {
      const n = nb[j];
      if (visited[n] === stamp) continue;
      visited[n] = stamp;
      const d = dist(q, qo, n);
      if (res.size < ef || d < -res.topKey()) {
        cand.push(d, n); res.push(-d, n);
        if (res.size > ef) res.pop();
      }
    }
  }
  const out = new Array(res.size);
  for (let i = out.length - 1; i >= 0; i--) { out[i] = [-res.topKey(), res.topVal()]; res.pop(); }
  return out; // [[dist, id], ...] closest first
}

// Keep a candidate only if it is closer to the new node than to any neighbour already kept
// (spreads links in different directions), then top up with the closest skipped ones.
function selectNeighbors(W, m) {
  const sel = [], skipped = [];
  for (const [d, c] of W) {
    if (sel.length >= m) break;
    let good = true;
    for (const s of sel) { if (dist(data, c * D, s) < d) { good = false; break; } }
    if (good) sel.push(c); else skipped.push(c);
  }
  for (let j = 0; sel.length < m && j < skipped.length; j++) sel.push(skipped[j]);
  return sel;
}

function prune(n, layer, mmax) {
  const ln = links[n][layer];
  const scored = ln.map((x) => [dist(data, n * D, x), x]);
  scored.sort((a, b) => a[0] - b[0]);
  links[n][layer] = scored.slice(0, mmax).map((x) => x[1]);
}

function insert(i) {
  const lvl = Math.floor(-Math.log(1 - levelRand()) * mL);
  levels[i] = lvl;
  links[i] = Array.from({ length: lvl + 1 }, () => []);
  if (entry < 0) { entry = i; maxLevel = lvl; return; }
  const qo = i * D;
  let ep = entry;
  for (let l = maxLevel; l > lvl; l--) ep = searchLayer(data, qo, [ep], 1, l)[0][1];
  let eps = [ep];
  for (let l = Math.min(lvl, maxLevel); l >= 0; l--) {
    const W = searchLayer(data, qo, eps, EF_C, l);
    const sel = selectNeighbors(W, M);
    links[i][l] = sel;
    const mmax = l === 0 ? M0 : M;
    for (const n of sel) {
      links[n][l].push(i);
      if (links[n][l].length > mmax) prune(n, l, mmax);
    }
    eps = W.map((x) => x[1]);
  }
  if (lvl > maxLevel) { maxLevel = lvl; entry = i; }
}

function hnswSearch(q, qo, ef) {
  let ep = entry;
  for (let l = maxLevel; l > 0; l--) ep = searchLayer(q, qo, [ep], 1, l)[0][1];
  return searchLayer(q, qo, [ep], Math.max(ef, K), 0).slice(0, K).map((x) => x[1]);
}

// ---------- exact full scan ----------
function bruteTopK(q, qo) {
  const bd = new Float64Array(K).fill(Infinity);
  const bi = new Int32Array(K).fill(-1);
  for (let i = 0; i < N; i++) {
    const d = dist(q, qo, i);
    if (d < bd[K - 1]) {
      let j = K - 1;
      while (j > 0 && bd[j - 1] > d) { bd[j] = bd[j - 1]; bi[j] = bi[j - 1]; j--; }
      bd[j] = d; bi[j] = i;
    }
  }
  return Array.from(bi);
}

function stats(times) {
  const s = [...times].sort((a, b) => a - b);
  const avg = s.reduce((a, b) => a + b, 0) / s.length;
  const p95 = s[Math.ceil(0.95 * s.length) - 1];
  return { avg, p95 };
}

const r = (x, dp = 2) => Number(x.toFixed(dp));

// ---------- main run: every stage checks the whole-run deadline ----------
let buildMs = 0, buildDistances = 0, brute = null, bruteEvals = 0, bruteUnique = 0;
const truth = [];
const sweep = [];
try {
  stage = 'generate data';
  for (let i = 0; i < N; i++) { if ((i & 1023) === 0) checkDeadline(); makePoint(data, i * D); }
  for (let i = 0; i < Q + WARMUP; i++) makePoint(queries, i * D);

  stage = 'build index';
  const tBuild0 = performance.now();
  for (let i = 0; i < N; i++) { if ((i & 63) === 0) checkDeadline(); insert(i); }
  buildMs = performance.now() - tBuild0;
  buildDistances = distCount;

  stage = 'warm up';
  for (let w = 0; w < WARMUP; w++) {
    checkDeadline();
    const qo = (Q + w) * D;
    newQuery(); bruteTopK(queries, qo);
    newQuery(); hnswSearch(queries, qo, 40);
  }

  stage = 'full scan';
  const bruteTimes = [];
  distCount = 0;
  let uniq = 0;
  for (let qi = 0; qi < Q; qi++) {
    checkDeadline();
    newQuery();
    const t = performance.now();
    truth.push(bruteTopK(queries, qi * D));
    bruteTimes.push(performance.now() - t);
    uniq += uniqueCount;
  }
  bruteEvals = distCount / Q;
  bruteUnique = uniq / Q;
  brute = stats(bruteTimes);

  stage = 'HNSW efSearch sweep';
  for (const ef of EF_SWEEP) {
    const times = [];
    let hits = 0;
    uniq = 0;
    distCount = 0;
    for (let qi = 0; qi < Q; qi++) {
      checkDeadline();
      newQuery();
      const t = performance.now();
      const got = hnswSearch(queries, qi * D, ef);
      times.push(performance.now() - t);
      uniq += uniqueCount;
      const want = new Set(truth[qi]);
      for (const id of got) if (want.has(id)) hits++;
    }
    const st = stats(times);
    sweep.push({ ef, avg: st.avg, p95: st.p95, evals: distCount / Q, unique: uniq / Q, recall: hits / (Q * K) });
  }
} catch (e) {
  if (!(e instanceof DeadlineHit)) throw e;
  const elapsed = (performance.now() - T0) / 1000;
  console.log(`INCOMPLETE: the ${DEADLINE_MS / 1000} s run deadline was hit during "${e.message}". No benchmark result is claimed.`);
  console.log('RESULT ' + JSON.stringify({
    metrics: [
      { name: 'run completed', value: 0, unit: 'boolean' },
      { name: 'elapsed before stopping', value: r(elapsed, 1), unit: 's' },
      { name: 'efSearch settings finished', value: sweep.length, unit: 'settings' },
    ],
    conclusion: `The run did not finish: it stopped at the ${DEADLINE_MS / 1000} s deadline during "${e.message}", so no speed or recall claim is made.`,
    setup: `INCOMPLETE run; ${N} vectors x ${D} dims, ${Q} queries, deadline ${DEADLINE_MS / 1000} s, Node ${process.version}`,
  }));
  process.exit(1);
}

// ---------- memory: computed sizes, not measured from the JavaScript heap ----------
let totalLinks = 0;
for (let i = 0; i < N; i++) for (const l of links[i]) totalLinks += l.length;
const vectorMB = (N * D * 4) / 1e6;     // logical float32 bytes of the indexed vectors (= allocated array)
const linkMB = (totalLinks * 4) / 1e6;  // estimated payload if every link were an int32 id

// ---------- report ----------
const chosen = sweep.find((s) => s.recall >= TARGET_RECALL) ??
  sweep.reduce((a, b) => (b.recall > a.recall ? b : a));
const reached = chosen.recall >= TARGET_RECALL;
const speedup = brute.avg / chosen.avg;
const first = sweep[0], last = sweep[sweep.length - 1];
const totalS = (performance.now() - T0) / 1000;

console.log(`vectors: ${N} x ${D} dims, ${CLUSTERS} clusters, ${Q} queries, top-${K}`);
console.log(`HNSW build: ${r(buildMs / 1000, 1)} s, ${r(buildDistances / N, 0)} distance evaluations per inserted vector`);
console.log(`sizes (computed): vectors ${r(vectorMB, 2)} MB float32, links ~${r(linkMB, 2)} MB if stored as int32 ids`);
console.log('');
console.log('method     efSearch  avg ms   p95 ms   dist evals/q  unique vecs/q  recall@10');
console.log(`full scan  -         ${String(r(brute.avg, 3)).padEnd(8)} ${String(r(brute.p95, 3)).padEnd(8)} ${String(r(bruteEvals, 0)).padEnd(13)} ${String(r(bruteUnique, 0)).padEnd(14)} 1.000`);
for (const s of sweep) {
  console.log(`HNSW       ${String(s.ef).padEnd(9)} ${String(r(s.avg, 3)).padEnd(8)} ${String(r(s.p95, 3)).padEnd(8)} ${String(r(s.evals, 0)).padEnd(13)} ${String(r(s.unique, 0)).padEnd(14)} ${s.recall.toFixed(3)}`);
}
console.log(`total run time: ${r(totalS, 1)} s (deadline ${DEADLINE_MS / 1000} s)`);
console.log('');

const metrics = [
  { name: 'run completed', value: 1, unit: 'boolean' },
  { name: 'total run time', value: r(totalS, 1), unit: 's' },
  { name: 'vectors stored', value: N, unit: 'vectors' },
  { name: 'dimensions', value: D, unit: 'dims' },
  { name: 'HNSW build time', value: r(buildMs / 1000, 2), unit: 's' },
  { name: 'indexed vector data (computed float32 bytes)', value: r(vectorMB, 2), unit: 'MB' },
  { name: 'HNSW link payload (estimated as int32 ids, not measured heap)', value: r(linkMB, 2), unit: 'MB' },
  { name: 'full scan avg latency', value: r(brute.avg, 3), unit: 'ms' },
  { name: 'full scan p95 latency', value: r(brute.p95, 3), unit: 'ms' },
  { name: 'full scan distance evaluations per query', value: r(bruteEvals, 0), unit: 'evaluations' },
];
for (const s of sweep) {
  metrics.push({ name: `HNSW efSearch=${s.ef} avg latency`, value: r(s.avg, 3), unit: 'ms' });
  metrics.push({ name: `HNSW efSearch=${s.ef} p95 latency`, value: r(s.p95, 3), unit: 'ms' });
  metrics.push({ name: `HNSW efSearch=${s.ef} distance evaluations per query`, value: r(s.evals, 0), unit: 'evaluations' });
  metrics.push({ name: `HNSW efSearch=${s.ef} unique vectors touched per query`, value: r(s.unique, 0), unit: 'vectors' });
  metrics.push({ name: `HNSW efSearch=${s.ef} recall@10`, value: r(s.recall, 3), unit: 'fraction' });
}
metrics.push({ name: 'chosen efSearch', value: chosen.ef, unit: 'setting' });
metrics.push({ name: 'chosen setting reached target recall', value: reached ? 1 : 0, unit: 'boolean' });
metrics.push({ name: 'speedup vs full scan at chosen efSearch (avg latency ratio)', value: r(speedup, 2), unit: 'x' });
metrics.push({ name: 'share of distinct vectors touched at chosen efSearch', value: r((100 * chosen.unique) / N, 2), unit: '%' });

const speedWords = speedup >= 1.05
  ? `answered ${r(speedup, 1)}x faster than the full scan`
  : speedup > 0.95
    ? `took about the same time as the full scan (ratio ${r(speedup, 2)}x)`
    : `was slower than the full scan (ratio ${r(speedup, 2)}x)`;
const conclusion =
  `On ${N} synthetic vectors, HNSW at efSearch=${chosen.ef}` +
  (reached ? ` (lowest setting reaching recall ${TARGET_RECALL})` : ` (best recall; target ${TARGET_RECALL} not reached)`) +
  ` touched ${r(chosen.unique, 0)} distinct vectors (${r((100 * chosen.unique) / N, 1)}%) per query, ${speedWords}` +
  ` and found ${r(chosen.recall * 100, 1)}% of the true top-${K}; recall was ${r(first.recall * 100, 1)}% at efSearch=${first.ef}` +
  ` and ${r(last.recall * 100, 1)}% at efSearch=${last.ef}, after a ${r(buildMs / 1000, 1)} s index build.`;

const setup =
  `${N} synthetic clustered vectors (${CLUSTERS} clusters, ${D} dims, ${LATENT}-dim latent shape per cluster, seed ${SEED}); ` +
  `${Q} fresh queries from the same distribution (+${WARMUP} untimed warmup), top-${K}; teaching HNSW in JS, M=${M}, M0=${M0}, efConstruction=${EF_C}, ` +
  `efSearch sweep ${EF_SWEEP.join('/')}; target recall ${TARGET_RECALL}; single thread, Node ${process.version}; whole-run deadline ${DEADLINE_MS / 1000} s`;

console.log('RESULT ' + JSON.stringify({ metrics, conclusion, setup }));
