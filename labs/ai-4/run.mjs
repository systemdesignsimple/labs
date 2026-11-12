// AI #4 lab: RAG, retrieve then generate.
// Question: when you ask one question about a 100-page document, how often does
// retrieval bring back the passage that holds the answer, and how much less does
// the model have to read than the whole document?
//
// Node.js 22, standard library only, no network, no files written. Fixed seed.

const SEED = 404;
const PAGES_PER_SECTION = 10;
const WORDS_PER_PAGE = 500;
const CHUNK_WORDS = 300;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const TRIGRAM_WEIGHT = 0.2;
const CHARS_PER_TOKEN = 4;
const KS = [1, 3, 5];

// ---------- seeded random ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- the made-up handbook ----------
const SECTIONS = [
  { name: 'Workplace and facilities', nouns: ['parking garage', 'visitor lot', 'cafeteria', 'kitchen', 'gym', 'meeting room', 'thermostat', 'bicycle rack', 'locker', 'reception', 'elevator', 'desk', 'floor plan', 'loading dock', 'building', 'canteen menu'] },
  { name: 'Security', nouns: ['access badge', 'password', 'guest wifi', 'server room', 'camera', 'alarm', 'shredder', 'confidential file', 'laptop lock', 'security desk', 'visitor log', 'two-factor code', 'lanyard'] },
  { name: 'IT and devices', nouns: ['laptop', 'company phone', 'help desk ticket', 'software license', 'monitor', 'keyboard', 'shared drive', 'backup', 'account', 'network', 'printer', 'mobile device'] },
  { name: 'Finance', nouns: ['expense report', 'receipt', 'invoice', 'budget', 'corporate card', 'approval', 'payroll calendar', 'reimbursement', 'purchase order', 'salary statement'] },
  { name: 'People', nouns: ['annual leave', 'vacation plan', 'performance review', 'intern program', 'stipend', 'overtime', 'salary band', 'benefit', 'training', 'onboarding', 'parental leave', 'sick day'] },
  { name: 'Engineering', nouns: ['code review', 'deployment', 'release', 'server', 'production database', 'incident', 'pull request', 'test suite', 'branch', 'backup job', 'on-call rota'] },
  { name: 'Travel', nouns: ['business trip', 'flight', 'hotel', 'meal allowance', 'taxi', 'booking', 'travel policy', 'visa', 'per diem', 'train ticket'] },
  { name: 'Safety', nouns: ['fire drill', 'evacuation route', 'first aid kit', 'spill', 'equipment', 'alarm', 'emergency exit', 'safety officer', 'fire extinguisher'] },
  { name: 'Communication', nouns: ['meeting', 'calendar', 'email', 'chat channel', 'conference room', 'announcement', 'video call', 'newsletter'] },
  { name: 'Customers', nouns: ['customer', 'client account', 'support case', 'refund', 'contract', 'complaint', 'service level', 'renewal', 'discount'] },
];
const ALL_NOUNS = SECTIONS.flatMap((s) => s.nouns);
const STAFF = ['employees', 'staff', 'managers', 'contractors', 'team leads', 'new hires', 'interns', 'remote workers', 'visitors', 'everyone'];
const TEAMS = ['facilities', 'security', 'IT', 'finance', 'people', 'engineering', 'travel', 'safety', 'legal', 'operations'];
const VERBS = ['check', 'update', 'review', 'report', 'confirm', 'record', 'follow', 'renew', 'request', 'return', 'keep'];
const ADV = ['before the end of each quarter', 'when asked by a manager', 'at least once a year', 'as described on the intranet', 'during normal office hours', 'after any change', 'in the shared tracker', 'before leaving the building', 'within the agreed time'];
const FREQ = ['every week', 'every month', 'each quarter', 'twice a year', 'once a year'];
const FREQ2 = ['last spring', 'in the previous quarter', 'after the annual audit', 'earlier this year'];
const STATES = ['missing', 'damaged', 'late', 'unclear', 'out of date', 'unavailable', 'lost'];

function noun(section) {
  return rand() < 0.75 ? pick(SECTIONS[section].nouns) : pick(ALL_NOUNS);
}
const TEMPLATES = [
  (s) => `${cap(pick(STAFF))} should ${pick(VERBS)} the ${noun(s)} ${pick(ADV)}.`,
  (s) => `The ${noun(s)} policy applies to ${pick(STAFF)} in every office.`,
  (s) => `Questions about the ${noun(s)} go to the ${pick(TEAMS)} team.`,
  (s) => `If the ${noun(s)} is ${pick(STATES)}, ${pick(STAFF)} should contact the ${pick(TEAMS)} team.`,
  (s) => `The ${pick(TEAMS)} team reviews the ${noun(s)} process ${pick(FREQ)}.`,
  (s) => `Please read the ${noun(s)} guidelines before you ${pick(VERBS)} any ${noun(s)}.`,
  (s) => `The ${pick(TEAMS)} team updates the ${noun(s)} page ${pick(FREQ)}.`,
  (s) => `Changes to the ${noun(s)} are announced ${pick(ADV)}.`,
  (s) => `A short guide to the ${noun(s)} and the ${noun(s)} is on the intranet.`,
  (s) => `${cap(pick(STAFF))} who need help with the ${noun(s)} can ask the ${pick(TEAMS)} team ${pick(ADV)}.`,
  (s) => `Every ${noun(s)} request is logged in the ${pick(TEAMS)} tracker.`,
  (s) => `The ${noun(s)} rules were last updated ${pick(FREQ2)}.`,
];

// 30 planted facts. Every fact is asked twice: once reusing the answer's own words
// (same) and once paraphrased (para), so each fact is its own control and wording
// is the only thing that changes between the two questions.
// set 'tuning' (facts 16 to 30): the synonym map below was written while looking at
//   these paraphrases, so their paraphrase results are tailored by construction.
// set 'later' (facts 1 to 15): these paraphrases were written after the synonym map
//   was frozen, and no synonym was added for them. Same author, so this is a weaker
//   check than a truly independent test set.
const FACTS = [
  { s: 1, set: 'later', answer: 'The guest wifi password rotates every 14 days and is posted at the front desk.', same: 'How often does the guest wifi password rotate?', para: 'How often does the internet code for visitors change?' },
  { s: 6, set: 'later', answer: 'Employees may expense up to 45 dollars per day for meals while traveling.', same: 'How much can employees expense per day for meals while traveling?', para: 'What is the daily food budget on a work journey?' },
  { s: 1, set: 'later', answer: 'Lost access badges are replaced by the security desk for a fee of 20 dollars.', same: 'What fee does the security desk charge to replace lost access badges?', para: 'How much do I pay if I misplace my ID card?' },
  { s: 2, set: 'later', answer: 'New laptops are shipped to remote staff within 5 business days of the start date.', same: 'How soon are new laptops shipped to remote staff?', para: 'How long does it take for a work computer to reach someone who works from home?' },
  { s: 0, set: 'later', answer: 'The parking garage closes at 11 pm on weekdays.', same: 'When does the parking garage close on weekdays?', para: 'Until what time can I leave my car in the company car park during the week?' },
  { s: 3, set: 'later', answer: 'Payroll is deposited on the 25th of every month.', same: 'When is payroll deposited every month?', para: 'Which day of the month do salaries arrive in our bank accounts?' },
  { s: 4, set: 'later', answer: 'Annual leave requests must be submitted at least 3 weeks in advance.', same: 'How far in advance must annual leave requests be submitted?', para: 'How early do I have to ask for vacation days?' },
  { s: 1, set: 'later', answer: 'Server room access requires two-factor authentication and a manager escort.', same: 'What does server room access require?', para: 'What do I need to get into the room where the company machines run?' },
  { s: 9, set: 'later', answer: 'Customer refunds over 500 dollars need approval from the finance director.', same: 'Who must approve customer refunds over 500 dollars?', para: 'Who signs off when we give a client more than 500 dollars back?' },
  { s: 7, set: 'later', answer: 'The fire assembly point is the north corner of the visitor lot.', same: 'Where is the fire assembly point?', para: 'Where do we gather outside if the building has to be evacuated?' },
  { s: 5, set: 'later', answer: 'Production database backups are kept for 35 days.', same: 'How long are production database backups kept?', para: 'How long do we hold on to copies of the main live data?' },
  { s: 4, set: 'later', answer: 'Interns receive a monthly stipend of 900 dollars.', same: 'What monthly stipend do interns receive?', para: 'How much are trainees paid each month?' },
  { s: 0, set: 'later', answer: 'The cafeteria serves breakfast from 7 to 9 am.', same: 'When does the cafeteria serve breakfast?', para: 'What time is the morning meal available in the canteen?' },
  { s: 5, set: 'later', answer: 'Code reviews must be completed within 2 working days.', same: 'How quickly must code reviews be completed?', para: 'How long do reviewers have to look at a colleague\'s changes?' },
  { s: 2, set: 'later', answer: 'Company phones are upgraded every 30 months.', same: 'How often are company phones upgraded?', para: 'How long before I get a new work mobile?' },
  { s: 0, set: 'tuning', answer: 'The office thermostat is set to 22 degrees in winter.', same: 'What is the office thermostat set to in winter?', para: 'How warm is the workplace heating kept during the cold months?' },
  { s: 2, set: 'tuning', answer: 'Shared drive files untouched for 2 years are archived automatically.', same: 'When are shared drive files archived automatically?', para: 'What happens to old documents in the team folder that nobody has opened in a long time?' },
  { s: 0, set: 'tuning', answer: 'Visitors must be signed in at reception and wear a red lanyard.', same: 'What must visitors wear after being signed in at reception?', para: 'What should a guest do when they arrive at the front desk?' },
  { s: 2, set: 'tuning', answer: 'The help desk answers tickets within 4 hours during business hours.', same: 'How quickly does the help desk answer tickets?', para: 'How fast does IT support respond to a request?' },
  { s: 0, set: 'tuning', answer: 'Bicycles may be stored in the basement cage beside the loading dock.', same: 'Where may bicycles be stored?', para: 'Where can I keep my bike at the office?' },
  { s: 3, set: 'tuning', answer: 'Expense receipts must be uploaded within 30 days of purchase.', same: 'How soon must expense receipts be uploaded after purchase?', para: 'What is the deadline to submit proof of spending?' },
  { s: 4, set: 'tuning', answer: 'Parental leave is 16 weeks at full pay.', same: 'How long is parental leave?', para: 'How much time off do new mothers and fathers get?' },
  { s: 5, set: 'tuning', answer: 'Production deployments are frozen during the last week of December.', same: 'When are production deployments frozen?', para: 'When are we not allowed to release software to live servers?' },
  { s: 1, set: 'tuning', answer: 'Confidential documents must be shredded in the locked bins on each floor.', same: 'Where must confidential documents be shredded?', para: 'How do I get rid of secret paperwork?' },
  { s: 0, set: 'tuning', answer: 'The gym in building B is free for all staff.', same: 'Is the gym in building B free for staff?', para: 'Do employees pay to use the fitness center?' },
  { s: 1, set: 'tuning', answer: 'The password managers approved by IT are 1Vault and KeyChest.', same: 'Which password managers are approved by IT?', para: 'Which credential storage tools are we allowed to use?' },
  { s: 4, set: 'tuning', answer: 'Overtime is paid at 1.5 times the hourly rate.', same: 'What rate is overtime paid at?', para: 'How much extra do I earn for working additional hours?' },
  { s: 4, set: 'tuning', answer: 'Performance reviews take place every April and October.', same: 'When do performance reviews take place?', para: 'When are staff evaluations held?' },
  { s: 8, set: 'tuning', answer: 'Meeting rooms can be booked up to 60 days ahead.', same: 'How far ahead can meeting rooms be booked?', para: 'How far in advance can I reserve a conference space?' },
  { s: 7, set: 'tuning', answer: 'Spilled coffee on equipment must be reported to facilities within 1 hour.', same: 'When must spilled coffee on equipment be reported to facilities?', para: 'What should I do if a beverage damages my computer?' },
];

const wordCount = (t) => t.split(/\s+/).filter(Boolean).length;

// Build 100 pages of filler, then plant each fact on its own page in its section.
const pages = [];
for (let s = 0; s < SECTIONS.length; s++) {
  for (let p = 0; p < PAGES_PER_SECTION; p++) {
    const sentences = [{ text: `Section ${s + 1}: ${SECTIONS[s].name}. Page ${s * PAGES_PER_SECTION + p + 1}.`, fact: -1 }];
    let words = wordCount(sentences[0].text);
    while (words < WORDS_PER_PAGE) {
      const text = pick(TEMPLATES)(s);
      sentences.push({ text, fact: -1 });
      words += wordCount(text);
    }
    pages.push({ section: s, sentences });
  }
}
const freePages = SECTIONS.map((_, s) => shuffle([...Array(PAGES_PER_SECTION).keys()]).map((p) => s * PAGES_PER_SECTION + p));
FACTS.forEach((f, i) => {
  const page = pages[freePages[f.s].shift()];
  const at = 1 + Math.floor(rand() * (page.sentences.length - 1));
  page.sentences.splice(at, 0, { text: f.answer, fact: i });
});
const allSentences = pages.flatMap((p) => p.sentences);
const docText = allSentences.map((x) => x.text).join(' ');
const docWords = wordCount(docText);

// Chunk on sentence boundaries, about CHUNK_WORDS words each, no overlap.
const chunks = [];
let cur = { text: [], words: 0, facts: [] };
for (const sen of allSentences) {
  cur.text.push(sen.text);
  cur.words += wordCount(sen.text);
  if (sen.fact >= 0) cur.facts.push(sen.fact);
  if (cur.words >= CHUNK_WORDS) { chunks.push(cur); cur = { text: [], words: 0, facts: [] }; }
}
if (cur.text.length) chunks.push(cur);
chunks.forEach((c) => { c.text = c.text.join(' '); });
const answerChunk = FACTS.map((_, i) => chunks.findIndex((c) => c.facts.includes(i)));

// ---------- text processing shared by both retrievers ----------
const STOP = new Set('a an the is are was be been to of in on at for and or do does did how what when where who which why my i we our us you your can may must should will would get got much it its if by with from as that this these those their they them up into each every all any per about nobody has have had not no so than then there here use used just also only very far long'.split(' '));
function norm(w) {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}
function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => !STOP.has(w)).map(norm);
}

// ---------- retriever 1: keyword search (BM25) ----------
const chunkTokens = chunks.map((c) => tokenize(c.text));
const N = chunks.length;
const avgdl = chunkTokens.reduce((a, t) => a + t.length, 0) / N;
const tfs = chunkTokens.map((toks) => { const m = new Map(); for (const t of toks) m.set(t, (m.get(t) || 0) + 1); return m; });
const df = new Map();
for (const m of tfs) for (const t of m.keys()) df.set(t, (df.get(t) || 0) + 1);
function bm25Scores(query) {
  const terms = [...new Set(tokenize(query))];
  return tfs.map((m, i) => {
    let score = 0;
    for (const t of terms) {
      const tf = m.get(t) || 0;
      if (!tf) continue;
      const d = df.get(t);
      const idf = Math.log(1 + (N - d + 0.5) / (d + 0.5));
      score += idf * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * chunkTokens[i].length / avgdl));
    }
    return score;
  });
}

// ---------- retriever 2: synonym-expanded TF-IDF ----------
// This is NOT an embedding model: no packages and no network are allowed, so none
// can run here. It maps words to shared ids with a hand-written synonym list, adds
// character trigrams so close spellings still overlap, weights features by TF-IDF
// and compares with cosine similarity. Results describe this algorithm only.
// The list is FROZEN: it was written against the 'tuning' paraphrases and was not
// edited for the 'later' paraphrases.
const SYNONYMS = [
  ['guest', 'visitor'], ['wifi', 'wireless'], ['password', 'passphrase', 'credential'],
  ['rotate', 'rotated', 'change', 'changed'], ['often', 'frequently', 'frequency'],
  ['expense', 'spending', 'spend', 'reimburse', 'reimbursement', 'allowance'],
  ['meal', 'food', 'lunch', 'dinner', 'breakfast'], ['travel', 'traveling', 'travelling', 'trip', 'journey'],
  ['day', 'daily'], ['badge', 'id', 'card'], ['lost', 'missing'], ['replace', 'replaced', 'replacement'],
  ['fee', 'cost', 'charge', 'price'], ['laptop', 'computer', 'notebook'], ['remote', 'home'],
  ['employee', 'staff', 'worker'], ['ship', 'shipped', 'receive', 'delivered', 'deliver', 'sent'],
  ['parking', 'park', 'car'], ['garage', 'lot'], ['close', 'closed', 'locked', 'lock', 'shut'],
  ['weekday', 'monday', 'friday'], ['payroll', 'salary', 'wage', 'pay', 'paid', 'stipend', 'earn'],
  ['deposit', 'deposited', 'transfer'], ['month', 'monthly'], ['leave', 'vacation', 'holiday'],
  ['advance', 'early', 'ahead', 'beforehand'], ['submit', 'submitted', 'upload', 'uploaded'],
  ['request', 'ask', 'ticket'], ['server', 'datacenter'], ['access', 'enter', 'entry'],
  ['require', 'need', 'needed', 'required'], ['customer', 'client'],
  ['approve', 'approval', 'approved', 'sign', 'allowed', 'permitted'], ['fire', 'evacuation', 'emergency', 'evacuate'],
  ['assembly', 'gather', 'gathering'], ['database', 'data'], ['backup', 'snapshot'],
  ['kept', 'keep', 'retention', 'retain', 'stored', 'store', 'storage'], ['production', 'live'],
  ['intern', 'trainee'], ['cafeteria', 'canteen'], ['code', 'software'],
  ['review', 'evaluation', 'check', 'checking', 'checked', 'appraisal'], ['complete', 'completed', 'finish', 'deadline'],
  ['phone', 'mobile'], ['upgrade', 'upgraded', 'new'], ['thermostat', 'heating', 'temperature', 'warm', 'degree'],
  ['winter', 'cold'], ['office', 'workplace'], ['document', 'paperwork', 'file'], ['archive', 'archived'],
  ['old', 'untouched', 'unused', 'stale'], ['support', 'help'], ['respond', 'answer', 'reply'],
  ['bicycle', 'bike'], ['receipt', 'proof'], ['parental', 'mother', 'father', 'parent'],
  ['deployment', 'release', 'deploy'], ['frozen', 'freeze', 'blocked'], ['confidential', 'secret', 'sensitive'],
  ['shred', 'shredded', 'destroy', 'dispose'], ['gym', 'fitness'], ['overtime', 'extra', 'additional'],
  ['meeting', 'conference'], ['room', 'space'], ['book', 'booked', 'reserve', 'booking', 'reserved'],
  ['coffee', 'drink', 'beverage'], ['spill', 'spilled', 'drop', 'dropped'], ['equipment', 'device', 'hardware'],
  ['damage', 'damaged', 'broken'], ['report', 'reported', 'tell', 'notify', 'inform'],
  ['reception', 'lobby'], ['hour', 'hourly'], ['week', 'weekly'], ['quickly', 'fast', 'soon', 'quick'],
];
const MEANING = new Map();
for (const group of SYNONYMS) for (const w of group) MEANING.set(norm(w), norm(group[0]));

function synonymFeatures(text) {
  const f = new Map();
  const add = (k, w) => f.set(k, (f.get(k) || 0) + w);
  for (const tok of tokenize(text)) {
    add('m:' + (MEANING.get(tok) ?? tok), 1);
    const p = '#' + tok + '#';
    for (let i = 0; i + 3 <= p.length; i++) add('t:' + p.slice(i, i + 3), TRIGRAM_WEIGHT);
  }
  return f;
}
const chunkFeats = chunks.map((c) => synonymFeatures(c.text));
const fdf = new Map();
for (const m of chunkFeats) for (const k of m.keys()) fdf.set(k, (fdf.get(k) || 0) + 1);
const idfOf = (k) => Math.log((N + 1) / ((fdf.get(k) || 0) + 1)) + 1;
function toVector(feats) {
  const v = new Map();
  let n2 = 0;
  for (const [k, raw] of feats) { const w = Math.log1p(raw) * idfOf(k); v.set(k, w); n2 += w * w; }
  return { v, norm: Math.sqrt(n2) || 1 };
}
const chunkVecs = chunkFeats.map(toVector);
function synonymTfidfScores(query) {
  const q = toVector(synonymFeatures(query));
  return chunkVecs.map((c) => {
    let dot = 0;
    for (const [k, w] of q.v) { const cw = c.v.get(k); if (cw) dot += w * cw; }
    return dot / (q.norm * c.norm);
  });
}

// ---------- evaluate ----------
function ranking(scores) {
  return scores.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).map((x) => x[1]);
}
const METHODS = { keyword_bm25: bm25Scores, synonym_tfidf: synonymTfidfScores };
const LABEL = { keyword_bm25: 'keyword BM25', synonym_tfidf: 'synonym TF-IDF' };
const WORDINGS = ['same', 'para'];
const WORDING_LABEL = { same: 'same words', para: 'paraphrased' };
const tokensOf = (text) => Math.ceil(text.length / CHARS_PER_TOKEN);

const results = {};
for (const [name, fn] of Object.entries(METHODS)) {
  results[name] = FACTS.map((f, i) => {
    const row = { i, set: f.set };
    for (const w of WORDINGS) {
      const order = ranking(fn(f[w]));
      const top3 = order.slice(0, 3);
      row[w] = { rank: order.indexOf(answerChunk[i]) + 1, top3Tokens: top3.reduce((a, c) => a + tokensOf(chunks[c].text), 0) };
    }
    return row;
  });
}
const sel = (rows, set) => rows.filter((r) => !set || r.set === set);
const hits = (rows, w, k, set) => sel(rows, set).filter((r) => r[w].rank <= k).length;
const rate = (rows, w, k, set) => hits(rows, w, k, set) / sel(rows, set).length;
function paired(rows, k) {
  const c = { both: 0, sameOnly: 0, paraOnly: 0, neither: 0 };
  for (const r of rows) {
    const a = r.same.rank <= k;
    const b = r.para.rank <= k;
    c[a && b ? 'both' : a ? 'sameOnly' : b ? 'paraOnly' : 'neither']++;
  }
  return c;
}
// Average top-3 reading cost over all questions (both wordings) for one retriever.
const avgTop3 = (rows) => rows.reduce((a, r) => a + r.same.top3Tokens + r.para.top3Tokens, 0) / (rows.length * 2);

const fullTokens = tokensOf(docText);
const pct = (x) => Math.round(x * 1000) / 10;
const r1 = (x) => Math.round(x * 10) / 10;
const n = FACTS.length;
const nLater = FACTS.filter((f) => f.set === 'later').length;
const nTuning = n - nLater;

console.log(`Handbook: ${pages.length} pages, ${docWords} words, ${chunks.length} chunks of about ${CHUNK_WORDS} words, about ${fullTokens} tokens in total.`);
console.log(`Facts: ${n}, each asked twice (same words, paraphrased) = ${n * 2} questions. Seed ${SEED}.`);
console.log(`Paraphrase sets: tuning = ${nTuning} (synonym map written against them), later = ${nLater} (written after the map was frozen).\n`);

console.log('Recall: is the chunk holding the answer in the top k? (same facts for both wordings)');
console.log('method          wording       @1      @3      @5');
for (const name of Object.keys(METHODS)) {
  for (const w of WORDINGS) {
    const cells = KS.map((k) => `${pct(rate(results[name], w, k))}%`.padEnd(8)).join('');
    console.log(`${LABEL[name].padEnd(16)}${WORDING_LABEL[w].padEnd(14)}${cells}`);
  }
}

console.log('\nParaphrased recall@3 by set:');
for (const name of Object.keys(METHODS)) {
  console.log(`  ${LABEL[name].padEnd(16)} tuning ${hits(results[name], 'para', 3, 'tuning')}/${nTuning}   later ${hits(results[name], 'para', 3, 'later')}/${nLater}`);
}

console.log('\nPaired @3, same fact asked two ways: both found / same words only / paraphrase only / neither');
for (const name of Object.keys(METHODS)) {
  const p = paired(results[name], 3);
  console.log(`  ${LABEL[name].padEnd(16)} ${p.both} / ${p.sameOnly} / ${p.paraOnly} / ${p.neither}`);
}

console.log(`\nWhat the model reads, averaged over all ${n * 2} questions. Whole document: about ${fullTokens} tokens.`);
for (const name of Object.keys(METHODS)) {
  const t = avgTop3(results[name]);
  console.log(`  ${LABEL[name].padEnd(16)} top 3 chunks about ${Math.round(t)} tokens (${r1(fullTokens / t)}x less)`);
}
console.log('');

for (const name of Object.keys(METHODS)) {
  const misses = results[name].flatMap((r) => WORDINGS.filter((w) => r[w].rank > 3).map((w) => ({ r, w })));
  console.log(`${LABEL[name]} misses (answer not in top 3): ${misses.length}`);
  for (const { r, w } of misses) {
    const tag = w === 'para' ? `paraphrased/${r.set}` : 'same words';
    console.log(`  [${tag}] rank ${r[w].rank}: ${FACTS[r.i][w]}`);
  }
}
console.log('');

const metrics = [];
for (const name of Object.keys(METHODS)) {
  const rows = results[name];
  for (const w of WORDINGS) for (const k of KS) metrics.push({ name: `${name}_recall_at_${k}_${w}`, value: pct(rate(rows, w, k)), unit: '%' });
  metrics.push({ name: `${name}_recall_at_3_para_tuning`, value: pct(rate(rows, 'para', 3, 'tuning')), unit: '%' });
  metrics.push({ name: `${name}_recall_at_3_para_later`, value: pct(rate(rows, 'para', 3, 'later')), unit: '%' });
  const p = paired(rows, 3);
  metrics.push({ name: `${name}_paired_at_3_both`, value: p.both, unit: 'facts' });
  metrics.push({ name: `${name}_paired_at_3_same_only`, value: p.sameOnly, unit: 'facts' });
  metrics.push({ name: `${name}_paired_at_3_para_only`, value: p.paraOnly, unit: 'facts' });
  metrics.push({ name: `${name}_paired_at_3_neither`, value: p.neither, unit: 'facts' });
  const t = avgTop3(rows);
  metrics.push({ name: `${name}_top3_tokens_avg`, value: Math.round(t), unit: 'tokens' });
  metrics.push({ name: `${name}_reading_reduction`, value: r1(fullTokens / t), unit: 'x' });
}
metrics.push({ name: 'full_document_tokens', value: fullTokens, unit: 'tokens' });
metrics.push({ name: 'chunks', value: chunks.length, unit: 'chunks' });

const kw = results.keyword_bm25;
const sy = results.synonym_tfidf;
const conclusion = `On this synthetic handbook, top-3 retrieval cut reading from about ${fullTokens} tokens to about ${Math.round(avgTop3(kw))} with keyword BM25 or ${Math.round(avgTop3(sy))} with synonym TF-IDF; asking the same ${n} facts two ways, keyword BM25 found ${hits(kw, 'same', 3)}/${n} same-word but only ${hits(kw, 'para', 3)}/${n} paraphrased questions, while the hand-tailored synonym TF-IDF found ${hits(sy, 'same', 3)}/${n} and ${hits(sy, 'para', 3)}/${n} (${hits(sy, 'para', 3, 'tuning')}/${nTuning} on paraphrases its synonym map was written for, ${hits(sy, 'para', 3, 'later')}/${nLater} on paraphrases written after the map was frozen).`;
const setup = `seed=${SEED}; synthetic handbook ${pages.length} pages, ${docWords} words; ${n} planted facts, each asked with same words and paraphrased (${n * 2} questions); paraphrase sets tuning=${nTuning}, later=${nLater}; sentence-aligned chunks of ~${CHUNK_WORDS} words (${chunks.length}); BM25 k1=${BM25_K1} b=${BM25_B}; synonym TF-IDF = frozen hand-written synonym map + char trigrams (weight ${TRIGRAM_WEIGHT}), TF-IDF cosine, not an embedding model; tokens = chars/${CHARS_PER_TOKEN}`;
console.log('RESULT ' + JSON.stringify({ metrics, conclusion, setup }));
