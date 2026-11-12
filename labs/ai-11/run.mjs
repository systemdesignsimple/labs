// AI #11 lab: I searched "car". Why did it find "vehicle"?
// Keyword search vs embedding search on 42 hand-labeled sentences.
// Node.js 22, standard library only, no network, deterministic (fixed seed).

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const QUERY = 'car';
const TOP_K = 10;
const SEED = 11;
const ALPHA = 0.75; // context smoothing for PPMI (standard value)

// ---------------------------------------------------------------------------
// 1. Test corpus. Labels are written by hand BEFORE any search runs.
//    group: syn    = about cars, never contains the letters "car"
//           carword = about cars, says "car"
//           trap   = contains "car" (word or letters) but is NOT about cars
//           filler = unrelated
// ---------------------------------------------------------------------------
const TEST = [
  // 12 about cars, never say "car"
  ['syn', 'The vehicle slid on the icy road.'],
  ['syn', 'Our automobile insurance went up this year.'],
  ['syn', 'She bought a used sedan with low mileage.'],
  ['syn', 'My Toyota needs an oil change.'],
  ['syn', 'The engine would not start this morning.'],
  ['syn', 'He parked the hatchback in the garage.'],
  ['syn', 'The mechanic replaced the brakes and the tires.'],
  ['syn', 'I filled up the tank at the gas station.'],
  ['syn', 'We were stuck in traffic for an hour on the drive home.'],
  ['syn', 'Her electric vehicle charges overnight in the driveway.'],
  ['syn', 'The windshield wipers stopped working in the rain.'],
  ['syn', 'Honda recalled thousands of automobiles over a seatbelt fault.'],
  // 2 about cars, say "car"
  ['carword', 'We washed the car on Sunday afternoon.'],
  ['carword', 'The car needs new tires before winter.'],
  // 8 traps: contain "car" but are not about cars
  ['trap', 'The last train car was full of tired passengers.'],
  ['trap', 'We sang car-pool karaoke songs at the office party.'],
  ['trap', 'Flatten the cardboard boxes before recycling.'],
  ['trap', 'Carl called to wish me a happy birthday.'],
  ['trap', 'She knitted a warm wool cardigan.'],
  ['trap', 'He changed his career to become a teacher.'],
  ['trap', 'The caramel sauce burned on the stove.'],
  ['trap', 'A small scar stayed on her knee after the fall.'],
  // 20 filler
  ['filler', 'The coffee shop opens at seven.'],
  ['filler', 'It rained all weekend in the city.'],
  ['filler', 'Our team won the football match.'],
  ['filler', 'She is reading a book about history.'],
  ['filler', 'The bread came out of the oven golden.'],
  ['filler', 'He planted tomatoes in the backyard garden.'],
  ['filler', 'The meeting moved to Thursday afternoon.'],
  ['filler', 'My phone battery dies too quickly.'],
  ['filler', 'The cat slept on the warm windowsill.'],
  ['filler', 'We booked a flight to Tokyo for the holidays.'],
  ['filler', 'The river flooded after the storm.'],
  ['filler', 'He practiced the guitar every evening.'],
  ['filler', 'The library closes early on Fridays.'],
  ['filler', 'She ran five kilometers before breakfast.'],
  ['filler', 'The soup needs more salt.'],
  ['filler', 'Our neighbor painted the fence blue.'],
  ['filler', 'The museum has a new dinosaur exhibit.'],
  ['filler', 'I forgot my umbrella at the restaurant.'],
  ['filler', 'The printer is out of paper again.'],
  ['filler', 'Kids played in the snow all afternoon.'],
].map(([group, text], i) => ({
  id: i + 1,
  group,
  text,
  relevant: group === 'syn' || group === 'carword',
}));

// ---------------------------------------------------------------------------
// 2. Training text for the toy embedding model. Separate from the test set.
//    The model learns "meaning" only from which words share sentences here,
//    the same idea (much smaller) as a real model trained on billions of lines.
//    "car" also appears in train contexts ("dining car") on purpose.
// ---------------------------------------------------------------------------
const TRAIN = [
  // road vehicles
  'I drove the car to work on the highway.',
  'She parked her car in the garage overnight.',
  'The car would not start because the battery was dead.',
  'He washed the car and checked the tire pressure.',
  'The mechanic fixed the brakes on my car.',
  'Our car needs a new engine.',
  'We filled the car with gas before the long drive.',
  'The car insurance bill arrived today.',
  'Traffic on the road made the car crawl.',
  'The used car had high mileage but a good engine.',
  'The electric car charges overnight from the wall.',
  'I drove the vehicle to work on the highway.',
  'The vehicle needs new tires and an oil change.',
  'Every vehicle on the road must have insurance.',
  'The electric vehicle charges in the garage at night.',
  'The mechanic inspected the vehicle engine and brakes.',
  'The recall covered thousands of vehicles with a seatbelt fault.',
  'An automobile needs regular oil and brake checks.',
  'The automobile factory builds engines and tires.',
  'He bought an automobile with low mileage.',
  'The automobile industry makes electric vehicles now.',
  'Automobile insurance costs more for young drivers.',
  'The sedan has four doors and a big trunk.',
  'She drives a sedan to the office every day.',
  'The sedan got stuck in traffic on the highway.',
  'A sedan with a quiet engine is good for long drives.',
  'Toyota builds a popular sedan and a small hatchback.',
  'My Toyota has a reliable engine.',
  'Honda and Toyota sell many automobiles.',
  'Honda recalled a model because of a brake fault.',
  'The hatchback is easy to park in the city.',
  'The hatchback has a small engine and good mileage.',
  'The truck slid on the wet road.',
  'Icy roads are dangerous for every driver.',
  'The truck carried furniture down the highway.',
  'The windshield cracked when a stone hit it on the highway.',
  'Turn on the windshield wipers when it rains while driving.',
  'The wipers clean the windshield of the vehicle.',
  'Always wear a seatbelt when you drive.',
  'The seatbelt and the brakes keep the driver safe.',
  'The driver checked the fuel tank and the tires.',
  'The gas station sells fuel for every vehicle on the highway.',
  'We stopped at the gas station and filled the tank.',
  'The garage door opens to the driveway.',
  'He parked in the driveway next to the garage.',
  'Traffic was heavy so the drive home took an hour.',
  'The mechanic in the garage replaced the oil and the brakes.',
  'A flat tire stopped us on the road.',
  'The driver started the engine and pulled out of the driveway.',
  'The engine makes a strange noise when I start it in the morning.',
  // trains
  'The train left the station on time.',
  'Passengers waited on the platform for the train.',
  'The dining car on the train served coffee.',
  'We sat in the sleeper car of the night train.',
  'The train ticket includes a seat in the first car.',
  'The rail line connects the station to the airport.',
  'Tired passengers slept on the train.',
  'The train was full of passengers this morning.',
  'Each train car holds about eighty passengers.',
  'The station platform was crowded with passengers.',
  // cardboard
  'Pack the books in a cardboard box.',
  'Flatten the box and put the cardboard in recycling.',
  'The package came in a cardboard box with tape.',
  'We used tape and boxes when moving house.',
  'Recycling paper and cardboard helps the city.',
  'The cat slept inside an empty cardboard box.',
  // Carl
  'Carl is my friend from school.',
  'Carl called me on the phone last night.',
  'We had a birthday party for Carl.',
  'Happy birthday wishes came from Carl and his sister.',
  'Carl wished me luck before the exam.',
  // karaoke
  'We sang songs at karaoke night.',
  'Karaoke at the office party was loud.',
  'She picked a song and sang into the microphone.',
  'The karaoke bar plays old songs.',
  'Our team sang karaoke after the meeting.',
  // cardigan
  'She knitted a wool cardigan for winter.',
  'A warm cardigan and a wool scarf keep you cozy.',
  'Grandma knits sweaters from soft wool.',
  'He wore a cardigan to the office.',
  // career
  'She changed her career to become a teacher.',
  'A teacher career needs patience.',
  'He wants a career in medicine.',
  'The job offer was a big step for her career.',
  // caramel
  'The caramel sauce needs sugar and butter.',
  'Caramel burns quickly on a hot stove.',
  'The dessert had caramel and cream.',
  'Stir the sugar on the stove until it turns into caramel.',
  // scar
  'The scar on his knee healed slowly.',
  'She fell off her bike and hurt her knee.',
  'The cut healed but left a small scar.',
  // everyday filler
  'The coffee shop opens at seven in the morning.',
  'I drink coffee before breakfast.',
  'It rained all weekend in the city.',
  'The storm flooded the river.',
  'The river rose after a week of rain.',
  'Our team won the football match on Sunday.',
  'The football match was on television.',
  'She is reading a book about history.',
  'The library has many history books.',
  'The library closes early on Fridays.',
  'The bread baked in the oven until golden.',
  'Fresh bread came out of the oven.',
  'He planted tomatoes in the garden.',
  'The backyard garden needs water.',
  'The meeting moved to Thursday afternoon.',
  'My phone battery dies quickly.',
  'Charge the phone battery overnight.',
  'The cat slept on the warm windowsill.',
  'We booked a flight to Tokyo for the holidays.',
  'The flight was delayed by the storm.',
  'He practiced the guitar every evening.',
  'She ran five kilometers before breakfast.',
  'The soup needs more salt.',
  'Add salt and pepper to the soup.',
  'Our neighbor painted the fence blue.',
  'The museum has a new dinosaur exhibit.',
  'Kids visited the museum on a school trip.',
  'I forgot my umbrella at the restaurant.',
  'Take an umbrella because it will rain.',
  'The printer ran out of paper again.',
  'Kids played in the snow all afternoon.',
  'Snow covered the road and the garden.',
  'We washed the dishes on Sunday afternoon.',
];

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------
const STOP = new Set(
  ('a an the and or but of to in on at for with by from up down out over off is are was were be been ' +
    'being am i me my we our you your he him his she her it its they them their this that these those as ' +
    'so than then too very can could would should will just not no do does did done has have had there here ' +
    'what when where who why how all any each every some more most about into onto after before again also ' +
    'because while until if s t').split(' '),
);

const words = (text) => text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
const contentWords = (text) => words(text).filter((t) => t.length > 1 && !STOP.has(t));
// Tiny plural folding: "tires" -> "tire" when "tire" is a known word.
const fold = (t, known) => (t.length > 3 && t.endsWith('s') && known.has(t.slice(0, -1)) ? t.slice(0, -1) : t);

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
function normalize(v) {
  const n = Math.sqrt(dot(v, v));
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// 3. Toy embedding model: sentence co-occurrence -> PPMI word vectors.
//    A word's vector = how strongly it keeps company with every other word.
//    Sentence vector = average of its word vectors, then length 1.
// ---------------------------------------------------------------------------
function buildModel(sentences) {
  const raw = sentences.map(contentWords);
  const rawSet = new Set(raw.flat());
  const docs = raw.map((ts) => [...new Set(ts.map((t) => fold(t, rawSet)))]);
  const vocab = [...new Set(docs.flat())].sort();
  const index = new Map(vocab.map((w, i) => [w, i]));
  const V = vocab.length;

  const C = new Float64Array(V * V);
  for (const d of docs) {
    for (const a of d) for (const b of d) if (a !== b) C[index.get(a) * V + index.get(b)] += 1;
  }
  const rowSum = new Float64Array(V);
  const colPow = new Float64Array(V);
  let total = 0;
  for (let i = 0; i < V; i++) for (let j = 0; j < V; j++) rowSum[i] += C[i * V + j];
  for (let i = 0; i < V; i++) total += rowSum[i];
  let colPowSum = 0;
  for (let j = 0; j < V; j++) {
    let s = 0;
    for (let i = 0; i < V; i++) s += C[i * V + j];
    colPow[j] = s ** ALPHA;
    colPowSum += colPow[j];
  }
  const vectors = [];
  for (let i = 0; i < V; i++) {
    const v = new Float64Array(V);
    for (let j = 0; j < V; j++) {
      const c = C[i * V + j];
      if (c === 0) continue;
      const pmi = Math.log((c / total) / ((rowSum[i] / total) * (colPow[j] / colPowSum)));
      if (pmi > 0) v[j] = pmi;
    }
    vectors.push(normalize(v));
  }

  const lookup = (t) => {
    if (index.has(t)) return t;
    const f = fold(t, index);
    return index.has(f) ? f : null;
  };
  const wordVector = (w) => {
    const k = lookup(w);
    return k === null ? null : vectors[index.get(k)];
  };
  const embed = (text) => {
    const v = new Float64Array(V);
    const oov = [];
    for (const t of contentWords(text)) {
      const k = lookup(t);
      if (k === null) { oov.push(t); continue; }
      const wv = vectors[index.get(k)];
      for (let j = 0; j < V; j++) v[j] += wv[j];
    }
    return { vec: normalize(v), oov };
  };
  return { V, vocab, embed, wordVector };
}

// ---------------------------------------------------------------------------
// 4. Keyword search: exact word match ranked by BM25, plus a naive
//    "contains the letters" substring search.
// ---------------------------------------------------------------------------
function bm25Exact(docs, term, k1 = 1.2, b = 0.75) {
  const toks = docs.map((d) => words(d.text));
  const isHit = (t) => t === term || t === term + 's';
  const avgLen = toks.reduce((s, t) => s + t.length, 0) / toks.length;
  const n = toks.filter((t) => t.some(isHit)).length;
  const idf = Math.log((docs.length - n + 0.5) / (n + 0.5) + 1);
  return docs
    .map((d, i) => {
      const tf = toks[i].filter(isHit).length;
      const score = tf === 0 ? 0 : idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * toks[i].length / avgLen));
      return { ...d, score };
    })
    .filter((d) => d.score > 0)
    .sort((a, b2) => b2.score - a.score || a.id - b2.id);
}
const substringSearch = (docs, term) => docs.filter((d) => d.text.toLowerCase().includes(term));

// ---------------------------------------------------------------------------
// 5. PCA to 2D (power iteration, seeded) for one honest map of the vectors.
// ---------------------------------------------------------------------------
function pca2(rows, seed) {
  const n = rows.length;
  const d = rows[0].length;
  const mean = new Float64Array(d);
  for (const r of rows) for (let j = 0; j < d; j++) mean[j] += r[j] / n;
  const X = rows.map((r) => r.map((v, j) => v - mean[j]));
  let totalVar = 0;
  for (const r of X) totalVar += dot(r, r);
  const rng = mulberry32(seed);
  const comps = [];
  for (let k = 0; k < 2; k++) {
    let v = Float64Array.from({ length: d }, () => rng() - 0.5);
    for (let it = 0; it < 300; it++) {
      const u = X.map((r) => dot(r, v));
      const w = new Float64Array(d);
      for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) w[j] += X[i][j] * u[i];
      for (const c of comps) {
        const p = dot(w, c);
        for (let j = 0; j < d; j++) w[j] -= p * c[j];
      }
      v = normalize(w);
    }
    comps.push(v);
  }
  const kept = comps.reduce((s, c) => s + X.reduce((s2, r) => s2 + dot(r, c) ** 2, 0), 0);
  const project = (vec) => comps.map((c) => {
    let s = 0;
    for (let j = 0; j < d; j++) s += (vec[j] - mean[j]) * c[j];
    return s;
  });
  return { project, varianceKept: totalVar > 0 ? kept / totalVar : 0 };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const t0 = Date.now();
const model = buildModel(TRAIN);
const relevantTotal = TEST.filter((d) => d.relevant).length;
const synTotal = TEST.filter((d) => d.group === 'syn').length;

// Every method is scored on the same cutoff: its first TOP_K results.
// A method may return fewer than TOP_K (keyword search only returns real matches).
//   precisionReturned = hits / returned       (only the results it actually gave)
//   precisionAtK      = hits / TOP_K          (empty slots count as misses)
//   recall            = hits / all relevant   (same denominator for every method)
function score(list, k = TOP_K) {
  const retrieved = list.slice(0, k);
  const hits = retrieved.filter((d) => d.relevant).length;
  return {
    n: retrieved.length,
    hits,
    syn: retrieved.filter((d) => d.group === 'syn').length,
    wrong: retrieved.length - hits,
    precisionReturned: retrieved.length ? hits / retrieved.length : 0,
    precisionAtK: hits / k,
    recall: hits / relevantTotal,
  };
}

// ---------------------------------------------------------------------------
// Training / test overlap. We wrote both sets, and many test sentences have a
// close cousin in the training text. Measure it instead of hiding it:
// for each test sentence, the best word overlap (Jaccard of content words)
// with any training sentence.
// ---------------------------------------------------------------------------
const NEAR_COPY = 0.6;
const trainSets = TRAIN.map((s) => new Set(contentWords(s)));
const jaccard = (a, b) => {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const uni = a.size + b.size - inter;
  return uni ? inter / uni : 0;
};
const trainLower = new Set(TRAIN.map((s) => s.toLowerCase()));
const overlap = TEST.map((d) => {
  const ws = new Set(contentWords(d.text));
  let best = 0;
  for (const t of trainSets) best = Math.max(best, jaccard(ws, t));
  return { id: d.id, group: d.group, bestJaccard: best, exactCopy: trainLower.has(d.text.toLowerCase()) };
});
const exactCopies = overlap.filter((o) => o.exactCopy).length;
const nearCopies = overlap.filter((o) => o.bestJaccard >= NEAR_COPY).length;
const relOverlap = overlap.filter((o) => TEST[o.id - 1].relevant);
const relNearCopies = relOverlap.filter((o) => o.bestJaccard >= NEAR_COPY).length;
const meanRelJaccard = relOverlap.reduce((s, o) => s + o.bestJaccard, 0) / relOverlap.length;

// Keyword
const kwExact = bm25Exact(TEST, QUERY);
const kwSub = substringSearch(TEST, QUERY);
const sExact = score(kwExact);
const sSub = score(kwSub);
const subAllWrong = kwSub.filter((d) => !d.relevant).length; // every substring match, not just the first 10

// Embedding
const q = model.embed(QUERY);
const embedded = TEST.map((d) => {
  const e = model.embed(d.text);
  return { ...d, vec: e.vec, oov: e.oov, cos: dot(q.vec, e.vec) };
});
const ranked = [...embedded].sort((a, b) => b.cos - a.cos || a.id - b.id);
const top = ranked.slice(0, TOP_K);
const sEmb = score(ranked);
const sEmbR = score(ranked, relevantTotal); // extra metric only: recall in the top 14 (= number of relevant sentences)

// Word level similarities
const WORDS = ['vehicle', 'automobile', 'sedan', 'toyota', 'engine', 'garage', 'train', 'passengers', 'cardboard', 'carl', 'karaoke', 'caramel', 'coffee'];
const qWord = model.wordVector(QUERY);
const wordSims = WORDS.map((w) => {
  const v = model.wordVector(w);
  return { word: w, cos: v && qWord ? dot(qWord, v) : null };
});
const sim = (w) => wordSims.find((x) => x.word === w)?.cos ?? 0;

// PCA map
const pca = pca2(embedded.map((d) => d.vec), SEED);
let qxy = pca.project(q.vec);
const flip = qxy.map((c) => (c < 0 ? -1 : 1)); // fix signs so the query sits at +x, +y
qxy = qxy.map((c, i) => c * flip[i]);
const points = embedded.map((d) => {
  const [x, y] = pca.project(d.vec);
  return { id: d.id, group: d.group, x: x * flip[0], y: y * flip[1] };
});
// Word points: word vectors live in the same space as sentence vectors (a sentence
// vector is an average of word vectors), so we push them through the SAME PCA
// transform (fit on the 42 sentence vectors) and the same sign flip.
const MAP_WORDS = [QUERY, ...WORDS];
const wordPoints = MAP_WORDS.flatMap((w) => {
  const v = model.wordVector(w);
  if (!v) return [];
  const [x, y] = pca.project(v);
  return [{ word: w, x: x * flip[0], y: y * flip[1] }];
});
const dist2d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const wp = (w) => wordPoints.find((p) => p.word === w);
const mapDistVehicle = wp(QUERY) && wp('vehicle') ? dist2d(wp(QUERY), wp('vehicle')) : null;
const mapDistCardboard = wp(QUERY) && wp('cardboard') ? dist2d(wp(QUERY), wp('cardboard')) : null;

const r3 = (x) => Math.round(x * 1000) / 1000;
const pct = (x) => Math.round(x * 1000) / 10;
const oovWords = [...new Set(embedded.flatMap((d) => d.oov))].sort();

// ---- Report ----
const line = (d, extra) => `  #${String(d.id).padStart(2)} [${d.group.padEnd(7)}] ${d.relevant ? 'REL ' : '    '}${extra}  ${d.text}`;
console.log(`AI #11 lab: searching "${QUERY}" in ${TEST.length} hand-labeled sentences`);
console.log(`Relevant: ${relevantTotal} (${synTotal} never say "car"). Toy embedding: ${model.V} numbers per vector, learned from ${TRAIN.length} training sentences.\n`);

const scoreLine = (s) =>
  `   cutoff ${TOP_K}: returned ${s.n}, relevant hits ${s.hits}, precision of returned ${pct(s.precisionReturned)}%, ` +
  `precision@${TOP_K} ${pct(s.precisionAtK)}%, recall@${TOP_K} ${pct(s.recall)}% (${s.hits}/${relevantTotal}), ` +
  `car sentences without the word ${s.syn}/${synTotal}`;

console.log(`0) Training/test overlap (we wrote both): ${exactCopies} test sentences appear word for word in the training text, ` +
  `${nearCopies}/${TEST.length} share >= ${NEAR_COPY * 100}% of their content words with one training sentence ` +
  `(${relNearCopies}/${relevantTotal} of the relevant ones; mean best overlap for relevant ones ${pct(meanRelJaccard)}%).`);
console.log('   So this is a constructed demonstration, not evidence that the toy model generalizes.\n');

console.log(`1) Keyword search, exact word "${QUERY}" (BM25 order): ${kwExact.length} matches`);
for (const d of kwExact) console.log(line(d, `bm25=${d.score.toFixed(2)}`));
console.log(scoreLine(sExact));
console.log(`   It returned only ${sExact.n} of ${TOP_K} slots, so precision@${TOP_K} counts the ${TOP_K - sExact.n} empty slots as misses.\n`);

console.log(`2) Naive substring search, letters "${QUERY}": ${kwSub.length} matches`);
for (const d of kwSub) console.log(line(d, '        '));
console.log(scoreLine(sSub));
console.log(`   wrong matches among all ${kwSub.length}: ${subAllWrong}\n`);

console.log(`3) Embedding search, top ${TOP_K} by cosine similarity:`);
for (const d of top) console.log(line(d, `cos=${d.cos.toFixed(3)}`));
console.log(scoreLine(sEmb));
console.log(`   extra: recall in the top ${relevantTotal} = ${pct(sEmbR.recall)}%\n`);

console.log('   Full ranking (rank, cosine):');
ranked.forEach((d, i) => console.log(line(d, `rank ${String(i + 1).padStart(2)} cos=${d.cos.toFixed(3)}`)));
console.log('');

console.log(`4) Word to word similarity with "${QUERY}":`);
for (const w of wordSims) console.log(`   ${w.word.padEnd(11)} ${w.cos === null ? 'not in vocabulary' : w.cos.toFixed(3)}`);
console.log(`\n5) PCA 2D map (fit on the ${TEST.length} sentence vectors) keeps ${pct(pca.varianceKept)}% of their variance (the rest is lost in the flat picture).`);
console.log(`   Word points projected with the same transform: ${wordPoints.map((p) => p.word).join(', ')}`);
if (mapDistVehicle !== null && mapDistCardboard !== null)
  console.log(`   2D distance from "${QUERY}": vehicle ${mapDistVehicle.toFixed(3)}, cardboard ${mapDistCardboard.toFixed(3)}`);
console.log(`   Test words the toy model never saw (ignored): ${oovWords.join(', ') || 'none'}`);

writeFileSync(
  join(HERE, 'results.json'),
  JSON.stringify(
    {
      query: QUERY,
      topK: TOP_K,
      keywordExact: kwExact.map((d) => ({ id: d.id, text: d.text, relevant: d.relevant, bm25: r3(d.score) })),
      keywordSubstring: kwSub.map((d) => ({ id: d.id, text: d.text, relevant: d.relevant })),
      embeddingRanking: ranked.map((d, i) => ({ rank: i + 1, id: d.id, group: d.group, relevant: d.relevant, cos: r3(d.cos), text: d.text })),
      wordSimilarity: wordSims.map((w) => ({ word: w.word, cos: w.cos === null ? null : r3(w.cos) })),
      scores: {
        cutoff: TOP_K,
        relevantTotal,
        keywordExact: sExact,
        keywordSubstring: { ...sSub, wrongAmongAll: subAllWrong },
        embedding: sEmb,
        embeddingTop14Extra: sEmbR,
      },
      trainTestOverlap: { nearCopyThreshold: NEAR_COPY, exactCopies, nearCopies, relevantNearCopies: relNearCopies, meanRelevantBestJaccard: r3(meanRelJaccard), perSentence: overlap.map((o) => ({ ...o, bestJaccard: r3(o.bestJaccard) })) },
      pca: {
        fitOn: 'test sentence vectors',
        varianceKept: r3(pca.varianceKept),
        query: { x: r3(qxy[0]), y: r3(qxy[1]) },
        points: points.map((p) => ({ ...p, x: r3(p.x), y: r3(p.y) })),
        wordPoints: wordPoints.map((p) => ({ ...p, x: r3(p.x), y: r3(p.y) })),
      },
      oovWords,
      runtimeMs: Date.now() - t0,
    },
    null,
    2,
  ),
);
console.log('   Wrote results.json (scores, rankings, PCA points for the video).\n');

const result = {
  metrics: [
    { name: 'keyword_exact_returned_top10', value: sExact.n, unit: 'sentences' },
    { name: 'keyword_exact_relevant_hits_top10', value: sExact.hits, unit: 'sentences' },
    { name: 'keyword_exact_precision_of_returned', value: pct(sExact.precisionReturned), unit: '%' },
    { name: 'keyword_exact_precision_at10', value: pct(sExact.precisionAtK), unit: '%' },
    { name: 'keyword_exact_recall_at10', value: pct(sExact.recall), unit: '%' },
    { name: 'keyword_exact_hidden_car_found', value: sExact.syn, unit: `of ${synTotal}` },
    { name: 'keyword_substring_wrong_matches', value: subAllWrong, unit: 'sentences' },
    { name: 'embedding_returned_top10', value: sEmb.n, unit: 'sentences' },
    { name: 'embedding_relevant_hits_top10', value: sEmb.hits, unit: 'sentences' },
    { name: 'embedding_precision_at10', value: pct(sEmb.precisionAtK), unit: '%' },
    { name: 'embedding_recall_at10', value: pct(sEmb.recall), unit: '%' },
    { name: 'embedding_top10_hidden_car_found', value: sEmb.syn, unit: `of ${synTotal}` },
    { name: 'embedding_top10_wrong_matches', value: sEmb.wrong, unit: 'sentences' },
    { name: 'embedding_recall_top14_extra', value: pct(sEmbR.recall), unit: '%' },
    { name: 'similarity_car_vehicle', value: r3(sim('vehicle')), unit: 'cosine' },
    { name: 'similarity_car_cardboard', value: r3(sim('cardboard')), unit: 'cosine' },
    { name: 'test_near_copies_of_training', value: nearCopies, unit: `of ${TEST.length}` },
    { name: 'pca_2d_variance_kept', value: pct(pca.varianceKept), unit: '%' },
  ],
  conclusion:
    `In this constructed demo with a toy PPMI model trained on text we wrote, keyword search for "${QUERY}" found ${sExact.syn} of the ${synTotal} car sentences that use other words (recall@${TOP_K} ${pct(sExact.recall)}%), ` +
    `while toy embedding search found ${sEmb.syn} of them in its top ${TOP_K} (recall@${TOP_K} ${pct(sEmb.recall)}%) but also put ${sEmb.wrong} wrong sentences there.`,
  setup:
    `${TEST.length} hand-labeled test sentences (${relevantTotal} about cars, ${synTotal} never say "car", 8 traps, 20 filler); ` +
    `toy count-based embedding (sentence co-occurrence PPMI, alpha ${ALPHA}, ${model.V} dims) learned from ${TRAIN.length} training sentences we wrote, ` +
    `${exactCopies} test sentences copied exactly and ${nearCopies} near copies (Jaccard >= ${NEAR_COPY}) in training; ` +
    `keyword = exact word with BM25 (k1 1.2, b 0.75) and naive substring; cutoff ${TOP_K} for every method; PCA seed ${SEED} fit on sentence vectors; not all-MiniLM-L6-v2`,
};
console.log('RESULT ' + JSON.stringify(result));
