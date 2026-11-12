// ai-18 lab: 1,000 people ask AI at once. Who gets an answer first?
// Node.js 22, standard library only. No network, no child processes, writes only into this folder.
//
// Part A measures a tiny random-weight transformer on this machine:
//   A1  one answer generated with the KV cache on and off (warmed, equal repetitions, alternating order)
//   A2  uncached steps: one forward pass over the whole context, for context lengths 8..128
//   A3  prefill steps: B prompts of P tokens each, B in {1,4,16}, P in {8,16,32}
//   A4  decode steps with the cache: B rows at cached context c, B in {1,4,16}, c in {8..127}
// Part B replays a queue of 1,000 requests using ONLY those measured step costs (interpolated
// inside the measured grid, never extrapolated) under four serving policies.

import os from 'node:os';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED = 18;
const T0 = performance.now();
const now = () => performance.now();
const elapsed = () => now() - T0;
const MEASURE_BUDGET_MS = 40_000; // stop adding repetitions after this; reserve the rest for reporting

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
const sum = (a) => a.reduce((x, y) => x + y, 0);
const rnd = (x, d = 3) => Number(x.toFixed(d));
const cpuName = os.cpus()[0]?.model ?? 'unknown CPU';
function assertTiming(label, v) {
  if (!Number.isFinite(v) || v <= 0) throw new Error(`invalid timing for ${label}: ${v}`);
}

// Everything below runs inside one try block, so a failed check (different tokens, a bad timing,
// a cost outside the measured grid) still ends the run with exactly one RESULT line saying so.
try {

// ---------------------------------------------------------------------------
// The model: a tiny decoder-only transformer (GPT-style shape, random weights)
// ---------------------------------------------------------------------------
const D = 128, H = 4, HD = D / H, NL = 2, F = 512, V = 1024, MAXCTX = 128;
const MAXROWS = 512; // largest forward pass: 16 prompts x 32 tokens
const MAXOUT = 16;   // most rows that need next-token logits in one pass
const wr = mulberry32(SEED);
const randArr = (n, scale) => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = (wr() * 2 - 1) * scale; return a; };

// Weights are stored output-major: W[j * inD + k]; one weight row is reused for 4 input rows.
const W = { tok: randArr(V * D, 0.1), pos: randArr(MAXCTX * D, 0.02), layers: [] };
for (let l = 0; l < NL; l++) {
  W.layers.push({
    qkv: randArr(3 * D * D, 1 / Math.sqrt(D)),
    o: randArr(D * D, 1 / Math.sqrt(D)),
    up: randArr(F * D, 1 / Math.sqrt(D)),
    down: randArr(D * F, 1 / Math.sqrt(F)),
  });
}

function matmul(X, rows, Wt, inD, outD, Y) {
  let b = 0;
  for (; b + 4 <= rows; b += 4) {
    const a0 = b * inD, a1 = a0 + inD, a2 = a1 + inD, a3 = a2 + inD;
    const y0 = b * outD, y1 = y0 + outD, y2 = y1 + outD, y3 = y2 + outD;
    for (let j = 0; j < outD; j++) {
      const wo = j * inD;
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      for (let k = 0; k < inD; k++) {
        const w = Wt[wo + k];
        s0 += X[a0 + k] * w; s1 += X[a1 + k] * w; s2 += X[a2 + k] * w; s3 += X[a3 + k] * w;
      }
      Y[y0 + j] = s0; Y[y1 + j] = s1; Y[y2 + j] = s2; Y[y3 + j] = s3;
    }
  }
  for (; b < rows; b++) {
    const a0 = b * inD, y0 = b * outD;
    for (let j = 0; j < outD; j++) {
      const wo = j * inD;
      let s0 = 0;
      for (let k = 0; k < inD; k++) s0 += X[a0 + k] * Wt[wo + k];
      Y[y0 + j] = s0;
    }
  }
}

function layerNorm(src, dst, rows) {
  for (let i = 0; i < rows; i++) {
    const o = i * D;
    let m = 0; for (let d = 0; d < D; d++) m += src[o + d]; m /= D;
    let v = 0; for (let d = 0; d < D; d++) { const z = src[o + d] - m; v += z * z; } v /= D;
    const inv = 1 / Math.sqrt(v + 1e-5);
    for (let d = 0; d < D; d++) dst[o + d] = (src[o + d] - m) * inv;
  }
}

const buf = {
  h: new Float32Array(MAXROWS * D), x: new Float32Array(MAXROWS * D), qkv: new Float32Array(MAXROWS * 3 * D),
  att: new Float32Array(MAXROWS * D), tmp: new Float32Array(MAXROWS * D), ff: new Float32Array(MAXROWS * F),
  scores: new Float32Array(MAXCTX), sel: new Float32Array(MAXOUT * D), lg: new Float32Array(MAXOUT * V),
};
const makeSeq = () => ({ k: Array.from({ length: NL }, () => new Float32Array(MAXCTX * D)), v: Array.from({ length: NL }, () => new Float32Array(MAXCTX * D)) });

// rows: [{seq, pos, tok, out}]. Writes K and V for each row into its sequence cache at `pos`, attends
// over positions 0..pos of that sequence, and returns the next token for every row with out = true.
function forward(rows) {
  const n = rows.length, { h, x, qkv, att, tmp, ff, scores } = buf;
  if (n > MAXROWS) throw new Error(`forward pass of ${n} rows exceeds ${MAXROWS}`);
  for (let i = 0; i < n; i++) {
    const { pos, tok } = rows[i];
    for (let d = 0; d < D; d++) h[i * D + d] = W.tok[tok * D + d] + W.pos[pos * D + d];
  }
  const scale = 1 / Math.sqrt(HD);
  for (let l = 0; l < NL; l++) {
    const L = W.layers[l];
    layerNorm(h, x, n);
    matmul(x, n, L.qkv, D, 3 * D, qkv);
    for (let i = 0; i < n; i++) {
      const { seq, pos } = rows[i], K = seq.k[l], Vv = seq.v[l], b = i * 3 * D;
      for (let d = 0; d < D; d++) { K[pos * D + d] = qkv[b + D + d]; Vv[pos * D + d] = qkv[b + 2 * D + d]; }
    }
    for (let i = 0; i < n; i++) {
      const { seq, pos } = rows[i], K = seq.k[l], Vv = seq.v[l], b = i * 3 * D;
      for (let hh = 0; hh < H; hh++) {
        const qo = b + hh * HD, ho = hh * HD;
        let mx = -Infinity;
        for (let t = 0; t <= pos; t++) {
          let s = 0; const ko = t * D + ho;
          for (let e = 0; e < HD; e++) s += qkv[qo + e] * K[ko + e];
          s *= scale; scores[t] = s; if (s > mx) mx = s;
        }
        let z = 0;
        for (let t = 0; t <= pos; t++) { const p = Math.exp(scores[t] - mx); scores[t] = p; z += p; }
        const ao = i * D + ho;
        for (let e = 0; e < HD; e++) att[ao + e] = 0;
        for (let t = 0; t <= pos; t++) {
          const p = scores[t] / z, vo = t * D + ho;
          for (let e = 0; e < HD; e++) att[ao + e] += p * Vv[vo + e];
        }
      }
    }
    matmul(att, n, L.o, D, D, tmp);
    for (let i = 0; i < n * D; i++) h[i] += tmp[i];
    layerNorm(h, x, n);
    matmul(x, n, L.up, D, F, ff);
    for (let i = 0; i < n * F; i++) { const z = ff[i]; ff[i] = 0.5 * z * (1 + Math.tanh(0.7978845608 * (z + 0.044715 * z * z * z))); }
    matmul(ff, n, L.down, F, D, tmp);
    for (let i = 0; i < n * D; i++) h[i] += tmp[i];
  }
  layerNorm(h, x, n);
  let m = 0;
  for (let i = 0; i < n; i++) if (rows[i].out) {
    if (m >= MAXOUT) throw new Error('too many output rows');
    buf.sel.set(x.subarray(i * D, (i + 1) * D), m * D); m++;
  }
  matmul(buf.sel, m, W.tok, D, V, buf.lg); // tied embedding as the output layer
  const out = [];
  for (let r = 0; r < m; r++) {
    let best = 0, bv = -Infinity;
    for (let j = 0; j < V; j++) { const v = buf.lg[r * V + j]; if (v > bv) { bv = v; best = j; } }
    out.push(best);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Part A: measurements
// ---------------------------------------------------------------------------
const PROMPT_LEN = 16, GEN = 48;
const prompt = Array.from({ length: PROMPT_LEN }, () => Math.floor(wr() * V));
const promptPool = Array.from({ length: 16 * MAXCTX }, () => Math.floor(wr() * V));

// A1, cache ON: process the prompt once, then each new token is one row that reads the cache.
function genCached() {
  const seq = makeSeq(), toks = [];
  const t0 = now();
  let next = forward(prompt.map((tok, pos) => ({ seq, pos, tok, out: pos === PROMPT_LEN - 1 })))[0];
  toks.push(next);
  for (let i = 1; i < GEN; i++) {
    next = forward([{ seq, pos: PROMPT_LEN + i - 1, tok: next, out: true }])[0];
    toks.push(next);
  }
  return { ms: now() - t0, toks };
}
// A1, cache OFF: every new token recomputes K and V for the whole prompt + answer so far.
function genUncached() {
  const seq = makeSeq(), toks = [], all = [...prompt];
  const t0 = now();
  for (let i = 0; i < GEN; i++) {
    const n = all.length;
    const next = forward(all.map((tok, pos) => ({ seq, pos, tok, out: pos === n - 1 })))[0];
    toks.push(next); all.push(next);
  }
  return { ms: now() - t0, toks };
}

// Grids. Every cost the queue uses is interpolated inside these points.
const NS = [8, 16, 32, 64, 96, 128];            // A2 uncached context lengths (batch 1)
const PB = [1, 4, 16], PP = [8, 16, 32];         // A3 prefill: batch sizes x prompt lengths
const DB = [1, 4, 16], DC = [8, 32, 64, 127];    // A4 decode: batch sizes x cached context
const DECODE_INNER = 10;                         // decode steps are short: time 10 and divide

const prefillSeqs = Array.from({ length: 16 }, makeSeq);
const decodeSeqs = Array.from({ length: 16 }, () => {
  const s = makeSeq();
  for (let l = 0; l < NL; l++) for (let i = 0; i < MAXCTX * D; i++) { s.k[l][i] = (wr() * 2 - 1) * 0.5; s.v[l][i] = (wr() * 2 - 1) * 0.5; }
  return s;
});
const prefillRows = (B, P) => {
  const rows = [];
  for (let b = 0; b < B; b++) for (let p = 0; p < P; p++) rows.push({ seq: prefillSeqs[b], pos: p, tok: promptPool[b * MAXCTX + p], out: p === P - 1 });
  return rows;
};
const decodeRows = (B, c) => Array.from({ length: B }, (_, b) => ({ seq: decodeSeqs[b], pos: c, tok: (b * 37 + c) % V, out: true }));
const timeOnce = (fn) => { const t0 = now(); fn(); return now() - t0; };

// Work per pass, in transformer rows, to size the number of repetitions to the time budget.
const rowsA1 = PROMPT_LEN + (GEN - 1) + sum(Array.from({ length: GEN }, (_, i) => PROMPT_LEN + i));
const rowsPass = rowsA1 + sum(NS) + sum(PB.filter((b) => b > 1).flatMap((b) => PP.map((p) => b * p))) +
  2 * DECODE_INNER * sum(DB) * DC.length; // decode rows are less efficient; count them double

// Calibrate: warm the code path, then time a 128-row pass to estimate ms per row.
forward(prefillRows(4, 32)); forward(prefillRows(4, 32));
const msPerRow = timeOnce(() => forward(prefillRows(4, 32))) / 128;
assertTiming('calibration', msPerRow);
const estPassMs = rowsPass * msPerRow * 1.25;
const REPS = Math.max(1, Math.min(5, Math.floor((MEASURE_BUDGET_MS - elapsed()) / estPassMs) - 1));

const S = {
  on: [], off: [], toks: [],
  unc: NS.map(() => []),
  pre: PB.map(() => PP.map(() => [])),
  dec: DB.map(() => DC.map(() => [])),
};
let measuredPasses = 0, budgetCut = false;
for (let pass = 0; pass <= REPS; pass++) {          // pass 0 is the warm-up for every path
  if (pass >= 2 && elapsed() > MEASURE_BUDGET_MS) { budgetCut = true; break; }
  const rec = pass > 0;
  const order = pass % 2 ? ['on', 'off'] : ['off', 'on']; // alternate which path runs first
  for (const k of order) {
    const r = k === 'on' ? genCached() : genUncached();
    S.toks.push(r.toks);
    if (rec) S[k].push(r.ms);
  }
  NS.forEach((n, i) => { const ms = timeOnce(() => forward(prefillRows(1, n))); if (rec) S.unc[i].push(ms); });
  PB.forEach((B, bi) => PP.forEach((P, pi) => {
    if (B === 1) return; // batch 1 prefill is the same pass as an uncached step; taken from A2
    const ms = timeOnce(() => forward(prefillRows(B, P)));
    if (rec) S.pre[bi][pi].push(ms);
  }));
  DB.forEach((B, bi) => DC.forEach((c, ci) => {
    const rows = decodeRows(B, c);
    const ms = timeOnce(() => { for (let r = 0; r < DECODE_INNER; r++) forward(rows); }) / DECODE_INNER;
    if (rec) S.dec[bi][ci].push(ms);
  }));
  if (rec) measuredPasses++;
}
const T_MEASURE = elapsed();

// Validation: identical tokens in every run of both paths, finite positive timings.
const ref = S.toks[0].join(',');
const sameTokens = S.toks.every((t) => t.join(',') === ref);
if (!sameTokens) throw new Error('cache-on and cache-off produced different tokens; comparison rejected');
if (S.on.length !== S.off.length || S.on.length < 1) throw new Error('unequal repetitions for cache on and off');
[...S.on, ...S.off].forEach((v, i) => assertTiming(`A1 run ${i}`, v));

const uncMs = NS.map((n, i) => { const v = median(S.unc[i]); assertTiming(`uncached n=${n}`, v); return v; });
const preTotal = PB.map((B, bi) => PP.map((P, pi) => {
  const v = B === 1 ? uncMs[NS.indexOf(P)] : median(S.pre[bi][pi]);
  assertTiming(`prefill B=${B} P=${P}`, v); return v;
}));
const decTotal = DB.map((B, bi) => DC.map((c, ci) => { const v = median(S.dec[bi][ci]); assertTiming(`decode B=${B} c=${c}`, v); return v; }));

// Interpolation strictly inside the measured grid (throws instead of extrapolating).
function interp1(xs, ys, x) {
  if (!(x >= xs[0] && x <= xs[xs.length - 1])) throw new RangeError(`${x} outside measured range ${xs[0]}..${xs[xs.length - 1]}`);
  for (let i = 1; i < xs.length; i++) if (x <= xs[i]) { const f = (x - xs[i - 1]) / (xs[i] - xs[i - 1]); return ys[i - 1] + f * (ys[i] - ys[i - 1]); }
  return ys[ys.length - 1];
}
const interp2 = (bs, xs, Z, b, x) => interp1(bs, bs.map((_, i) => interp1(xs, Z[i], x)), b);
const prePerPrompt = PB.map((B, bi) => preTotal[bi].map((v) => v / B));
const decPerRow = DB.map((B, bi) => decTotal[bi].map((v) => v / B));
const uncachedStep = (n) => interp1(NS, uncMs, n);               // full recompute over n tokens
const prefillCost = (B, P) => interp2(PB, PP, prePerPrompt, B, P); // one prompt's share of a B-prompt prefill
const decodeCost = (B, c) => interp2(DB, DC, decPerRow, B, c);     // one row's share of a B-row decode step

// ---------------------------------------------------------------------------
// Part B: 1,000 requests arrive at t = 0. Four ways to serve them.
// ---------------------------------------------------------------------------
const N = 1000, SLOTS = 16;
const qr = mulberry32(SEED + 1000);
const reqs = Array.from({ length: N }, () => ({ P: 8 + Math.floor(qr() * 25), L: 16 + Math.floor(qr() * 81) }));
const totalTokens = sum(reqs.map((r) => r.L));

function seqNoCache() { // baseline: one person at a time, every token recomputes the whole context
  const ttft = [], fin = []; let t = 0;
  for (const r of reqs) {
    t += uncachedStep(r.P); ttft.push(t);
    for (let j = 1; j < r.L; j++) t += uncachedStep(r.P + j);
    fin.push(t);
  }
  return { ttft, fin, makespan: t };
}
function seqCache() { // one person at a time with the KV cache
  const ttft = [], fin = []; let t = 0;
  for (const r of reqs) {
    t += prefillCost(1, r.P); ttft.push(t);
    for (let j = 1; j < r.L; j++) t += decodeCost(1, r.P + j - 1);
    fin.push(t);
  }
  return { ttft, fin, makespan: t };
}
function staticBatches() { // groups of SLOTS run together until the longest answer is done
  const ttft = [], fin = []; let t = 0;
  for (let s = 0; s < N; s += SLOTS) {
    const g = reqs.slice(s, s + SLOTS), n = g.length;
    t += sum(g.map((r) => prefillCost(n, r.P)));
    g.forEach(() => ttft.push(t));
    const done = new Array(n);
    const Lmax = Math.max(...g.map((r) => r.L));
    for (let k = 1; k < Lmax; k++) {
      t += sum(g.map((r) => decodeCost(n, r.P + k - 1))); // finished rows still ride along (padding)
      g.forEach((r, i) => { if (r.L - 1 === k) done[i] = t; });
    }
    fin.push(...done);
  }
  return { ttft, fin, makespan: t };
}
function continuous() { // a freed slot is refilled at once; new prompts get a prefill step first
  const ttft = new Array(N), fin = new Array(N); let t = 0, next = 0, active = [];
  while (next < N || active.length) {
    if (active.length < SLOTS && next < N) {
      const admit = [];
      while (active.length + admit.length < SLOTS && next < N) admit.push(next++);
      t += sum(admit.map((i) => prefillCost(admit.length, reqs[i].P)));
      for (const i of admit) { ttft[i] = t; active.push({ i, ctx: reqs[i].P, rem: reqs[i].L - 1 }); }
    }
    const A = active.length;
    t += sum(active.map((a) => decodeCost(A, a.ctx)));
    const still = [];
    for (const a of active) { a.ctx++; a.rem--; if (a.rem === 0) fin[a.i] = t; else still.push(a); }
    active = still;
  }
  return { ttft, fin, makespan: t };
}

const POLICIES = [
  ['one at a time, no KV cache', seqNoCache],
  ['one at a time, KV cache', seqCache],
  [`static batches of ${SLOTS}, KV cache`, staticBatches],
  [`continuous batching (${SLOTS} slots), KV cache`, continuous],
];
const runs = POLICIES.map(([name, fn]) => ({ name, ...fn() }));
const summary = (r) => ({
  medianTTFT: median(r.ttft) / 1000, p95TTFT: pct(r.ttft, 95) / 1000, lastTTFT: Math.max(...r.ttft) / 1000,
  makespan: r.makespan / 1000, tps: totalTokens / (r.makespan / 1000),
});
const SM = runs.map(summary);
SM.forEach((s, i) => Object.entries(s).forEach(([k, v]) => assertTiming(`${POLICIES[i][0]} ${k}`, v)));

// ---------------------------------------------------------------------------
// Outputs: chart.svg (first word time for each person) and ttft.csv
// ---------------------------------------------------------------------------
const COLORS = ['#c2410c', '#a16207', '#64748b', '#2563eb'];
function chart() {
  const Wd = 900, Ht = 600, x0 = 90, pw = 760, ph = 420, top = 90;
  const all = runs.flatMap((r) => r.ttft.map((v) => v / 1000));
  const lo = Math.floor(Math.log10(Math.max(1e-4, Math.min(...all)))), hi = Math.ceil(Math.log10(Math.max(...all)));
  const y = (s) => top + ph - ((Math.log10(Math.max(s, 10 ** lo)) - lo) / Math.max(1, hi - lo)) * ph;
  const x = (i) => x0 + (i / (N - 1)) * pw;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Wd}" height="${Ht}" font-family="Inter, Helvetica, Arial, sans-serif" font-size="13">`;
  svg += `<rect width="${Wd}" height="${Ht}" fill="#ffffff"/>`;
  svg += `<text x="40" y="36" font-size="20" font-weight="700" fill="#0f172a">When did each of 1,000 people get their first word?</text>`;
  svg += `<text x="40" y="58" fill="#475569">Queue replayed on step times measured from a tiny toy model on one CPU core (seed ${SEED}). Shape only, not server numbers.</text>`;
  for (let e = lo; e <= hi; e++) {
    svg += `<line x1="${x0}" x2="${x0 + pw}" y1="${y(10 ** e)}" y2="${y(10 ** e)}" stroke="#e2e8f0"/>`;
    svg += `<text x="${x0 - 8}" y="${y(10 ** e) + 4}" text-anchor="end" fill="#64748b">${10 ** e >= 1 ? 10 ** e : (10 ** e).toPrecision(1)}s</text>`;
  }
  svg += `<text x="${x0 + pw / 2}" y="${top + ph + 34}" text-anchor="middle" fill="#64748b">person 1 to 1,000 (arrival order)</text>`;
  runs.forEach((r, ri) => {
    const pts = r.ttft.map((v, i) => `${x(i).toFixed(1)},${y(v / 1000).toFixed(1)}`).join(' ');
    svg += `<polyline points="${pts}" fill="none" stroke="${COLORS[ri]}" stroke-width="2"/>`;
    svg += `<rect x="${x0 + 10}" y="${top + 8 + ri * 20}" width="12" height="12" fill="${COLORS[ri]}"/><text x="${x0 + 28}" y="${top + 19 + ri * 20}" fill="#0f172a">${r.name}</text>`;
  });
  return svg + '</svg>';
}
writeFileSync(join(HERE, 'chart.svg'), chart());
const csv = [['person', 'prompt_tokens', 'answer_tokens', ...runs.map((r) => `ttft_s ${r.name}`)].map((h) => `"${h}"`).join(',')];
for (let i = 0; i < N; i++) csv.push([i + 1, reqs[i].P, reqs[i].L, ...runs.map((r) => rnd(r.ttft[i] / 1000, 5))].join(','));
writeFileSync(join(HERE, 'ttft.csv'), csv.join('\n') + '\n');

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const onMed = median(S.on), offMed = median(S.off);
const kvRatio = offMed / onMed;
const ci64 = DC.indexOf(64);
const tpsGain = (16 / decTotal[2][ci64]) / (1 / decTotal[0][ci64]);
const gainCombined = SM[0].medianTTFT / SM[3].medianTTFT;
const gainCacheOnly = SM[0].medianTTFT / SM[1].medianTTFT;
const gainBatchOnly = SM[1].medianTTFT / SM[3].medianTTFT;
const sooner = (r) => (r >= 1 ? `${r.toFixed(1)}x sooner` : `${(1 / r).toFixed(1)}x later`);
const faster = (r) => (r >= 1 ? `${r.toFixed(1)}x faster` : `${(1 / r).toFixed(1)}x slower`);

console.log(`Machine: ${cpuName}, ${os.cpus().length} cores, Node ${process.version}, one thread`);
console.log(`Model: random-weight decoder, d=${D}, heads=${H}, layers=${NL}, ffn=${F}, vocab=${V}`);
console.log(`Repetitions: 1 warm-up + ${measuredPasses} measured passes (planned ${REPS})${budgetCut ? ', cut short by the time budget' : ''}`);
console.log(`A1 ${GEN}-token answer, cache on : median ${onMed.toFixed(1)} ms (min ${Math.min(...S.on).toFixed(1)}, max ${Math.max(...S.on).toFixed(1)})`);
console.log(`A1 ${GEN}-token answer, cache off: median ${offMed.toFixed(1)} ms (min ${Math.min(...S.off).toFixed(1)}, max ${Math.max(...S.off).toFixed(1)})`);
console.log(`A1 same tokens in every run: ${sameTokens ? 'yes' : 'NO'}`);
console.log(`A2 uncached step (batch 1): ${NS.map((n, i) => `n=${n} ${uncMs[i].toFixed(2)} ms`).join(', ')}`);
PB.forEach((B, bi) => console.log(`A3 prefill, ${String(B).padStart(2)} prompts: ${PP.map((P, pi) => `P=${P} ${preTotal[bi][pi].toFixed(2)} ms`).join(', ')}`));
DB.forEach((B, bi) => console.log(`A4 decode, ${String(B).padStart(2)} rows: ${DC.map((c, ci) => `ctx=${c} ${decTotal[bi][ci].toFixed(3)} ms`).join(', ')}`));
console.log('\nQueue: 1,000 requests at t=0 (simulated time from the measured costs above)');
SM.forEach((s, i) => console.log(`  ${POLICIES[i][0].padEnd(42)} median first word ${s.medianTTFT.toFixed(2)} s, p95 ${s.p95TTFT.toFixed(2)} s, last ${s.lastTTFT.toFixed(2)} s, all done ${s.makespan.toFixed(1)} s, ${s.tps.toFixed(0)} tokens/s`));
console.log(`\nWrote chart.svg and ttft.csv. Measurement ${(T_MEASURE / 1000).toFixed(1)} s, total ${(elapsed() / 1000).toFixed(1)} s.`);

const conclusion =
  `On a tiny toy model on one CPU core, the KV cache finished a ${GEN}-token answer ${faster(kvRatio)} than recomputing, ` +
  `and when 1,000 people arrived at once the median person got their first word ${sooner(gainCombined)} with the cache plus continuous batching ` +
  `than one at a time without the cache (${sooner(gainCacheOnly)} from the cache alone, ${sooner(gainBatchOnly)} from batching alone with the cache on).`;

const m = (name, value, unit) => ({ name, value: rnd(value, 4), unit });
const keys = ['seq_no_cache', 'seq_cache', `static_${SLOTS}`, `continuous_${SLOTS}`];
const metrics = [
  m('kv_off_vs_on_time_ratio', kvRatio, 'x'),
  m('kv_on_answer_ms_median', onMed, 'ms'), m('kv_on_answer_ms_min', Math.min(...S.on), 'ms'), m('kv_on_answer_ms_max', Math.max(...S.on), 'ms'),
  m('kv_off_answer_ms_median', offMed, 'ms'), m('kv_off_answer_ms_min', Math.min(...S.off), 'ms'), m('kv_off_answer_ms_max', Math.max(...S.off), 'ms'),
  m('measured_reps_per_path', measuredPasses, 'count'),
  m('same_tokens_cache_on_and_off', sameTokens ? 1 : 0, 'bool'),
  ...DB.map((B, bi) => m(`decode_step_b${B}_ctx64`, decTotal[bi][ci64], 'ms')),
  m('decode_throughput_gain_b16_vs_b1_ctx64', tpsGain, 'x'),
  ...keys.flatMap((k, i) => [
    m(`${k}_median_ttft`, SM[i].medianTTFT, 's'),
    m(`${k}_p95_ttft`, SM[i].p95TTFT, 's'),
    m(`${k}_all_done`, SM[i].makespan, 's'),
    m(`${k}_throughput`, SM[i].tps, 'tokens/s'),
  ]),
  m('median_ttft_gain_cache_plus_continuous_vs_seq_no_cache', gainCombined, 'x'),
  m('median_ttft_gain_cache_only', gainCacheOnly, 'x'),
  m('median_ttft_gain_continuous_vs_seq_with_cache', gainBatchOnly, 'x'),
  m('measurement_budget_cut', budgetCut ? 1 : 0, 'bool'),
  m('runtime', elapsed() / 1000, 's'),
];
const setup =
  `toy random-weight decoder d=${D} heads=${H} layers=${NL} ffn=${F} vocab=${V}; A1 prompt ${PROMPT_LEN} answer ${GEN}, ` +
  `1 warm-up + ${measuredPasses} alternating reps; grids uncached n=${NS.join('/')}, prefill B=${PB.join('/')} x P=${PP.join('/')}, ` +
  `decode B=${DB.join('/')} x ctx=${DC.join('/')} (medians, interpolation inside grid only); queue N=${N} all at t=0, ` +
  `prompts 8-32, answers 16-96 tokens, ${SLOTS} slots, prefill steps separate from decode steps; seed ${SEED}; ${cpuName}, Node ${process.version}, single thread`;

console.log('RESULT ' + JSON.stringify({ metrics, conclusion, setup }));
} catch (err) {
  console.log('RESULT ' + JSON.stringify({
    metrics: [{ name: 'run_rejected', value: 1, unit: 'bool' }, { name: 'runtime', value: rnd(elapsed() / 1000), unit: 's' }],
    conclusion: `Run rejected, no claim is made: ${err.message}.`,
    setup: `seed ${SEED}; ${cpuName}, Node ${process.version}`,
  }));
  process.exitCode = 1;
}
