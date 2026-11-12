// AI #10 lab: "AI gave me a source. I clicked it. The quote wasn't there."
// Does a quote-must-match check catch cited quotes that are not in the source?
// Node.js 22 ESM, standard library only. No network, no child processes.
// Writes only inside this folder: ./corpus/*.txt and ./results.json.
//
// IMPORTANT: the bad quotes are CONSTRUCTED to copy three known failure shapes
// (paraphrase, merged sentence, wrong document). They are not a measured
// hallucination rate from any AI model or product.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(HERE, 'corpus');
const SEED = 42;

// ---------- seeded RNG ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
const randInt = (n) => Math.floor(rng() * n);
const pick = (arr) => arr[randInt(arr.length)];
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = randInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ---------- corpus: 10 short SYNTHETIC doc-style texts, written in our own words for this lab ----------
// They summarize well known public concepts. They are NOT saved public documents and are not
// copied from any vendor's docs. The lab tests quote matching against this synthetic corpus,
// not verification against real cited public sources.
const DOCS = [
  { id: 'http-caching', text: "A browser can keep a copy of a response so it does not have to ask the server again. The Cache-Control header tells the browser how long that copy stays fresh. With max-age set to 3600, the copy is treated as fresh for one hour. After that time the browser must check with the server before it uses the stored copy again. If the server's answer has not changed, it can reply with status 304 and send no body. This saves bandwidth because the client reuses the bytes it already has." },
  { id: 'dns-ttl', text: "DNS turns a name like example.com into an address a computer can connect to. Each DNS record comes with a TTL, which is a number of seconds. A resolver may keep the answer in its cache until the TTL runs out. With a TTL of 300, a changed address can take up to 5 minutes to reach most users. Some resolvers keep answers longer than the TTL, so a change can take even more time. Lowering the TTL a day before a planned move makes the switch faster." },
  { id: 'tcp-handshake', text: "Before two machines exchange data over TCP, they perform a three step handshake. The client sends a SYN packet to start the connection. The server answers with a SYN-ACK packet to accept it. The client then sends an ACK, and the connection is open. This setup costs one full round trip before any request data can move. On a link with 100 ms of round trip time, that is 100 ms of waiting on every new connection." },
  { id: 'token-bucket', text: "A token bucket is a simple way to limit how many requests a client can make. The bucket holds up to 10 tokens and gains 1 new token every second. Each request takes one token out of the bucket. When the bucket is empty, the request is rejected or asked to wait. A client that has been quiet can send a short burst of up to 10 requests at once. Over a long period the client can't average more than 1 request per second." },
  { id: 'db-index', text: "An index helps a database find rows without reading the whole table. Without an index, a query on a table of 1000000 rows may scan every row. A B-tree index keeps keys in sorted order, so a lookup only touches a few pages. Each index also has a cost, because every insert and update must change it too. A table with 8 indexes does more work on each write than a table with 1. Good indexes match the columns that real queries filter and sort on." },
  { id: 'health-checks', text: "A load balancer sends traffic only to servers it believes are healthy. It checks each server by calling a health endpoint every 5 seconds. If a server fails 3 checks in a row, the load balancer stops sending it new requests. The server is added back after it passes 2 checks in a row. A health check that only returns OK without testing the database can hide real failures. A check that tests too much can mark every server down at the same time." },
  { id: 'retries-backoff', text: "Retrying a failed request can help when the failure is short and random. Retrying at once can make things worse when the server is already overloaded. Exponential backoff doubles the wait after each failed attempt, for example 100 ms, then 200 ms, then 400 ms. Adding random jitter spreads clients out so they don't all retry at the same moment. A retry budget caps retries at a small share of traffic, such as 10 percent. Without a cap, retries can multiply the load on a struggling service." },
  { id: 'idempotency', text: "An idempotent request has the same effect whether it runs once or many times. Payment systems often ask the client to send an idempotency key with each request. The server stores the key together with the result of the first attempt. If the same key arrives again, the server returns the stored result instead of charging twice. Keys are usually kept for a limited time, such as 24 hours. A retry after the key has expired can be treated as a brand new request." },
  { id: 'cdn', text: "A content delivery network keeps copies of files on servers close to users. When a user asks for a file, the nearest edge server answers if it has a copy. If the edge does not have the file, it fetches it from the origin and stores it. A cache hit ratio of 90 percent means the origin serves only 1 request in 10. Purging a file tells every edge to drop its copy and fetch a new one. Purges can take from a few seconds to several minutes to reach every edge." },
  { id: 'queue-visibility', text: "A message queue lets one service hand work to another without waiting for it. When a worker receives a message, the queue hides it from other workers for a visibility timeout. If the worker finishes and deletes the message, the work is done. If the worker crashes, the message becomes visible again after the timeout, such as 30 seconds. Another worker can then pick it up, so the same message may be processed twice. Workers should therefore make their processing safe to repeat." },
];
const splitSentences = (t) => t.split(/(?<=[.!?])\s+/).filter(Boolean);
for (const d of DOCS) d.sentences = splitSentences(d.text);

// Save the corpus as local text files; the verifier reads these files back.
mkdirSync(CORPUS_DIR, { recursive: true });
for (const d of DOCS) writeFileSync(join(CORPUS_DIR, `${d.id}.txt`), d.text + '\n');

// ---------- constructing bad quotes (three known failure shapes) ----------
const SYN = {
  client: 'caller', server: 'backend', sends: 'transmits', request: 'call', requests: 'calls',
  copy: 'replica', keeps: 'holds', stores: 'saves', check: 'verify', checks: 'probes',
  before: 'prior', after: 'following', faster: 'quicker', simple: 'basic', helps: 'lets',
  find: 'locate', cost: 'price', returns: 'gives', answers: 'replies', usually: 'typically',
  often: 'frequently', short: 'brief', small: 'little', change: 'update', changed: 'updated',
  fails: 'misses', drop: 'discard', close: 'near', nearest: 'closest', new: 'fresh',
  waiting: 'delay', open: 'established', work: 'effort', hides: 'masks', crashes: 'dies',
  safe: 'okay', limit: 'cap', rejected: 'refused', quiet: 'idle', data: 'bytes',
  machines: 'hosts', table: 'relation', rows: 'records', users: 'people', file: 'object',
  files: 'objects', longer: 'more', time: 'period', healthy: 'fine', traffic: 'load',
  fresh: 'valid', exchange: 'trade', limited: 'fixed', random: 'chance', worse: 'harder',
};
const wordCore = (w) => w.match(/^([A-Za-z]+)([^A-Za-z]*)$/);
function synonymPositions(words) {
  const out = [];
  words.forEach((w, i) => { const m = wordCore(w); if (m && SYN[m[1].toLowerCase()]) out.push(i); });
  return out;
}
function swapWord(w) {
  const m = wordCore(w);
  let s = SYN[m[1].toLowerCase()];
  if (m[1][0] === m[1][0].toUpperCase()) s = s[0].toUpperCase() + s.slice(1);
  return s + m[2];
}
function reword(sentence, k) {
  const words = sentence.split(' ');
  const pos = shuffle(synonymPositions(words)).slice(0, k);
  for (const p of pos) words[p] = swapWord(words[p]);
  return { quote: words.join(' '), swaps: pos.length };
}
function flipNumber(sentence) {
  const words = sentence.split(' ');
  const pos = words.map((w, i) => (/^\d+[.,]?$/.test(w) ? i : -1)).filter((i) => i >= 0);
  const p = pick(pos);
  words[p] = words[p].replace(/\d+/, (n) => String(Number(n) * 2));
  return words.join(' ');
}

// ---------- build 60 cited answers ----------
const answers = [];
let nextId = 1;
const add = (a) => answers.push({ id: `A${String(nextId++).padStart(2, '0')}`, ...a });

// Grounded: quote copied word for word from a retrieved passage.
// One in three gets harmless copy noise (curly apostrophe, line break, double space),
// which is what real copy/paste and rendering do to quotes.
for (let i = 0; i < 30; i++) {
  const doc = DOCS[i % DOCS.length];
  const sentence = pick(doc.sentences);
  let quote = sentence;
  const noisy = i % 3 === 0;
  if (noisy) {
    quote = quote.replace(/'/g, '’');
    const words = quote.split(' ');
    const at = 1 + randInt(Math.max(1, words.length - 2));
    quote = words.slice(0, at).join(' ') + (i % 2 ? '\n' : '  ') + words.slice(at).join(' ');
  }
  add({ mode: 'grounded', kind: 'verbatim', cite: doc.id, quote, noisy, sourceDoc: doc.id });
}

// Ungrounded 1: real sentence, but pointed at the wrong document.
for (let i = 0; i < 10; i++) {
  const src = DOCS[i];
  const cite = DOCS[(i + 1 + randInt(DOCS.length - 1)) % DOCS.length];
  add({ mode: 'ungrounded', kind: 'wrong-doc', cite: cite.id, quote: pick(src.sentences), sourceDoc: src.id });
}

// Ungrounded 2: one sentence built from two places in the same document.
for (let i = 0; i < 10; i++) {
  const doc = DOCS[i];
  const n = doc.sentences.length;
  const a = randInt(n);
  let b = randInt(n);
  while (Math.abs(a - b) < 2) b = randInt(n);
  const wa = doc.sentences[a].split(' ');
  const wb = doc.sentences[b].split(' ');
  const quote = wa.slice(0, Math.ceil(wa.length / 2)).concat(wb.slice(Math.floor(wb.length / 2))).join(' ');
  add({ mode: 'ungrounded', kind: 'merged', cite: doc.id, quote, sourceDoc: doc.id });
}

// Ungrounded 3: paraphrase. 7 rewordings of growing strength, 3 with one number changed.
const strengths = shuffle([1, 1, 2, 2, 3, 3, 4, 'flip', 'flip', 'flip']);
for (let i = 0; i < 10; i++) {
  const doc = DOCS[i];
  const s = strengths[i];
  if (s === 'flip') {
    const withNum = doc.sentences.filter((x) => /\b\d+\b/.test(x));
    const quote = flipNumber(pick(withNum));
    add({ mode: 'ungrounded', kind: 'paraphrase', sub: 'number-flip', changes: 1, cite: doc.id, quote, sourceDoc: doc.id });
  } else {
    const ok = doc.sentences.filter((x) => synonymPositions(x.split(' ')).length >= s);
    const base = ok.length ? pick(ok) : pick(doc.sentences);
    const r = reword(base, s);
    add({ mode: 'ungrounded', kind: 'paraphrase', sub: 'reword', changes: r.swaps, cite: doc.id, quote: r.quote, sourceDoc: doc.id });
  }
}

// ---------- the verifier ----------
function normalize(s) {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
// Best overlap between the quote's tokens and any same-length window of the source.
// Multiset token overlap / quote length. Ignores word order (see README limits).
function fuzzyScore(qTokens, dTokens) {
  const L = qTokens.length;
  if (!L) return 0;
  const need = new Map();
  for (const t of qTokens) need.set(t, (need.get(t) || 0) + 1);
  let best = 0;
  const last = Math.max(0, dTokens.length - L);
  for (let s = 0; s <= last; s++) {
    const have = new Map();
    let hit = 0;
    const end = Math.min(dTokens.length, s + L);
    for (let j = s; j < end; j++) {
      const t = dTokens[j];
      const n = need.get(t) || 0;
      if (!n) continue;
      const h = have.get(t) || 0;
      if (h < n) { have.set(t, h + 1); hit++; }
    }
    if (hit / L > best) best = hit / L;
  }
  return best;
}
function verify(answer) {
  const path = join(CORPUS_DIR, `${answer.cite}.txt`);
  const linkOpens = existsSync(path);
  if (!linkOpens) return { linkOpens, raw: false, exact: false, fuzzy: 0 };
  const text = readFileSync(path, 'utf8');
  const raw = text.includes(answer.quote);
  const nq = normalize(answer.quote);
  const nd = normalize(text);
  const exact = (' ' + nd + ' ').includes(' ' + nq + ' ');
  const fuzzy = exact ? 1 : fuzzyScore(nq.split(' '), nd.split(' '));
  return { linkOpens, raw, exact, fuzzy };
}

// Warm up once so the timed pass measures steady state, then time each answer.
for (const a of answers) verify(a);
const times = [];
for (const a of answers) {
  const t0 = process.hrtime.bigint();
  a.check = verify(a);
  times.push(Number(process.hrtime.bigint() - t0) / 1e6);
}
times.sort((x, y) => x - y);
const median = times[Math.floor(times.length / 2)];
const maxMs = times[times.length - 1];

// ---------- results ----------
const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : 0);
const r3 = (x) => Math.round(x * 1000) / 1000;
const grounded = answers.filter((a) => a.mode === 'grounded');
const ungrounded = answers.filter((a) => a.mode === 'ungrounded');
const byKind = (k) => ungrounded.filter((a) => a.kind === k);
const paraphrases = byKind('paraphrase');
const flips = paraphrases.filter((a) => a.sub === 'number-flip');

const groundedExact = grounded.filter((a) => a.check.exact).length;
const groundedRawFail = grounded.filter((a) => !a.check.raw).length;
const linksOpen = answers.filter((a) => a.check.linkOpens).length;
const caughtExact = (list) => list.filter((a) => !a.check.exact).length;

const THRESHOLDS = [0.95, 0.9, 0.8, 0.7];
const sweep = THRESHOLDS.map((T) => {
  const pass = (a) => a.check.exact || a.check.fuzzy >= T;
  return {
    threshold: T,
    groundedRejected: grounded.filter((a) => !pass(a)).length,
    ungroundedAccepted: ungrounded.filter(pass).length,
    wrongDocAccepted: byKind('wrong-doc').filter(pass).length,
    mergedAccepted: byKind('merged').filter(pass).length,
    paraphraseAccepted: paraphrases.filter(pass).length,
    numberFlipsAccepted: flips.filter(pass).length,
  };
});
const at = (T) => sweep.find((s) => s.threshold === T);
const nearMiss = paraphrases.filter((a) => a.check.fuzzy >= 0.8).length;

// Human-readable output
console.log('AI #10 lab: does the quoted text really appear in the cited source?');
console.log('Bad quotes are constructed to match known failure shapes; this is NOT a measured rate from any AI model.\n');
console.log(`Corpus: ${DOCS.length} local docs in ./corpus   Answers: ${answers.length} (${grounded.length} grounded, ${ungrounded.length} ungrounded)   Seed: ${SEED}\n`);
console.log('id   mode        kind         cite              exact  fuzzy');
for (const a of answers) {
  const kind = a.sub ? `${a.kind}:${a.sub === 'number-flip' ? 'num' : a.changes}` : a.kind;
  console.log(
    `${a.id}  ${a.mode.padEnd(10)}  ${kind.padEnd(11)}  ${a.cite.padEnd(16)}  ${a.check.exact ? 'yes' : 'NO '}    ${a.check.fuzzy.toFixed(2)}`
  );
}
console.log('');
console.log(`Citation links that open a real file: ${linksOpen}/${answers.length}`);
console.log(`Grounded quotes verified by exact match (after normalization): ${groundedExact}/${grounded.length}`);
console.log(`Grounded quotes that a raw, un-normalized match would wrongly reject: ${groundedRawFail}/${grounded.length}`);
for (const k of ['wrong-doc', 'merged', 'paraphrase']) {
  const l = byKind(k);
  console.log(`Ungrounded ${k.padEnd(10)} caught by exact check: ${caughtExact(l)}/${l.length}`);
}
console.log('\nStrict vs loose: pass = exact OR fuzzy >= threshold');
console.log('threshold  grounded-rejected  ungrounded-accepted  paraphrase-accepted  number-flips-accepted');
console.log(`exact      ${String(grounded.length - groundedExact).padEnd(17)}  ${ungrounded.filter((a) => a.check.exact).length}                    ${paraphrases.filter((a) => a.check.exact).length}                    ${flips.filter((a) => a.check.exact).length}`);
for (const s of sweep) {
  console.log(
    `${String(s.threshold).padEnd(9)}  ${String(s.groundedRejected).padEnd(17)}  ${String(s.ungroundedAccepted).padEnd(19)}  ${String(s.paraphraseAccepted).padEnd(19)}  ${s.numberFlipsAccepted}`
  );
}
console.log(`\nHigh-overlap constructed paraphrases (token overlap >= 0.8; not a measure of human detection): ${nearMiss}/${paraphrases.length}`);
console.log(`Verify time per answer (warmed repeat reads of tiny local synthetic files; open + exact + fuzzy): median ${r3(median)} ms, max ${r3(maxMs)} ms\n`);

const metrics = [
  { name: 'citation_links_that_open', value: pct(linksOpen, answers.length), unit: '%' },
  { name: 'grounded_verified_exact', value: pct(groundedExact, grounded.length), unit: '%' },
  { name: 'grounded_rejected_without_normalization', value: groundedRawFail, unit: `of ${grounded.length}` },
  { name: 'ungrounded_caught_exact', value: pct(caughtExact(ungrounded), ungrounded.length), unit: '%' },
  { name: 'wrong_doc_caught_exact', value: pct(caughtExact(byKind('wrong-doc')), 10), unit: '%' },
  { name: 'merged_caught_exact', value: pct(caughtExact(byKind('merged')), 10), unit: '%' },
  { name: 'paraphrase_caught_exact', value: pct(caughtExact(paraphrases), paraphrases.length), unit: '%' },
  { name: 'paraphrase_accepted_fuzzy_0.9', value: at(0.9).paraphraseAccepted, unit: `of ${paraphrases.length}` },
  { name: 'number_flips_accepted_fuzzy_0.9', value: at(0.9).numberFlipsAccepted, unit: `of ${flips.length}` },
  { name: 'ungrounded_accepted_fuzzy_0.8', value: at(0.8).ungroundedAccepted, unit: `of ${ungrounded.length}` },
  { name: 'high_overlap_paraphrases_fuzzy_0.8', value: nearMiss, unit: `of ${paraphrases.length}` },
  { name: 'verify_ms_per_answer_median_warmed_local', value: r3(median), unit: 'ms' },
];

const conclusion =
  `On a small synthetic corpus, every citation link opened (${linksOpen}/${answers.length}), but an exact quote check after normalization verified ` +
  `${pct(groundedExact, grounded.length)}% of grounded quotes and caught ${pct(caughtExact(ungrounded), ungrounded.length)}% ` +
  `of the constructed bad quotes, while a loose 0.9 fuzzy check let ${at(0.9).paraphraseAccepted} of ${paraphrases.length} ` +
  `paraphrases through (${at(0.9).numberFlipsAccepted} with a changed number), at about ${r3(median)} ms per answer for warmed local checks of these tiny files.`;

const setup =
  `${DOCS.length} synthetic lab-written doc texts (not saved public documents) written to ./corpus; ${answers.length} cited answers: ${grounded.length} grounded ` +
  `(verbatim, 1 in 3 with copy noise), ${ungrounded.length} ungrounded (10 wrong-doc, 10 merged, 10 paraphrase incl. 3 number flips); ` +
  `normalize = NFKC, lowercase, punctuation to space, collapse whitespace; fuzzy = best same-length window token overlap; ` +
  `thresholds ${THRESHOLDS.join(', ')}; seed ${SEED}; failure cases constructed, not measured from any AI model; timing = warmed repeat reads of tiny local files`;

writeFileSync(
  join(HERE, 'results.json'),
  JSON.stringify(
    {
      note: 'Failure cases are constructed to match known patterns (paraphrase, merged sentence, wrong document). They are not a measured rate from any AI model or product.',
      seed: SEED,
      metrics,
      sweep,
      verifyMs: { median: r3(median), max: r3(maxMs) },
      answers: answers.map((a) => ({
        id: a.id, mode: a.mode, kind: a.kind, sub: a.sub ?? null, cite: a.cite, sourceDoc: a.sourceDoc,
        quote: a.quote, exact: a.check.exact, rawMatch: a.check.raw, fuzzy: r3(a.check.fuzzy),
      })),
      conclusion,
      setup,
    },
    null,
    2
  ) + '\n'
);

console.log('RESULT ' + JSON.stringify({ metrics, conclusion, setup }));
