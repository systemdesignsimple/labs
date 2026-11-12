// quote-check.mjs  ·  node quote-check.mjs
// Tokens keep their original span. Offsets are JavaScript UTF-16 code units.
const W = String.raw`\p{L}\p{M}\p{N}‌‍`;       // ZWNJ and ZWJ stay inside words
const NUM = String.raw`[+\-−]?(?:\p{Nd}+(?:[.,]\p{Nd}+)*|[.,]\p{Nd}+)` +
            String.raw`(?:[eE][+\-−]?\p{Nd}+)?[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]*[%‰]?`;
// An operator run is kept whole and as written: "!=" is not "=". It is a token when it holds a
// comparison sign or sits next to a digit, so "real-time" stays prose.
const OP = String.raw`[!+\-−±/×÷*^=<>≤≥≠~≈]+`;
const SYM = String.raw`[%‰°\p{Sc}]|(?<=\p{N}\s*)${OP}|${OP}(?=\s*[.,]?\p{N})|(?=[!+\-−±/×÷*^~]*[=<>≤≥≠≈])${OP}`;
const KNOWN = new Set(['+', '-', '−', '±', '/', '×', '÷', '*', '^', '~', '≈', '=', '<', '>', '≤', '≥', '≠',
                       '==', '!=', '<=', '>=', '->', '=>', '<-']);
const TOKEN = new RegExp(
  String.raw`(?<![${W}])(?<!\p{N}[^\s${W}])(?<num>${NUM})(?![${W}])(?![^\s${W}]\p{N})` +
  String.raw`|[${W}]+|(?<sym>${SYM})`, 'gu');

function tokenize(text) {
  const out = [];
  for (const m of text.matchAll(TOKEN)) {
    const raw = m[0];
    let t;
    if (m.groups.num) t = 'n:' + raw;                        // number: compared as written
    else if (m.groups.sym)                                   // sign, unit or operator: a token;
      t = (/^[%‰°\p{Sc}]$/u.test(raw) || KNOWN.has(raw) ? 's:' : 'bad:') + raw;  // "5!", "===": bad
    else if (!/\p{N}/u.test(raw)) t = 'w:' + raw.normalize('NFKC').toLowerCase();
    else if (/\p{L}/u.test(raw)) t = 'id:' + raw;            // IPv4, x², 5ms: exact
    else t = 'bad:' + raw;                                   // 1/2, 10-20, 3:00, ½
    out.push({ t, start: m.index, end: m.index + raw.length });
  }
  return out;
}

function findAll(q, d) {                       // KMP over token arrays: O(N + M)
  const fail = [0];
  for (let i = 1, k = 0; i < q.length; i++) {
    while (k && q[i] !== q[k]) k = fail[k - 1];
    if (q[i] === q[k]) k++;
    fail[i] = k;
  }
  const hits = [];
  for (let i = 0, k = 0; i < d.length; i++) {
    while (k && d[i] !== q[k]) k = fail[k - 1];
    if (d[i] === q[k]) k++;
    if (k === q.length) { hits.push(i - q.length + 1); k = fail[k - 1]; }
  }
  return hits;
}

function closest(q, d) {                       // display only: O((N - M + 1) * M)
  let best = { score: 0, at: -1 };
  for (let s = 0; s + q.length <= d.length; s++) {
    let hit = 0;
    for (let i = 0; i < q.length; i++) if (d[s + i] === q[i]) hit++;
    if (hit / q.length > best.score) best = { score: hit / q.length, at: s };
  }
  return best;
}

// A number at either end of a match must not sit next to a sign, unit, operator
// or another number just outside the match, across spaces only: "- 0.5", "5 %", "1 / 2".
const touchy = (x) => x !== undefined && /^(n|s|bad):/.test(x.t);
const isNum = (x) => /^(n|id):/.test(x.t);
function contextOk(source, dt, h, m) {
  const first = dt[h], last = dt[h + m - 1], prev = dt[h - 1], next = dt[h + m];
  const blank = (a, b) => /^\s*$/u.test(source.slice(a, b));
  if (isNum(first) && touchy(prev) && blank(prev.end, first.start)) return false;
  if (isNum(last) && touchy(next) && blank(last.end, next.start)) return false;
  return true;
}

export function checkQuote(quote, source) {
  const qt = tokenize(quote), dt = tokenize(source);
  if (qt.length === 0) return { found: false, reason: 'empty quote' };
  if (qt.some((x) => x.t.startsWith('bad:'))) return { found: false, reason: 'could not check: numeric form' };
  const q = qt.map((x) => x.t), d = dt.map((x) => x.t);
  const hits = findAll(q, d);
  if (hits.length === 0) {
    const c = closest(q, d);
    const text = c.at < 0 ? '' : source.slice(dt[c.at].start, dt[c.at + q.length - 1].end);
    return { found: false, closest: { score: c.score, text } };
  }
  const ok = hits.filter((h) => contextOk(source, dt, h, q.length));
  if (ok.length === 0) return { found: false, reason: 'could not check: numeric context' };
  const spans = ok.map((h) => ({ start: dt[h].start, end: dt[h + q.length - 1].end }));
  const { start, end } = spans[0];
  return { found: true, start, end, original: source.slice(start, end), matches: spans.length };
}

const page = 'A cache hit ratio of 90 percent means the origin serves only 1 request in 10.';
console.log(checkQuote('the origin serves only 1 request in 10', page));
console.log(checkQuote('the origin serves only 2 request in 10', page));
console.log(checkQuote('When  the  ORIGIN serves only 1 request in 10', page));
console.log(checkQuote('x != 5', 'stop if x != 5').found);  // true: the operator matches as written

// Regression cases: every line must end in false.
const bad = [['0.5', 'set it to -0.5'], ['0.5', 'set it to - 0.5'], ['2', 'wait 20 seconds'],
             ['1.000', 'about 1,000 users'], ['5', 'set to .5'], ['5', 'a 5% loss'],
             ['5', 'a 5 % loss'], ['10 2', 'about 10² requests'], ['1 2', 'use 1/2 of it'],
             ['1', 'use 1 / 2 of it'], ['!!!', 'arbitrary source'], ['अनुपस्थित', 'अर्को पाठ'],
             ['x = 5', 'x != 5'], ['x = 5', 'x ≠ 5'], ['a = b', 'a != b'], ['x <= 5', 'x < 5'],
             ['5! ways', 'there are 5! ways'], ['x === 5', 'x === 5']];
for (const [q, s] of bad) console.log(JSON.stringify(q), JSON.stringify(s), checkQuote(q, s).found);
