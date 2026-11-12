// Lab ai-3: "My chat got long. The AI forgot my name. Why?"
// Simulates a fixed context window over a scripted chat and finds the exact
// turn when a name said in message 1 stops being visible to the model.
// Node.js 22 ESM, standard library only, no network, no child processes.
// Writes one file inside this folder: trace.csv (every turn, every strategy).

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------- parameters ----------
const SEED = 20261105;
const MAX_TURNS = 200;
const BUDGETS = [4000, 8000, 32000];
const SUMMARY_BUDGET = 200; // Strategy C reserves this many tokens every turn
const PER_MESSAGE_OVERHEAD = 4; // role markers and separators per message
const REPLY_PRIMING = 3; // tokens that start the assistant reply
const NAME = 'Calm R';
const SYSTEM = 'You are a helpful assistant. Answer clearly and kindly.';

// ---------- seeded random ----------
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

// ---------- tokenizer (approximation, see README) ----------
// Splits text the way GPT-style byte-pair tokenizers pre-split it
// (optional leading space + letters, digits, punctuation, whitespace).
// Common words up to 7 letters count as 1 token; longer words are split
// into chunks of about 4 letters, which is close to how BPE breaks them.
const PIECE = / ?[A-Za-z]+| ?[0-9]{1,3}| ?[^\sA-Za-z0-9]+|\s+/g;
function countTokens(text) {
  let n = 0;
  for (const m of text.matchAll(PIECE)) {
    const letters = m[0].replace(/[^A-Za-z]/g, '').length;
    if (letters === 0) n += 1;
    else n += letters <= 7 ? 1 : Math.ceil(letters / 4);
  }
  return n;
}

// ---------- scripted chat ----------
// Filler words never contain the name, so the only place the name lives
// is the user's first message (and the pinned memory or summary).
const WORDS = (
  'the a an and or but so then if when because with for from into about over ' +
  'after before while this that these those it its we you your our they them ' +
  'is are was were be can could should would will may might need want try use ' +
  'make build add keep save show send read write check test change move start ' +
  'page screen button list table form field user users class student teacher ' +
  'task tasks note notes date time week day reminder plan planner schedule ' +
  'login password account email phone server database request response cache ' +
  'query index error message simple small quick easy clear better faster first ' +
  'next last each every some many more less one two three new old same other ' +
  'data record update delete search filter sort order group share link file ' +
  'image upload storage backup version release design layout color font mobile ' +
  'desktop browser network offline online sync conflict friend group project'
).split(/\s+/);

const TOPICS = [
  'login screen', 'task list', 'reminder emails', 'database tables', 'search box',
  'mobile layout', 'offline mode', 'file uploads', 'sharing with friends',
  'weekly schedule', 'password reset', 'dark colors', 'backup plan', 'error messages',
  'sorting tasks', 'group projects', 'release steps', 'caching pages',
];

function sentence() {
  const n = between(8, 16);
  const w = [];
  for (let i = 0; i < n; i++) w.push(pick(WORDS));
  if (n > 10 && rand() < 0.5) w[between(3, n - 3)] += ',';
  w[0] = w[0][0].toUpperCase() + w[0].slice(1);
  return w.join(' ') + (rand() < 0.15 ? '?' : '.');
}
const sentences = (k) => Array.from({ length: k }, sentence).join(' ');

function buildChat() {
  const chat = [];
  chat.push({
    turn: 1, role: 'user', topic: 'introductions',
    text: `Hi! My name is ${NAME}. I am building a small study planner app for my class, and I would like your help step by step.`,
  });
  chat.push({
    turn: 1, role: 'assistant', topic: 'introductions',
    text: 'Nice to meet you. A study planner is a great first project. Let us start with the screens you need, then the data you store, and then how people log in. Tell me what you want to build first.',
  });
  for (let t = 2; t <= MAX_TURNS; t++) {
    const topic = pick(TOPICS);
    chat.push({ turn: t, role: 'user', topic, text: `Next question about the ${topic}. ${sentences(between(2, 4))}` });
    chat.push({ turn: t, role: 'assistant', topic, text: `Good question about the ${topic}. ${sentences(between(9, 15))}` });
  }
  for (const m of chat) m.tokens = countTokens(m.text) + PER_MESSAGE_OVERHEAD;
  return chat;
}

// ---------- memory helpers ----------
const NAME_FACT = /\b[Mm]y name is ([A-Z][a-z]+(?: [A-Z][a-z]*)?)/;
function extractFacts(msgs) {
  const facts = [];
  for (const m of msgs) {
    if (m.role !== 'user') continue;
    const hit = m.text.match(NAME_FACT);
    if (hit) facts.push(`user name: ${hit[1]}.`);
  }
  return [...new Set(facts)];
}

// Strategy C: rolling rule-based summary, updated incrementally.
// Each update sees ONLY the previous summary state and the messages evicted
// since the last turn; it never re-reads the full history. The state holds
// exactly what the summary text says (count, facts, topics), nothing more.
// Facts go first so they are never cut; topics are added while the note stays
// within SUMMARY_BUDGET, and skipped once it is full.
function renderSummary(st) {
  return `Summary of ${st.count} earlier messages. ${st.facts.join(' ')} Topics so far:` +
    st.topics.map((x) => ` ${x},`).join('');
}
function updateSummary(prev, evicted) {
  const limit = SUMMARY_BUDGET - PER_MESSAGE_OVERHEAD;
  const st = { count: prev.count + evicted.length, facts: [...prev.facts], topics: [...prev.topics] };
  for (const f of extractFacts(evicted)) if (!st.facts.includes(f)) st.facts.push(f);
  if (countTokens(renderSummary(st)) > limit) throw new Error('facts alone exceed the summary budget');
  for (const m of evicted) {
    if (st.topics.includes(m.topic)) continue;
    const next = { ...st, topics: [...st.topics, m.topic] };
    if (countTokens(renderSummary(next)) > limit) continue;
    st.topics = next.topics;
  }
  return st;
}

// ---------- context window ----------
const SYS_TOK = countTokens(SYSTEM) + PER_MESSAGE_OVERHEAD;

function buildWindow(chat, t, budget, strategy, pinned, mem) {
  // What the model would see just before writing reply t.
  const cands = chat.filter((m) => m.turn < t || (m.turn === t && m.role === 'user'));
  let fixed = SYS_TOK + REPLY_PRIMING;
  if (strategy === 'B') fixed += pinned.tokens;
  if (strategy === 'C') fixed += SUMMARY_BUDGET;

  // Keep the newest messages that fit, drop the oldest.
  let room = budget - fixed;
  const kept = [];
  for (let i = cands.length - 1; i >= 0; i--) {
    if (cands[i].tokens > room) break;
    kept.unshift(cands[i]);
    room -= cands[i].tokens;
  }
  const dropped = cands.slice(0, cands.length - kept.length);

  let header = '';
  let headerTok = 0;
  if (strategy === 'B') { header = pinned.text; headerTok = pinned.tokens; }
  if (strategy === 'C') {
    // Eviction only moves forward, so newly evicted = dropped beyond last turn.
    if (dropped.length < mem.evicted) throw new Error(`eviction went backwards at turn ${t}`);
    const fresh = dropped.slice(mem.evicted);
    if (fresh.length) mem.state = updateSummary(mem.state, fresh);
    mem.evicted = dropped.length;
    if (mem.state.count) {
      header = renderSummary(mem.state);
      headerTok = countTokens(header) + PER_MESSAGE_OVERHEAD;
    }
  }
  const keptTok = kept.reduce((s, m) => s + m.tokens, 0);
  const total = SYS_TOK + REPLY_PRIMING + headerTok + keptTok;
  if (total > budget) throw new Error(`window over budget at turn ${t}`);
  const visibleText = [SYSTEM, header, ...kept.map((m) => m.text)].join('\n');
  return {
    total,
    headerTok,
    oldestTurn: kept.length ? kept[0].turn : null,
    kept: kept.length,
    dropped: dropped.length,
    nameVisible: visibleText.includes(NAME),
  };
}

// ---------- run ----------
const t0 = Date.now();
const chat = buildChat();
const pinnedText = `Memory: ${extractFacts(chat.filter((m) => m.turn === 1)).join(' ')}`;
const pinned = { text: pinnedText, tokens: countTokens(pinnedText) + PER_MESSAGE_OVERHEAD };

let turnSum = 0;
for (const m of chat) if (m.turn >= 2) turnSum += m.tokens;
const avgTurnTokens = turnSum / (MAX_TURNS - 1);

const csv = ['budget,turn,strategy,total_tokens,memory_tokens,oldest_turn_in_window,messages_in_window,messages_dropped,name_visible'];
const results = {};
for (const budget of BUDGETS) {
  const r = { forgetA: null, visible: { A: 0, B: 0, C: 0 }, maxMem: { B: 0, C: 0 }, minMemC: Infinity, rows: [] };
  const mem = { evicted: 0, state: { count: 0, facts: [], topics: [] } }; // C's rolling summary
  for (let t = 1; t <= MAX_TURNS; t++) {
    const row = { t };
    for (const s of ['A', 'B', 'C']) {
      const w = buildWindow(chat, t, budget, s, pinned, mem);
      row[s] = w;
      if (w.nameVisible) r.visible[s]++;
      if (s !== 'A') r.maxMem[s] = Math.max(r.maxMem[s], w.headerTok);
      if (s === 'C') r.minMemC = Math.min(r.minMemC, w.headerTok);
      csv.push([budget, t, s, w.total, w.headerTok, w.oldestTurn ?? '', w.kept, w.dropped, w.nameVisible ? 1 : 0].join(','));
    }
    if (r.forgetA === null && !row.A.nameVisible) r.forgetA = t;
    r.rows.push(row);
  }
  results[budget] = r;
}
writeFileSync(join(HERE, 'trace.csv'), csv.join('\n') + '\n');

// ---------- report ----------
const k = (b) => `${b / 1000}k`;
console.log(`Scripted chat: ${MAX_TURNS} turns, seed ${SEED}, average ${avgTurnTokens.toFixed(1)} approx tokens per turn (user + reply).`);
console.log('All counts are approximate token units from a heuristic splitter, not a real model vocabulary.');
console.log(`Pinned memory line: "${pinned.text}" = ${pinned.tokens} approx tokens. Summary note: ${SUMMARY_BUDGET} approx tokens reserved every turn, actual note at most that.\n`);
for (const b of BUDGETS) {
  const r = results[b];
  const predicted = Math.floor((b - SYS_TOK - REPLY_PRIMING) / avgTurnTokens) + 1;
  console.log(
    `[${k(b)}] A truncate: name gone at turn ${r.forgetA ?? 'never'} (budget / avg turn predicts about ${predicted}). ` +
    `Name visible: A ${r.visible.A}/${MAX_TURNS}, B pinned ${r.visible.B}/${MAX_TURNS}, C summary ${r.visible.C}/${MAX_TURNS}.`,
  );
}

const r8 = results[8000];
if (r8.forgetA) {
  console.log(`\n[8k] turns around the drop (strategy A vs B vs C):`);
  console.log('turn | A approx-tok oldest name | B approx-tok name | C approx-tok name');
  for (const row of r8.rows.filter((x) => Math.abs(x.t - r8.forgetA) <= 3)) {
    const f = (w) => (w.nameVisible ? 'yes' : 'NO ');
    console.log(
      `${String(row.t).padStart(4)} | ${String(row.A.total).padStart(6)} ${String(row.A.oldestTurn).padStart(6)} ${f(row.A)} | ` +
      `${String(row.B.total).padStart(6)} ${f(row.B)} | ${String(row.C.total).padStart(6)} ${f(row.C)}`,
    );
  }
}
console.log(`\nFull per-turn log written to trace.csv. Run time ${Date.now() - t0} ms.`);

const allKept = BUDGETS.every((b) => results[b].visible.B === MAX_TURNS && results[b].visible.C === MAX_TURNS);
const [a4, a8, a32] = BUDGETS.map((b) => results[b].forgetA);
const summaryMax = Math.max(...BUDGETS.map((b) => results[b].maxMem.C));
const summaryMin = Math.min(...BUDGETS.map((b) => results[b].minMemC));
const metrics = [
  ...BUDGETS.map((b) => ({ name: `truncate_forget_turn_${k(b)}`, value: results[b].forgetA ?? -1, unit: results[b].forgetA ? 'turn' : 'not reached' })),
  { name: 'avg_tokens_per_turn', value: Number(avgTurnTokens.toFixed(1)), unit: 'approx tokens' },
  ...BUDGETS.map((b) => ({ name: `pinned_name_visible_${k(b)}`, value: results[b].visible.B, unit: `of ${MAX_TURNS} turns` })),
  ...BUDGETS.map((b) => ({ name: `summary_name_visible_${k(b)}`, value: results[b].visible.C, unit: `of ${MAX_TURNS} turns` })),
  { name: 'pinned_memory_cost', value: pinned.tokens, unit: 'approx tokens per turn' },
  { name: 'summary_reserved', value: SUMMARY_BUDGET, unit: 'approx tokens per turn' },
  { name: 'summary_actual_min', value: summaryMin, unit: 'approx tokens' },
  { name: 'summary_actual_max', value: summaryMax, unit: 'approx tokens' },
];
const conclusion = allKept
  ? `Dropping the oldest messages pushed the name out of the window at turn ${a4}, ${a8} and ${a32} for 4k, 8k and 32k approximate-token budgets, so a bigger window only delays forgetting, while a ${pinned.tokens}-unit pinned memory or a rolling summary of at most ${summaryMax} units (${SUMMARY_BUDGET} reserved) kept the name visible on all ${MAX_TURNS} turns.`
  : `Dropping the oldest messages pushed the name out of the window at turn ${a4}, ${a8} and ${a32} for 4k, 8k and 32k approximate-token budgets, and the memory strategies did not keep it visible on every turn (see metrics).`;
const setup = `simulated chat, seed ${SEED}, ${MAX_TURNS} turns, name in message 1, budgets ${BUDGETS.join('/')} approximate token units from a heuristic GPT-style splitter (no real vocabulary), ${PER_MESSAGE_OVERHEAD} units overhead per message, A = keep newest that fit, B = pinned memory line, C = rolling rule-based summary updated only from its previous state plus newly evicted messages, ${SUMMARY_BUDGET} units reserved, actual note ${summaryMin} to ${summaryMax}; measures visibility in the window, not model recall`;

console.log('RESULT ' + JSON.stringify({ metrics, conclusion, setup }));
