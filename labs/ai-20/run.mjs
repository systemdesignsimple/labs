// AI #20 lab: semantic caching, studied as a LEXICAL cache simulation.
// Can a look-alike question safely reuse a cached answer when "similar" means "shares words"?
// No neural embedding model runs here (stdlib-only rules), so every similarity score comes from
// hashed words + character trigrams + a small hand-written synonym table.
// Node.js 22 ESM, standard library only. No network, no child processes, no file writes.
// Everything is deterministic: hashing is fixed and every random number comes from a seeded PRNG.

const DIM = 1024;           // embedding size
const FILLER = 10000;       // synthetic scan workload: random unit vectors, used only to time a 10k-row scan
const SEED = 20;
const HYPOTHETICAL_MODEL_MS = 900; // hypothetical baseline for the comparison, NOT measured (no model runs here)
const THRESHOLDS = Array.from({ length: 15 }, (_, i) => +(0.70 + 0.02 * i).toFixed(2));

// ---------------------------------------------------------------------------
// 1. Hand-labeled pairs. A is already in the cache with its answer; B is the new question.
//    same = true  -> B truly has the same answer as A (paraphrase)
//    same = false -> B looks like A but needs a different answer (look-alike)
// ---------------------------------------------------------------------------
const PAIRS = [
  // paraphrases (30)
  ['How do I reset my password?', 'I forgot my password, what now?', true],
  ['What is the capital of France?', 'Which city is the capital of France?', true],
  ['How do I cancel my subscription?', 'How can I stop my subscription?', true],
  ['What does HTTP 404 mean?', 'What is a 404 error?', true],
  ['How many days are in a leap year?', 'How many days does a leap year have?', true],
  ['How do I boil an egg?', 'What is the way to boil an egg?', true],
  ['Convert 10 miles to kilometers', 'How many kilometers is 10 miles?', true],
  ['What is the boiling point of water?', 'At what temperature does water boil?', true],
  ['How do I change my email address?', 'How can I update my email address?', true],
  ['Who wrote Romeo and Juliet?', 'Who is the author of Romeo and Juliet?', true],
  ['What is a load balancer?', 'Explain what a load balancer does', true],
  ['How do I delete my account?', 'How can I remove my account?', true],
  ['What is the speed of light?', 'How fast does light travel?', true],
  ['How do I take a screenshot on a Mac?', 'How to capture the screen on a Mac?', true],
  ['What is DNS?', 'What does DNS do?', true],
  ['How long should I boil pasta?', 'How many minutes do I cook pasta?', true],
  ['What is the tallest mountain in the world?', 'Which mountain is the highest in the world?', true],
  ['How do I install Node.js on Windows?', 'Steps to install Node.js on Windows', true],
  ['What is the difference between RAM and storage?', 'How is RAM different from storage?', true],
  ['How do I export a PDF from Word?', 'How can I save a Word file as PDF?', true],
  ['What is the freezing point of water in Fahrenheit?', 'At what Fahrenheit temperature does water freeze?', true],
  ['How do I clear my browser cache?', 'How to empty the browser cache?', true],
  ['What does CPU stand for?', 'What is the full form of CPU?', true],
  ['How many continents are there?', 'What is the number of continents?', true],
  ['What is a cache in computing?', 'Explain caching in computers', true],
  ['How do I turn on dark mode in Chrome?', 'How to enable dark mode in Chrome?', true],
  ['What is the largest ocean?', 'Which ocean is the biggest?', true],
  ['How do I split a bill in the app?', 'How can I divide a bill in the app?', true],
  ['What is an API?', 'Explain what an API is', true],
  ["How do I update my phone's software?", "How can I upgrade my phone's software?", true],
  // look-alikes that need a different answer (30)
  ['Flights to Tokyo tomorrow', 'Flights to Tokyo today', false],
  ['What is the capital of Austria?', 'What is the capital of Australia?', false],
  ['Convert 5 miles to kilometers', 'Convert 5 kilometers to miles', false],
  ['Weather in London today', 'Weather in London tomorrow', false],
  ['How do I reset my iPhone?', 'How do I reset my iPad?', false],
  ['What is my order status?', 'What is my refund status?', false],
  ['Python list vs tuple', 'Python list vs set', false],
  ['How to sort an array in JavaScript?', 'How to sort an array in Python?', false],
  ['Is it safe to take ibuprofen with alcohol?', 'Is it safe to take ibuprofen with aspirin?', false],
  ['What time does the store open on Sunday?', 'What time does the store close on Sunday?', false],
  ['Score of the Arsenal match now', 'Score of the Chelsea match now', false],
  ['Who won the 2018 World Cup?', 'Who won the 2022 World Cup?', false],
  ['How do I convert Celsius to Fahrenheit?', 'How do I convert Fahrenheit to Celsius?', false],
  ['Population of Nepal in 2020', 'Population of Nepal in 2024', false],
  ['How do I cancel my order?', 'How do I cancel my flight?', false],
  ['What is the boiling point of water at sea level?', 'What is the boiling point of water on Everest?', false],
  ['Side effects of vitamin D', 'Side effects of vitamin B12', false],
  ['Best way to learn Java', 'Best way to learn JavaScript', false],
  ['How many calories in an apple?', 'How many calories in an apple pie?', false],
  ['Directions to the airport from my home', 'Directions to my home from the airport', false],
  ['Is the bank open today?', 'Is the bank open tomorrow?', false],
  ['What is 15% of 200?', 'What is 25% of 200?', false],
  ['Translate hello into Spanish', 'Translate hello into Portuguese', false],
  ['How do I enable two-factor authentication?', 'How do I disable two-factor authentication?', false],
  ['Can dogs eat grapes?', 'Can dogs eat carrots?', false],
  ['What is the time in New York?', 'What is the time in New Delhi?', false],
  ['Show my last 5 orders', 'Show my last 10 orders', false],
  ['What is TCP?', 'What is UDP?', false],
  ['How do I add a user in Linux?', 'How do I remove a user in Linux?', false],
  ['Movies playing tonight near me', 'Movies playing tomorrow near me', false],
];
const N = PAIRS.length;

// ---------------------------------------------------------------------------
// 2. Lexical vector. A neural model such as all-MiniLM-L6-v2 needs an npm package and model
//    weights, which the lab rules forbid, so this lab does NOT measure neural embeddings.
//    Each question becomes a bag of hashed word features + character trigrams, plus a small
//    hand-written synonym table. It is a bag: word order is thrown away, and stop words
//    (including the direction words "to" and "from") are dropped. So two questions with the
//    same words in a different order get IDENTICAL vectors by construction (see section 5b).
// ---------------------------------------------------------------------------
const STOP = new Set(('what is a an the how do does i to of in can which are there at who ' +
  'explain way steps from into on for with and it be should').split(' '));
const SYN = {
  forgot: 'reset', recover: 'reset', stop: 'cancel',
  update: 'change', upgrade: 'change', modify: 'change',
  remove: 'delete', erase: 'delete', tallest: 'highest', biggest: 'largest',
  author: 'wrote', writer: 'wrote', capture: 'screenshot', screen: 'screenshot',
  fast: 'speed', boiling: 'boil', cook: 'boil', freezing: 'freeze', temperature: 'point',
  enable: 'turn_on', turn: 'turn_on', empty: 'clear', divide: 'split', save: 'export',
  minute: 'long', number: 'many', stand: 'full_form', full: 'full_form', form: 'full_form',
  different: 'difference', vs: 'difference', caching: 'cache', computer: 'computing',
  error: 'meaning', mean: 'meaning',
};
const WORD_W = 1.0;
const TRI_W = 0.25;

function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function stem(t) {
  return t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t;
}
function tokens(text) {
  const raw = text.toLowerCase().replace(/'s\b/g, '').match(/[a-z0-9%.\-]+/g) || [];
  return raw.map(t => t.replace(/^[.\-]+|[.\-]+$/g, '')).filter(t => t && !STOP.has(t)).map(stem);
}
function addFeature(vec, f, w) {
  const h = fnv(f);
  vec[h % DIM] += (fnv('sign:' + f) & 1 ? 1 : -1) * w;
}
function embed(text) {
  const v = new Float32Array(DIM);
  for (const t of tokens(text)) {
    addFeature(v, 'w:' + (SYN[t] || t), WORD_W);
    const padded = '#' + t + '#';
    for (let i = 0; i + 3 <= padded.length; i++) addFeature(v, 'c:' + padded.slice(i, i + 3), TRI_W);
  }
  let n = 0;
  for (let i = 0; i < DIM; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= n;
  return v;
}

// ---------------------------------------------------------------------------
// 3. Seeded randomness (synthetic filler rows only).
// ---------------------------------------------------------------------------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
function gauss() {
  const u = Math.max(rand(), 1e-12), v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------------------------------------------------------------------------
// 4. Build the cache: the 60 "A" questions first, then synthetic filler rows. The filler rows are
//    random unit vectors, NOT embedded questions. In 1024 dimensions they sit near cosine 0 to
//    every real question, so they add scan work for the timing but should not compete as
//    matches (the run prints how many questions landed on one, so this is checked, not assumed).
//    They say nothing about how a real cache full of unrelated questions would behave.
// ---------------------------------------------------------------------------
const ROWS = N + FILLER;
const cache = new Float32Array(ROWS * DIM);
for (let i = 0; i < N; i++) cache.set(embed(PAIRS[i][0]), i * DIM);
for (let r = N; r < ROWS; r++) {
  let n = 0;
  const off = r * DIM;
  for (let i = 0; i < DIM; i++) { const g = gauss(); cache[off + i] = g; n += g * g; }
  n = Math.sqrt(n);
  for (let i = 0; i < DIM; i++) cache[off + i] /= n;
}

function lookup(q) {
  let best = -2, bestIdx = -1;
  for (let r = 0; r < ROWS; r++) {
    const off = r * DIM;
    let s = 0;
    for (let i = 0; i < DIM; i++) s += q[i] * cache[off + i];
    if (s > best) { best = s; bestIdx = r; }
  }
  return { idx: bestIdx, sim: best };
}

// warm up the JIT so timings are not dominated by compilation
for (let i = 0; i < 10; i++) lookup(embed(PAIRS[i][1]));

// ---------------------------------------------------------------------------
// 5. Run every new question once: embed + nearest neighbour, timed.
// ---------------------------------------------------------------------------
const results = [];
const lookupMs = [];
for (let i = 0; i < N; i++) {
  const t0 = performance.now();
  const { idx, sim } = lookup(embed(PAIRS[i][1]));
  lookupMs.push(performance.now() - t0);
  results.push({ i, idx, sim, same: PAIRS[i][2] });
}
const median = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const medLookup = median(lookupMs);

const fillerMatches = results.filter(r => r.idx >= N).length;

// ---------------------------------------------------------------------------
// 5b. Order-only look-alikes: same words (after synonyms and stop words), different order or
//     direction ("5 miles to kilometers" vs "5 kilometers to miles"). A bag-of-words vector
//     cannot tell these apart at all, so their wrong reuses are a limit of THIS lab's vector,
//     not a measured property of semantic embeddings. They are reported separately.
// ---------------------------------------------------------------------------
const bagKey = text => tokens(text).map(t => SYN[t] || t).sort().join(' ');
const orderOnly = new Set();
for (let i = 0; i < N; i++) if (!PAIRS[i][2] && bagKey(PAIRS[i][0]) === bagKey(PAIRS[i][1])) orderOnly.add(i);

// ---------------------------------------------------------------------------
// 6. Guards a careful setup adds before reusing an answer.
//    a) skip the cache for time-sensitive or personal questions
//    b) cheap check: numbers and named things (words with capitals) must match exactly
// ---------------------------------------------------------------------------
const TIME_RE = /\b(today|tomorrow|tonight|now|yesterday)\b/i;
const PERSONAL_RE = /\b(my (order|orders|refund|home|last|balance)|near me)\b/i;
function keyTokens(text) {
  const out = new Set();
  const words = text.split(/\s+/).map(w => w.replace(/[?,.!]+$/, '').replace(/'s$/, ''));
  words.forEach((w, i) => {
    if (/\d/.test(w)) { out.add(w.toLowerCase()); return; }
    if (!/[A-Z]/.test(w) || w === 'I') return;
    if (i === 0 && !/[A-Z]/.test(w.slice(1))) return; // ordinary sentence-start capital
    out.add(w.toLowerCase());
  });
  return out;
}
const sameSet = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
function guardAllows(r) {
  const q = PAIRS[r.i][1];
  if (TIME_RE.test(q) || PERSONAL_RE.test(q)) return false;
  if (r.idx >= N) return false;
  return sameSet(keyTokens(q), keyTokens(PAIRS[r.idx][0]));
}

// A reuse is correct only if the matched entry is this question's own pair AND the pair is a
// true paraphrase. Matching any other entry counts as wrong (conservative).
const isCorrect = r => r.same && r.idx === r.i;

function sweep(useGuard) {
  return THRESHOLDS.map(t => {
    let hits = 0, wrong = 0, wrongOrderOnly = 0;
    for (const r of results) {
      if (r.sim < t) continue;
      if (useGuard && !guardAllows(r)) continue;
      hits++;
      if (!isCorrect(r)) { wrong++; if (orderOnly.has(r.i)) wrongOrderOnly++; }
    }
    return { t, hits, wrong, wrongOrderOnly, wrongOther: wrong - wrongOrderOnly };
  });
}
const plain = sweep(false);
const guarded = sweep(true);

// ---------------------------------------------------------------------------
// 7. Report
// ---------------------------------------------------------------------------
const pct = n => Math.round((n / N) * 1000) / 10;
const r1 = x => Math.round(x * 10) / 10;
const r3 = x => Math.round(x * 1000) / 1000;

console.log(`Lexical semantic-cache simulation: ${N} new questions (30 paraphrases, 30 look-alikes), cache of ${N} real + ${FILLER} synthetic filler rows\n`);
console.log(`Order-only look-alikes (same bag of words, identical vector by construction): ${orderOnly.size}`);
for (const i of orderOnly) console.log(`  "${PAIRS[i][0]}" / "${PAIRS[i][1]}"`);
console.log('\nwrong = all wrong reuses; (o) = of which order-only pairs; other = the rest\n');
console.log('threshold | lexical similarity only: hits  wrong (o) other  wrong% | with guards: hits  wrong (o) other');
for (let k = 0; k < THRESHOLDS.length; k++) {
  const p = plain[k], g = guarded[k];
  const wp = p.hits ? r1((p.wrong / p.hits) * 100) : 0;
  console.log(`   ${p.t.toFixed(2)}   |   ${String(p.hits).padStart(2)} (${String(pct(p.hits)).padStart(4)}%)  ${String(p.wrong).padStart(3)} (${p.wrongOrderOnly}) ${String(p.wrongOther).padStart(3)}  ${String(wp).padStart(5)}% |   ${String(g.hits).padStart(2)} (${String(pct(g.hits)).padStart(4)}%)  ${String(g.wrong).padStart(3)} (${g.wrongOrderOnly}) ${String(g.wrongOther).padStart(3)}`);
}

const lookalikes = results.filter(r => !r.same).sort((a, b) => b.sim - a.sim);
const paraphrases = results.filter(r => r.same).sort((a, b) => a.sim - b.sim);
console.log('\nLook-alike questions with the highest similarity (these are the dangerous ones):');
for (const r of lookalikes.slice(0, 8)) console.log(`  ${r.sim.toFixed(3)}  "${PAIRS[r.i][1]}"  ->  cached "${r.idx < N ? PAIRS[r.idx][0] : '(filler)'}"${orderOnly.has(r.i) ? '  [order-only]' : ''}`);
console.log('\nTrue paraphrases with the lowest similarity (these are the missed savings):');
for (const r of paraphrases.slice(0, 5)) console.log(`  ${r.sim.toFixed(3)}  "${PAIRS[r.i][1]}"  ->  cached "${r.idx < N ? PAIRS[r.idx][0] : '(filler)'}"`);

console.log(`\nNew questions whose nearest row was a synthetic filler row: ${fillerMatches} of ${N}`);
console.log(`Median cache lookup (lexical vector + linear scan of ${ROWS} rows): ${medLookup.toFixed(2)} ms (measured on this machine)`);
console.log(`Model call: ${HYPOTHETICAL_MODEL_MS} ms (HYPOTHETICAL baseline for comparison, not measured; no model runs here)`);

const at = (rows, t) => rows.find(x => x.t === t);
const loose = at(plain, 0.80);
const strict = at(plain, 0.96);
const bestZero = rows => {
  let best = null;
  for (const x of rows) if (x.wrong === 0 && (!best || x.hits > best.hits)) best = x;
  return best;
};
const zw = bestZero(plain);
const gz = bestZero(guarded);
const bestZeroOther = rows => {
  let best = null;
  for (const x of rows) if (x.wrongOther === 0 && (!best || x.hits > best.hits)) best = x;
  return best;
};
const gzo = bestZeroOther(guarded);
const lookalikeOver90 = lookalikes.filter(r => r.sim >= 0.9).length;
const lookalikeOver80 = lookalikes.filter(r => r.sim >= 0.8).length;

const metrics = [
  { name: 'hit rate at 0.80, lexical similarity only', value: pct(loose.hits), unit: '%' },
  { name: 'wrong answers among reuses at 0.80', value: loose.hits ? r1((loose.wrong / loose.hits) * 100) : 0, unit: '%' },
  { name: 'hit rate at 0.96, lexical similarity only', value: pct(strict.hits), unit: '%' },
  { name: 'wrong reuses at 0.96', value: strict.wrong, unit: 'questions' },
  { name: 'of those, order-only pairs (identical vectors by construction)', value: strict.wrongOrderOnly, unit: 'questions' },
  { name: 'order-only look-alike pairs in the set', value: orderOnly.size, unit: `of ${lookalikes.length}` },
  { name: 'loosest zero-wrong threshold, lexical similarity only', value: zw ? zw.t : 0, unit: zw ? 'cosine' : 'none found' },
  { name: 'hit rate at that zero-wrong threshold', value: zw ? pct(zw.hits) : 0, unit: '%' },
  { name: 'best zero-wrong hit rate with guards', value: gz ? pct(gz.hits) : 0, unit: gz ? '%' : '% (none found)' },
  { name: 'best hit rate with guards, zero wrong outside order-only pairs', value: gzo ? pct(gzo.hits) : 0, unit: gzo ? '%' : '% (none found)' },
  { name: 'look-alike pairs scoring 0.80 or more', value: lookalikeOver80, unit: `of ${lookalikes.length}` },
  { name: 'look-alike pairs scoring 0.90 or more', value: lookalikeOver90, unit: `of ${lookalikes.length}` },
  { name: 'questions matched to a synthetic filler row', value: fillerMatches, unit: `of ${N}` },
  { name: 'median cache lookup, linear scan (measured)', value: r3(medLookup), unit: 'ms' },
  { name: 'model call (hypothetical baseline, not measured)', value: HYPOTHETICAL_MODEL_MS, unit: 'ms' },
];

const conclusion =
  `In this lexical (word-overlap) cache simulation on 60 hand-made pairs, a 0.80 threshold reused answers for ${pct(loose.hits)}% of questions but ${loose.wrong} of ${loose.hits} reuses were wrong, ` +
  (zw ? `the loosest threshold with zero wrong reuses (${zw.t}) served only ${pct(zw.hits)}%` : `no threshold from 0.70 to 0.98 reached zero wrong reuses`) +
  ` (${strict.wrongOrderOnly} of the ${strict.wrong} wrong reuses at 0.96 are same-words-different-order pairs this bag-of-words vector cannot separate by construction)` +
  `, and skipping time-sensitive or personal questions plus matching numbers and names ` +
  (gz ? `reached ${pct(gz.hits)}% with zero wrong.` : `still let some wrong reuses through.`);

const setup =
  `${N} labeled pairs (30 paraphrase, 30 look-alike, ${orderOnly.size} of them order-only); lexical vector = bag of hashed words + char trigrams (dim ${DIM}, trigram weight ${TRI_W}) ` +
  `with a ${Object.keys(SYN).length}-word hand-written synonym table, no neural model; cache = ${N} real rows + ${FILLER} seeded random unit vectors as synthetic scan workload; ` +
  `thresholds ${THRESHOLDS[0]} to ${THRESHOLDS[THRESHOLDS.length - 1]} step 0.02; model call ${HYPOTHETICAL_MODEL_MS} ms is a hypothetical baseline, not measured; seed ${SEED}`;

console.log('RESULT ' + JSON.stringify({ metrics, conclusion, setup }));
