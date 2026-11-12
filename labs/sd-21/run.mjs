// sd-21 lab: same data, same engine, two shapes.
// Normalized tables (users, products, orders joined by IDs) vs one JSON document per user
// that embeds the user's orders and copies of the product names. Both live in ONE in-memory
// SQLite database (node:sqlite), so only the data shape changes between the two runs.
//
// Node.js 22 ESM, standard library only. No network, no child processes.
// Writes one file next to this script: results.json (raw timing samples and checks).
//
// Time control: one global deadline for the whole run. Every unit of work (loading a size,
// one measured pair, a check) is estimated first and only started if twice the estimate fits
// in the time left. A synchronous SQLite call cannot be interrupted once started, so this is
// a careful guard, not a hard guarantee.

import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Buffer } from 'node:buffer';

const T_START = performance.now();

// ---------- parameters ----------
const SEED = 21;
const SIZES = [10_000, 100_000]; // users, run smallest first
const MAX_USERS = 100_000; // conservative dataset limit
const PRODUCTS = 1_000;
const ORDERS_PER_USER_MIN = 1;
const ORDERS_PER_USER_MAX = 9; // uniform 1..9, mean 5
const TARGET_PRODUCT = 1; // most popular product under the 1/rank popularity curve
const RENAME_NAMES = ['Renamed 0001', 'Product 0001']; // same length as the original name, alternated

const TOTAL_BUDGET_MS = 45_000; // whole run, leaves room under the 60 s limit
const FINAL_RESERVE_MS = 3_000; // kept back for writing results.json and printing
const SAFETY = 2; // start a unit only if SAFETY x its estimate fits in the time left
const WORKLOAD_SLICE_MS = 4_000; // soft time share per workload per size
const MAX_PAIRS = { profile: 300, report: 200, rename: 200 }; // measured pairs (one sample per shape each)
const PROFILE_BATCH = 20; // profile loads per sample, so each sample is well above timer resolution
const PROFILE_WARMUP = 20;
const MIN_SAMPLES_FOR_VERDICT = 3;
const TIE_RATIO = 1.1;
// a-priori cost guesses (ms per user), only used before anything has been measured; deliberately high
const APRIORI_MS_PER_USER = { load: 0.2, profilePair: 0.0005, reportPair: 0.04, renamePair: 0.06, check: 0.02 };

if (SIZES.some((n) => n > MAX_USERS)) throw new Error('size above MAX_USERS');
if (new Set(RENAME_NAMES.map((s) => s.length)).size !== 1) throw new Error('rename names must have equal length');

// ---------- helpers ----------
function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// nearest-rank percentile on a sorted array
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

const fmt = (x) => (x === null || x === undefined ? null : Number(x.toPrecision(4))); // display only
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

const deadline = T_START + TOTAL_BUDGET_MS - FINAL_RESERVE_MS;
const remainingMs = () => deadline - performance.now();
const fits = (estMs) => estMs * SAFETY <= remainingMs();

function measureTimerResolution() {
  let best = Infinity;
  for (let i = 0; i < 2000; i++) {
    const a = performance.now();
    let b = performance.now();
    while (b === a) b = performance.now();
    if (b - a < best) best = b - a;
  }
  return best;
}
const TIMER_RESOLUTION_MS = measureTimerResolution();
const TIMER_FLOOR_MS = TIMER_RESOLUTION_MS * 100; // a sample shorter than this has more than ~1% quantization error

function printResultAndExit(obj, code = 0) {
  process.stdout.write('RESULT ' + JSON.stringify(obj) + '\n');
  process.exit(code);
}

// ---------- engine ----------
let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  log('node:sqlite is not available. Use Node 22.13+ or run: node --experimental-sqlite run.mjs');
  printResultAndExit(
    {
      metrics: [],
      conclusion: 'Not run: node:sqlite is unavailable in this Node version, so no numbers were produced.',
      setup: `node ${process.version}`,
    },
    1,
  );
}

// Runs up to maxPairs measured pairs. Each pair measures both shapes once, alternating which goes
// first, so both shapes always get the same number of samples under the same conditions.
// runOne(shape, i) -> { ms, out }; afterPair(i, outs) runs checks outside the timed part.
function runPairs(label, est0, maxPairs, runOne, afterPair, extraReserveMs = () => 0) {
  const samples = { normalized: [], document: [] };
  const sliceEnd = performance.now() + WORKLOAD_SLICE_MS;
  let est = est0; // a-priori guess until the first pair has been measured
  let measuredMax = null;
  let stopReason = 'reached max samples';
  for (let i = 0; i < maxPairs; i++) {
    if (i > 0 && performance.now() + est * SAFETY > sliceEnd) { stopReason = 'workload time share used'; break; }
    if (!fits(est + extraReserveMs())) { stopReason = 'global time budget'; break; }
    const order = i % 2 === 0 ? ['normalized', 'document'] : ['document', 'normalized'];
    const outs = {};
    const t0 = performance.now();
    for (const shape of order) {
      const r = runOne(shape, i);
      samples[shape].push(r.ms);
      outs[shape] = r.out;
    }
    afterPair(i, outs);
    measuredMax = Math.max(measuredMax ?? 0, performance.now() - t0);
    est = measuredMax; // worst pair seen so far, checks included
  }
  log(`${label.padEnd(8)} ${samples.normalized.length} pairs (${stopReason})`);
  return { samples, pairs: samples.normalized.length, stopReason, maxPairMs: measuredMax ?? est0 };
}

function summarize(rawMs, opsPerSample) {
  const perOp = rawMs.map((x) => x / opsPerSample);
  const s = [...perOp].sort((a, b) => a - b);
  const n = s.length;
  const median = percentile(s, 50);
  return {
    n,
    opsPerSample,
    medianMs: median,
    q25Ms: percentile(s, 25),
    q75Ms: percentile(s, 75),
    minMs: n ? s[0] : null,
    maxMs: n ? s[n - 1] : null,
    p95Ms: n >= 20 ? percentile(s, 95) : null, // too few samples for a meaningful p95
    belowTimerFloor: n ? median * opsPerSample < TIMER_FLOOR_MS : null,
    floorPerOpMs: TIMER_FLOOR_MS / opsPerSample,
    samplesMs: perOp, // raw per-operation samples, full precision, in measurement order
  };
}

// ---------- one size ----------
function runSize(nUsers, prev) {
  log(`\n== ${nUsers.toLocaleString('en-US')} users ==`);
  const scale = prev ? nUsers / prev.users : null;
  const est = prev
    ? {
        load: prev.cost.loadMs * scale,
        profilePair: prev.cost.profilePairMs,
        reportPair: prev.cost.reportPairMs * scale,
        renamePair: prev.cost.renamePairMs * scale,
        check: prev.cost.checkMs * scale,
      }
    : Object.fromEntries(Object.entries(APRIORI_MS_PER_USER).map(([k, v]) => [k, v * nUsers]));
  const minCost = est.load + PROFILE_WARMUP * est.profilePair + est.profilePair + est.reportPair + est.renamePair + est.check;
  if (!fits(minCost)) {
    log(`skipped: needs about ${Math.round(minCost)} ms (x${SAFETY} safety), ${Math.round(remainingMs())} ms left`);
    return { users: nUsers, status: 'skipped', reason: `estimated minimum cost ${Math.round(minCost)} ms did not fit the time budget` };
  }

  const rng = mulberry32(SEED);
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE users    (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL);
    CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price_cents INTEGER NOT NULL);
    CREATE TABLE orders   (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
                           qty INTEGER NOT NULL, price_cents INTEGER NOT NULL, ordered_at INTEGER NOT NULL);
    CREATE TABLE user_docs (user_id INTEGER PRIMARY KEY, doc TEXT NOT NULL);
  `);

  // products with 1/rank popularity
  const products = [];
  for (let i = 1; i <= PRODUCTS; i++) {
    products.push({ id: i, name: `Product ${String(i).padStart(4, '0')}`, priceCents: 199 + Math.floor(rng() * 9800) });
  }
  const cum = [];
  let acc = 0;
  for (let i = 0; i < PRODUCTS; i++) {
    acc += 1 / (i + 1);
    cum.push(acc);
  }
  const pickProduct = () => {
    const x = rng() * acc;
    let lo = 0, hi = PRODUCTS - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return products[lo];
  };

  // load both shapes with the exact same generated data
  const t0 = performance.now();
  const insUser = db.prepare('INSERT INTO users VALUES (?, ?, ?)');
  const insProduct = db.prepare('INSERT INTO products VALUES (?, ?, ?)');
  const insOrder = db.prepare('INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?)');
  const insDoc = db.prepare('INSERT INTO user_docs VALUES (?, ?)');
  const epoch = Date.UTC(2026, 0, 1) / 1000;
  let orderId = 0;
  let docBytesTotal = 0;
  let targetLines = 0;
  let targetDocs = 0;
  db.exec('BEGIN');
  for (const p of products) insProduct.run(p.id, p.name, p.priceCents);
  for (let u = 1; u <= nUsers; u++) {
    const user = { id: u, name: `User ${u}`, email: `user${u}@example.test` };
    insUser.run(user.id, user.name, user.email);
    const n = ORDERS_PER_USER_MIN + Math.floor(rng() * (ORDERS_PER_USER_MAX - ORDERS_PER_USER_MIN + 1));
    const orders = [];
    let hasTarget = false;
    for (let k = 0; k < n; k++) {
      const p = pickProduct();
      const o = {
        id: ++orderId,
        productId: p.id,
        productName: p.name,
        qty: 1 + Math.floor(rng() * 3),
        priceCents: p.priceCents,
        orderedAt: epoch + Math.floor(rng() * 86400 * 300),
      };
      if (p.id === TARGET_PRODUCT) { targetLines++; hasTarget = true; }
      insOrder.run(o.id, u, o.productId, o.qty, o.priceCents, o.orderedAt);
      orders.push(o);
    }
    if (hasTarget) targetDocs++;
    const doc = JSON.stringify({ ...user, orders });
    docBytesTotal += Buffer.byteLength(doc);
    insDoc.run(u, doc);
  }
  db.exec('COMMIT');
  db.exec('CREATE INDEX orders_by_user ON orders(user_id)');
  const orderCount = orderId;
  const loadMs = performance.now() - t0;
  log(`loaded ${orderCount.toLocaleString('en-US')} order lines in ${Math.round(loadMs)} ms`);

  const checks = {};

  // ---------- workload 1: load one user's profile with all orders ----------
  const qProfile = db.prepare(`
    SELECT u.id AS uid, u.name AS uname, u.email AS email,
           o.id AS oid, o.product_id AS pid, p.name AS pname, o.qty AS qty,
           o.price_cents AS price, o.ordered_at AS ts
    FROM users u
    LEFT JOIN orders o ON o.user_id = u.id
    LEFT JOIN products p ON p.id = o.product_id
    WHERE u.id = ? ORDER BY o.id`);
  const loadNormalized = (id) => {
    const rows = qProfile.all(id);
    const r0 = rows[0];
    return {
      id: r0.uid,
      name: r0.uname,
      email: r0.email,
      orders: rows
        .filter((r) => r.oid !== null)
        .map((r) => ({ id: r.oid, productId: r.pid, productName: r.pname, qty: r.qty, priceCents: r.price, orderedAt: r.ts })),
    };
  };
  const qDoc = db.prepare('SELECT doc FROM user_docs WHERE user_id = ?');
  const loadDocument = (id) => JSON.parse(qDoc.get(id).doc);
  const loaders = { normalized: loadNormalized, document: loadDocument };

  const pickRng = mulberry32(SEED + 1);
  const pickUser = () => 1 + Math.floor(pickRng() * nUsers);
  let profileCost = est.profilePair;
  if (fits(PROFILE_WARMUP * profileCost)) {
    const tw = performance.now();
    for (let i = 0; i < PROFILE_WARMUP; i++) {
      const id = pickUser();
      loadNormalized(id);
      loadDocument(id);
    }
    profileCost = (performance.now() - tw) / PROFILE_WARMUP; // measured replaces the a-priori guess
  }
  // matched samples: sample i uses the same user IDs for both shapes
  const batches = [];
  const batchFor = (i) => {
    while (batches.length <= i) batches.push(Array.from({ length: PROFILE_BATCH }, pickUser));
    return batches[i];
  };
  let profilesCompared = 0, profileMismatches = 0, normOrderLinesSeen = 0;
  const w1 = runPairs(
    'profile',
    profileCost * PROFILE_BATCH,
    MAX_PAIRS.profile,
    (shape, i) => {
      const ids = batchFor(i);
      const fn = loaders[shape];
      const out = new Array(ids.length);
      const t = performance.now();
      for (let k = 0; k < ids.length; k++) out[k] = fn(ids[k]);
      return { ms: performance.now() - t, out };
    },
    (i, outs) => {
      for (let k = 0; k < outs.normalized.length; k++) {
        profilesCompared++;
        normOrderLinesSeen += outs.normalized[k].orders.length;
        if (JSON.stringify(outs.normalized[k]) !== JSON.stringify(outs.document[k])) profileMismatches++;
      }
    },
  );
  checks.profile = { ran: profilesCompared > 0, profilesCompared, mismatches: profileMismatches };
  const profile = {
    normalized: {
      ...summarize(w1.samples.normalized, PROFILE_BATCH),
      logicalRecordsPerCallEstimate: profilesCompared ? 1 + (2 * normOrderLinesSeen) / profilesCompared : null,
      note: 'logical estimate: 1 user row + each order row + its product row, not measured SQLite row accesses',
    },
    document: { ...summarize(w1.samples.document, PROFILE_BATCH), logicalRecordsPerCallEstimate: 1, note: 'logical estimate: one document' },
  };

  // ---------- workload 2: ad-hoc revenue per product across all users ----------
  const qReportNorm = db.prepare(`
    SELECT o.product_id AS pid, p.name AS name, SUM(o.qty * o.price_cents) AS revenue
    FROM orders o JOIN products p ON p.id = o.product_id
    GROUP BY o.product_id`);
  const qReportDoc = db.prepare(`
    SELECT json_extract(j.value, '$.productId') AS pid,
           json_extract(j.value, '$.productName') AS name,
           SUM(json_extract(j.value, '$.qty') * json_extract(j.value, '$.priceCents')) AS revenue
    FROM user_docs d, json_each(d.doc, '$.orders') j
    GROUP BY pid`);
  const reportQueries = { normalized: qReportNorm, document: qReportDoc };
  let reportPairsCompared = 0, reportProductMismatches = 0, reportCountMismatches = 0;
  const w2 = runPairs(
    'report',
    est.reportPair,
    MAX_PAIRS.report,
    (shape) => {
      const t = performance.now();
      const rows = reportQueries[shape].all();
      return { ms: performance.now() - t, out: rows };
    },
    (i, outs) => {
      reportPairsCompared++;
      const byPid = new Map(outs.normalized.map((r) => [Number(r.pid), r]));
      if (byPid.size !== outs.document.length) reportCountMismatches++;
      for (const d of outs.document) {
        const nRow = byPid.get(Number(d.pid));
        if (!nRow || Number(nRow.revenue) !== Number(d.revenue) || nRow.name !== d.name) reportProductMismatches++;
      }
    },
    () => est.check,
  );
  checks.report = {
    ran: reportPairsCompared > 0,
    pairsCompared: reportPairsCompared,
    productMismatches: reportProductMismatches,
    productCountMismatches: reportCountMismatches,
  };
  const report = {
    normalized: {
      ...summarize(w2.samples.normalized, 1),
      logicalRecordsReadEstimate: 2 * orderCount,
      note: 'logical estimate: every order row plus its product row, not measured SQLite row accesses',
    },
    document: {
      ...summarize(w2.samples.document, 1),
      logicalRecordsReadEstimate: nUsers,
      bytesParsed: docBytesTotal,
      note: 'logical estimate: every document parsed by json_each',
    },
  };

  // ---------- workload 3: rename one product that appears in many orders ----------
  const updProduct = db.prepare('UPDATE products SET name = ? WHERE id = ?');
  const renameNormalized = (newName) => {
    db.exec('BEGIN');
    const info = updProduct.run(newName, TARGET_PRODUCT);
    db.exec('COMMIT');
    // logical bytes of the rewritten row: id (8) + name + price (8)
    return { changes: Number(info.changes), bytes: 16 + Buffer.byteLength(newName) };
  };
  const qFind = db.prepare(`
    SELECT user_id, doc FROM user_docs d
    WHERE EXISTS (SELECT 1 FROM json_each(d.doc, '$.orders') j
                  WHERE json_extract(j.value, '$.productId') = ?)`);
  const updDoc = db.prepare('UPDATE user_docs SET doc = ? WHERE user_id = ?');
  const renameDocument = (newName) => {
    db.exec('BEGIN');
    let rewritten = 0, bytes = 0;
    for (const row of qFind.all(TARGET_PRODUCT)) {
      const d = JSON.parse(row.doc);
      for (const o of d.orders) if (o.productId === TARGET_PRODUCT) o.productName = newName;
      const s = JSON.stringify(d);
      updDoc.run(s, row.user_id);
      rewritten++;
      bytes += Buffer.byteLength(s);
    }
    db.exec('COMMIT');
    // no index on product inside the documents, so the query looks inside every document
    return { scanned: nUsers, rewritten, bytes };
  };
  const renamers = { normalized: renameNormalized, document: renameDocument };
  const staleCheckEst = () => Math.max(est.check, w2.maxPairMs / 2);
  let renamePairs = 0, renameCountMismatches = 0, lastRename = { normalized: null, document: null };
  const w3 = runPairs(
    'rename',
    est.renamePair,
    MAX_PAIRS.rename,
    (shape, i) => {
      const name = RENAME_NAMES[i % 2];
      const t = performance.now();
      const r = renamers[shape](name);
      return { ms: performance.now() - t, out: r };
    },
    (i, outs) => {
      renamePairs++;
      if (outs.normalized.changes !== 1 || outs.document.rewritten !== targetDocs) renameCountMismatches++;
      lastRename = outs;
    },
    staleCheckEst,
  );

  // after-rename checks: every copy must carry the final name
  let staleDoc = null, normNameOk = null, checkMs = 0;
  if (renamePairs > 0 && fits(staleCheckEst())) {
    const tc = performance.now();
    const finalName = RENAME_NAMES[(renamePairs - 1) % 2];
    staleDoc = Number(
      db.prepare(`
        SELECT COUNT(*) AS n FROM user_docs d, json_each(d.doc, '$.orders') j
        WHERE json_extract(j.value, '$.productId') = ? AND json_extract(j.value, '$.productName') <> ?`)
        .get(TARGET_PRODUCT, finalName).n,
    );
    normNameOk = db.prepare('SELECT name FROM products WHERE id = ?').get(TARGET_PRODUCT).name === finalName;
    checkMs = performance.now() - tc;
  }
  checks.rename = {
    ran: renamePairs > 0 && staleDoc !== null,
    pairs: renamePairs,
    countMismatches: renameCountMismatches,
    normalizedNameIsFinal: normNameOk,
    staleDocumentCopies: staleDoc,
  };
  const rename = {
    normalized: {
      ...summarize(w3.samples.normalized, 1),
      rowsWritten: lastRename.normalized?.changes ?? null,
      bytesWritten: lastRename.normalized?.bytes ?? null,
    },
    document: {
      ...summarize(w3.samples.document, 1),
      documentsScanned: lastRename.document?.scanned ?? null,
      documentsRewritten: lastRename.document?.rewritten ?? null,
      bytesWritten: lastRename.document?.bytes ?? null,
      note: 'documentsScanned is logical: with no index the find query looks inside every document',
    },
  };
  db.close();

  const failed =
    profileMismatches > 0 ||
    reportProductMismatches > 0 ||
    reportCountMismatches > 0 ||
    renameCountMismatches > 0 ||
    normNameOk === false ||
    (staleDoc !== null && staleDoc !== 0);
  const allRan = checks.profile.ran && checks.report.ran && checks.rename.ran;
  const status = failed ? 'validation failed' : allRan ? 'complete' : 'partial (time budget)';
  log(`checks ${status}`);

  return {
    users: nUsers,
    status,
    products: PRODUCTS,
    orderLines: orderCount,
    documentBytesTotal: docBytesTotal,
    targetProduct: { id: TARGET_PRODUCT, orderLines: targetLines, documentsContaining: targetDocs, shareOfOrderLines: targetLines / orderCount },
    workloads: { profile, report, rename },
    stopReasons: { profile: w1.stopReason, report: w2.stopReason, rename: w3.stopReason },
    checks,
    cost: {
      loadMs,
      profilePairMs: w1.maxPairMs / PROFILE_BATCH,
      reportPairMs: w2.maxPairMs,
      renamePairMs: w3.maxPairMs,
      checkMs: Math.max(checkMs, est.check),
    },
  };
}

// ---------- verdicts (full precision; rounding only in text) ----------
function verdict(n, d) {
  const med = `${fmt(n.medianMs)} vs ${fmt(d.medianMs)} ms median`;
  if (n.n === 0 || d.n === 0) return { winner: 'none', text: 'not measured within the time budget' };
  if (Math.min(n.n, d.n) < MIN_SAMPLES_FOR_VERDICT) {
    return { winner: 'none', text: `inconclusive with only ${Math.min(n.n, d.n)} samples (${med})` };
  }
  const normFaster = n.medianMs < d.medianMs;
  const [f, s] = normFaster ? [n, d] : [d, n];
  if (s.belowTimerFloor) return { winner: 'none', text: `inconclusive because both are below useful timer resolution (${med})` };
  const lowerBound = f.belowTimerFloor; // faster one too short to time well: ratio is only a lower bound
  const ratio = s.medianMs / (lowerBound ? f.floorPerOpMs : f.medianMs);
  if (ratio < TIE_RATIO) return lowerBound
    ? { winner: 'none', text: `inconclusive near timer resolution (${med})` }
    : { winner: 'tie', text: `about even (${med})` };
  if (!(f.q75Ms < s.q25Ms)) {
    return { winner: 'none', text: `inconclusive because the middle halves of the samples overlap (${med})` };
  }
  const winner = normFaster ? 'normalized' : 'document';
  const label = normFaster ? 'normalized tables' : 'one document per user';
  return {
    winner,
    ratio,
    text: `${lowerBound ? 'at least ' : ''}${ratio.toFixed(1)}x faster with ${label} (${med}, ${n.n} samples each)`,
  };
}

// ---------- run ----------
log(`timer resolution ${TIMER_RESOLUTION_MS} ms, floor ${TIMER_FLOOR_MS} ms per sample`);
const sizes = [];
let prev = null;
for (const n of SIZES) {
  const r = runSize(n, prev);
  sizes.push(r);
  if (r.status === 'skipped') break; // larger sizes cannot fit either
  if (r.status === 'complete') prev = r;
  else break; // partial or failed: do not scale up
}
for (const n of SIZES.slice(sizes.length)) sizes.push({ users: n, status: 'skipped', reason: 'a smaller size did not complete' });

const failedSizes = sizes.filter((s) => s.status === 'validation failed');
const complete = sizes.filter((s) => s.status === 'complete');
const big = complete[complete.length - 1] ?? null;
const elapsedS = (performance.now() - T_START) / 1000;

const setup =
  `node ${process.version}; one in-memory SQLite db (node:sqlite) holding both shapes; seed ${SEED}; ` +
  `users ${SIZES.join(' and ')} (${sizes.map((s) => `${s.users}: ${s.status}`).join(', ')}); ` +
  `${PRODUCTS} products with 1/rank popularity; ${ORDERS_PER_USER_MIN}-${ORDERS_PER_USER_MAX} order lines per user; ` +
  `interleaved pairs, order alternated, adaptive count up to ${MAX_PAIRS.profile}/${MAX_PAIRS.report}/${MAX_PAIRS.rename} ` +
  `(profile/report/rename) within a ${TOTAL_BUDGET_MS / 1000} s global budget; profile samples are batches of ${PROFILE_BATCH} same users per shape; ` +
  `rename target = most popular product, equal-length names alternated; timer floor ${fmt(TIMER_FLOOR_MS)} ms; ` +
  `bytes are logical content bytes, not disk pages; total ${elapsedS.toFixed(1)} s`;

writeFileSync(
  new URL('./results.json', import.meta.url),
  JSON.stringify({ generatedBy: 'labs/sd-21/run.mjs', setup, timerResolutionMs: TIMER_RESOLUTION_MS, timerFloorMs: TIMER_FLOOR_MS, sizes }, null, 2) + '\n',
);

// human-readable table (stdout), then the RESULT line last
console.log('\n users  workload  | normalized median ms | document median ms | samples');
for (const s of sizes) {
  if (!s.workloads) { console.log(`${String(s.users).padStart(6)}  ${s.status}`); continue; }
  for (const [k, v] of Object.entries(s.workloads)) {
    console.log(
      `${String(s.users).padStart(6)}  ${k.padEnd(8)}  | ${String(fmt(v.normalized.medianMs)).padStart(20)} | ${String(fmt(v.document.medianMs)).padStart(18)} | ${v.normalized.n}/${v.document.n}`,
    );
  }
  console.log(`        checks ${s.status}: ${JSON.stringify(s.checks)}`);
}

if (failedSizes.length > 0) {
  printResultAndExit(
    {
      metrics: [{ name: 'sizes_failing_validation', value: failedSizes.length, unit: 'sizes' }],
      conclusion:
        `Validation failed at ${failedSizes.map((s) => s.users.toLocaleString('en-US')).join(' and ')} users ` +
        '(the two shapes did not return the same data), so no timing comparison is reported.',
      setup,
    },
    1,
  );
}
if (!big) {
  printResultAndExit(
    {
      metrics: [],
      conclusion: 'Inconclusive: no size finished all three workloads and their checks within the time budget, so no comparison is reported.',
      setup,
    },
    2,
  );
}

const w = big.workloads;
const c1 = verdict(w.profile.normalized, w.profile.document);
const c2 = verdict(w.report.normalized, w.report.document);
const c3 = verdict(w.rename.normalized, w.rename.document);
const winners = new Set([c1.winner, c2.winner, c3.winner].filter((x) => x === 'normalized' || x === 'document'));
const docMB = (w.rename.document.bytesWritten / 1e6).toFixed(1);
const rewritten = w.rename.document.documentsRewritten.toLocaleString('en-US');
const ending =
  winners.size === 2
    ? 'so neither shape was faster in general and each won the access pattern it was shaped for'
    : winners.size === 1
      ? `so in this run only the ${[...winners][0]} shape won a workload`
      : 'so this run could not show a clear speed difference';
const skippedNote = big.users !== SIZES[SIZES.length - 1] ? ` (larger sizes were skipped to stay in the time budget)` : '';
const conclusion =
  `At ${big.users.toLocaleString('en-US')} users${skippedNote} on the same SQLite engine with all checks passing, ` +
  `loading one profile was ${c1.text}, the revenue report was ${c2.text}, and renaming one product was ${c3.text} ` +
  `while rewriting ${rewritten} of ${w.rename.document.documentsScanned.toLocaleString('en-US')} scanned documents (${docMB} MB) instead of 1 row, ${ending}.`;

// round only timings and fractions for display; counts stay exact
const m = (name, value, unit) => ({ name, value: unit === 'ms' || unit === 'fraction' ? fmt(value) : value, unit });
const metrics = [
  m('users', big.users, 'users'),
  m('profile_load_median_normalized', w.profile.normalized.medianMs, 'ms'),
  m('profile_load_median_document', w.profile.document.medianMs, 'ms'),
  m('profile_samples_per_shape', w.profile.normalized.n, 'samples'),
  m('revenue_report_median_normalized', w.report.normalized.medianMs, 'ms'),
  m('revenue_report_median_document', w.report.document.medianMs, 'ms'),
  m('revenue_report_samples_per_shape', w.report.normalized.n, 'samples'),
  m('rename_product_median_normalized', w.rename.normalized.medianMs, 'ms'),
  m('rename_product_median_document', w.rename.document.medianMs, 'ms'),
  m('rename_samples_per_shape', w.rename.normalized.n, 'samples'),
  m('rename_rows_written_normalized', w.rename.normalized.rowsWritten, 'rows'),
  m('rename_documents_scanned_document', w.rename.document.documentsScanned, 'documents'),
  m('rename_documents_rewritten_document', w.rename.document.documentsRewritten, 'documents'),
  m('rename_bytes_written_normalized', w.rename.normalized.bytesWritten, 'bytes'),
  m('rename_bytes_written_document', w.rename.document.bytesWritten, 'bytes'),
  m('target_product_share_of_order_lines', big.targetProduct.shareOfOrderLines, 'fraction'),
  m('stale_document_copies_after_rename', big.checks.rename.staleDocumentCopies, 'order lines'),
];

printResultAndExit({ metrics, conclusion, setup });
