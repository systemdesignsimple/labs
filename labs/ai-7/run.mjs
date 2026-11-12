// ai-7 lab: how many tokens does one agent task send, step by step?
// Node 22 ESM, standard library only. No network, no child processes,
// reads only its own source file (used as code-shaped text for file reads).
// Deterministic: fixed seeds, same output every run.
//
// Token counts are ESTIMATES from a simple word-piece rule, not a model
// tokenizer. The lab's claims are ratios (agent vs one chat, step 10 vs 50),
// and it re-checks those ratios with a second estimator (characters / 4).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ---------- settings ----------
const STEP_COUNTS = [5, 10, 20, 30, 50];   // N = number of model calls in one task
const MAX_N = Math.max(...STEP_COUNTS);
// Synthetic workload profiles: the SAME per-step content, cut shorter or kept longer.
// scale = share of each tool output's full (maximum) length that is kept.
const PROFILES = [
  { name: 'light', scale: 0.2 },
  { name: 'medium', scale: 0.5 },
  { name: 'heavy', scale: 1.0 },
];
const MAIN = 'medium';
const SEED = 7;
// Illustrative prices, USD per 1M tokens (shape of a common public price list,
// not a quote). Cache reads 10% of input, cache writes 125% of input.
const PRICE = { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 };

// ---------- seeded random ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Independent seed per (purpose, step): one step's content never depends on another's.
const seedFor = (tag, k) => (Math.imul(SEED, 0x9e3779b1) ^ Math.imul(tag, 0x85ebca6b) ^ Math.imul(k + 1, 0xc2b2ae35)) >>> 0;
const randInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

// ---------- token estimators (NOT a model tokenizer) ----------
// A: word-piece rule. A leading space sticks to the word (like GPT-style
// pre-tokenizers); words up to 7 letters = 1 piece, longer words +1 per 4
// letters; digits in groups of 3; symbol runs 1 piece per 2 chars; whitespace run = 1.
const TOKEN_RE = / ?[A-Za-z]+| ?\d{1,3}| ?[^\sA-Za-z\d]+|\s+/g;
function estTokens(text) {
  let n = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const core = m[0].trimStart();
    if (core.length === 0) { n += 1; continue; }
    const c = core.charCodeAt(0);
    const isAlpha = (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
    const isDigit = c >= 48 && c <= 57;
    if (isAlpha) n += core.length <= 7 ? 1 : 1 + Math.ceil((core.length - 7) / 4);
    else if (isDigit) n += 1;
    else n += Math.ceil(core.length / 2);
  }
  return n;
}
// B: the common rule of thumb, characters / 4. Used only as a cross-check.
const estChars4 = (text) => Math.ceil(text.length / 4);

// ---------- synthetic content ----------
const SOURCE = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
const WORDS = (
  'the a to of and in is it that for on with as this we you be are can not will ' +
  'file function test request response cache server user value error check change ' +
  'update return call read write build run config path module import export type ' +
  'step result before after because so then next first still need should looks ' +
  'failing passing timeout retry handler route token limit queue database index ' +
  'schema field null missing fix bug line output input history message model tool ' +
  'agent context window latency memory thread worker job event payload status ' +
  'validation middleware session login order payment invoice report summary'
).split(' ');
function sentence(rng) {
  const n = randInt(rng, 8, 18);
  const w = [];
  for (let i = 0; i < n; i++) w.push(pick(rng, WORDS));
  w[0] = w[0][0].toUpperCase() + w[0].slice(1);
  return w.join(' ') + '.';
}
const prose = (rng, n) => Array.from({ length: n }, () => sentence(rng)).join(' ');
const PATHS = ['src/api/orders.ts', 'src/api/auth.ts', 'src/lib/cache.ts', 'src/lib/db.ts',
  'src/workers/invoice.ts', 'src/routes/checkout.ts', 'test/orders.test.ts', 'test/cache.test.ts',
  'src/config/index.ts', 'src/middleware/rateLimit.ts'];

// Each tool output is a list of lines generated at FULL length from the step's
// own seed. Profiles keep the first ceil(scale * full) lines, so a lighter
// profile is an exact prefix of a heavier one: only size changes, not content.
const FULL_LINES = { read_file: [120, 440], grep: [20, 80], run_tests: [60, 240], edit_file: [16, 60], list_dir: [40, 120] };
function fullToolLines(kind, rng) {
  const n = randInt(rng, ...FULL_LINES[kind]);
  const out = [];
  if (kind === 'read_file' || kind === 'edit_file') {
    const start = randInt(rng, 0, SOURCE.length - 1);
    for (let i = 0; i < n; i++) {
      const ln = (start + i) % SOURCE.length;
      const line = `${String(ln + 1).padStart(5)}\t${SOURCE[ln]}`;
      out.push(kind === 'edit_file' ? '+ ' + line : line);
    }
  } else if (kind === 'grep') {
    for (let i = 0; i < n; i++) {
      const ln = randInt(rng, 0, SOURCE.length - 1);
      out.push(`${pick(rng, PATHS)}:${ln + 1}:${SOURCE[ln]}`);
    }
  } else if (kind === 'run_tests') {
    for (let i = 0; i < n; i++) {
      const r = rng();
      if (r < 0.75) out.push(`  PASS ${pick(rng, PATHS)} > ${sentence(rng)} (${randInt(rng, 1, 900)} ms)`);
      else if (r < 0.85) out.push(`  FAIL ${pick(rng, PATHS)} > ${sentence(rng)} Error: expected ${randInt(rng, 0, 999)} but got ${randInt(rng, 0, 999)}`);
      else out.push(`    at Object.<anonymous> (${pick(rng, PATHS)}:${randInt(rng, 1, 400)}:${randInt(rng, 1, 80)})`);
    }
  } else {
    for (let i = 0; i < n; i++) out.push(`${pick(rng, PATHS).replace(/\.ts$/, '')}_${randInt(rng, 1, 99)}.ts`);
  }
  return out;
}
const TOOL_MIX = ['read_file', 'read_file', 'read_file', 'read_file', 'grep', 'grep',
  'run_tests', 'run_tests', 'edit_file', 'edit_file', 'list_dir'];

// Step k (0-based): the model's message for call k+1, and the tool output it causes.
function makeStep(k) {
  const rng = mulberry32(seedFor(1, k));
  const kind = pick(rng, TOOL_MIX);
  const thought = prose(rng, randInt(rng, 1, 3));
  const path = pick(rng, PATHS);
  const lines = fullToolLines(kind, mulberry32(seedFor(2, k)));
  return { kind, thought, path, lines };
}
const STEPS = Array.from({ length: MAX_N }, (_, k) => makeStep(k));

// ---------- the fixed part sent with EVERY agent request ----------
const baseRng = mulberry32(seedFor(3, 0));
const rules = Array.from({ length: 12 }, (_, i) => `${i + 1}. ${sentence(baseRng)}`);
const SYSTEM = `You are a coding agent working in a repository.\n${prose(baseRng, 18)}\n\nRules:\n${rules.join('\n')}`;
const TOOLS = ['read_file', 'write_file', 'edit_file', 'grep', 'list_dir', 'run_tests',
  'run_command', 'search_web', 'git_diff', 'ask_user'].map((name) => {
  const props = {};
  for (let i = 0, k = randInt(baseRng, 2, 4); i < k; i++) {
    props[pick(baseRng, ['path', 'pattern', 'command', 'content', 'offset', 'limit', 'query', 'old_text', 'new_text'])] =
      { type: pick(baseRng, ['string', 'integer', 'boolean']), description: sentence(baseRng) };
  }
  return { name, description: prose(baseRng, 3), input_schema: { type: 'object', properties: props, required: Object.keys(props).slice(0, 1) } };
});
const TASK = `Task: ${prose(baseRng, 4)}`;
const FINAL_ANSWER = `Done. ${prose(mulberry32(seedFor(4, 0)), 5)}`;

// ---------- full serialized messages (chat-API style framing) ----------
const assistantToolMsg = (k) => ({ role: 'assistant', content: [
  { type: 'text', text: STEPS[k].thought },
  { type: 'tool_use', id: `call_${k + 1}`, name: STEPS[k].kind, input: { path: STEPS[k].path } },
] });
const toolResultMsg = (k, scale) => {
  const all = STEPS[k].lines;
  const keep = Math.max(1, Math.ceil(all.length * scale));
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: `call_${k + 1}`, content: all.slice(0, keep).join('\n') }] };
};
const finalMsg = { role: 'assistant', content: [{ type: 'text', text: FINAL_ANSWER }] };
const requestText = (messages) => JSON.stringify({ model: 'sim', system: SYSTEM, tools: TOOLS, messages });

// ---------- one agent task, request by request ----------
// Request k (1..N) = fixed part + task + every message from calls 1..k-1.
// Calls 1..N-1 each answer with a tool call; its result joins the history.
// Call N writes the final answer, so all N-1 tool results are sent at least once
// and no generated tool result is left unsent.
// Request k's input does not depend on N, so one pass to MAX_N serves every N.
function runProfile(scale, est) {
  const messages = [{ role: 'user', content: TASK }];
  const perReq = [];  // input tokens of request k
  const fresh = [];   // tokens in request k that were not in request k-1
  const toolOut = []; // output tokens if call k makes a tool call
  const resultTok = [];
  let prev = 0;
  for (let k = 0; k < MAX_N; k++) {
    const inTok = est(requestText(messages));
    perReq.push(inTok);
    fresh.push(inTok - prev);
    prev = inTok;
    const a = assistantToolMsg(k), r = toolResultMsg(k, scale);
    toolOut.push(est(JSON.stringify(a.content)));
    resultTok.push(est(JSON.stringify(r.content)));
    messages.push(a, r);
  }
  const finalOut = est(JSON.stringify(finalMsg.content));
  const baseTok = perReq[0];
  const rows = STEP_COUNTS.map((N) => {
    let totalIn = 0, newIn = 0, costPlain = 0, costCached = 0, totalOut = 0;
    for (let k = 0; k < N; k++) {
      const out = k === N - 1 ? finalOut : toolOut[k];
      totalIn += perReq[k];
      newIn += fresh[k];
      totalOut += out;
      const reread = perReq[k] - fresh[k];
      costPlain += usd(perReq[k], PRICE.input) + usd(out, PRICE.output);
      costCached += usd(reread, PRICE.cacheRead) + usd(fresh[k], PRICE.cacheWrite) + usd(out, PRICE.output);
    }
    return { N, totalIn, newIn, totalOut, repeatedShare: 1 - newIn / totalIn, lastRequest: perReq[N - 1], costPlain, costCached };
  });
  return { perReq, fresh, resultTok, baseTok, rows };
}
const usd = (tokens, per1M) => (tokens / 1e6) * per1M;

// ---------- baseline: one normal chat, same framing ----------
const chatRng = mulberry32(seedFor(5, 0));
const chatSystem = `You are a helpful assistant. ${prose(chatRng, 4)}`;
const chatQuestion = prose(chatRng, 3);
const chatAnswer = prose(chatRng, 40);
function chatTokens(est) {
  const inTok = est(JSON.stringify({ model: 'sim', system: chatSystem, messages: [{ role: 'user', content: chatQuestion }] }));
  const outTok = est(JSON.stringify([{ type: 'text', text: chatAnswer }]));
  return { inTok, outTok, cost: usd(inTok, PRICE.input) + usd(outTok, PRICE.output) };
}

// Three separate "times one chat" measures, never mixed:
//   read     = agent input tokens / chat input tokens
//   combined = agent (input + output) / chat (input + output)
//   cost     = agent illustrative cost (no cache) / chat illustrative cost
function multiples(row, chat) {
  return {
    read: row.totalIn / chat.inTok,
    combined: (row.totalIn + row.totalOut) / (chat.inTok + chat.outTok),
    cost: row.costPlain / chat.cost,
    costCached: row.costCached / chat.cost,
  };
}

// ---------- run ----------
const chat = chatTokens(estTokens);
const chatB = chatTokens(estChars4);
const results = {};
for (const p of PROFILES) results[p.name] = runProfile(p.scale, estTokens);
const mainB = runProfile(PROFILES.find((p) => p.name === MAIN).scale, estChars4);

const fmt = (n) => Math.round(n).toLocaleString('en-US');
const pct = (x) => (x * 100).toFixed(1) + '%';
const money = (x) => '$' + x.toFixed(x < 1 ? 4 : 2);
const at = (res, N) => res.rows.find((x) => x.N === N);

console.log('ai-7 lab: agent token re-reading (estimated tokens, synthetic workload)');
console.log(`One chat: ${fmt(chat.inTok)} input + ${fmt(chat.outTok)} output tokens, ${money(chat.cost)}`);
console.log(`Agent fixed part (system + 10 tool schemas + task, with framing) = request 1: ${fmt(results[MAIN].baseTok)} tokens`);
for (const p of PROFILES) {
  const r = results[p.name];
  console.log(`\nProfile ${p.name} (keeps ${pct(p.scale)} of each full tool output)`);
  console.log('  N calls | total input | new input | re-sent | last request | read x chat | combined x chat | cost x chat | cost plain | cost cached');
  for (const x of r.rows) {
    const m = multiples(x, chat);
    console.log(`  ${String(x.N).padStart(7)} | ${fmt(x.totalIn).padStart(11)} | ${fmt(x.newIn).padStart(9)} | ${pct(x.repeatedShare).padStart(7)} | ${fmt(x.lastRequest).padStart(12)} | ${fmt(m.read).padStart(11)} | ${fmt(m.combined).padStart(15)} | ${fmt(m.cost).padStart(11)} | ${money(x.costPlain).padStart(10)} | ${money(x.costCached).padStart(11)}`);
  }
}
const M = results[MAIN];
console.log(`\nPer request, profile ${MAIN}: [request k] full request size / new tokens in it (new = tool result + model message from call k-1, plus framing)`);
for (let k = 0; k < MAX_N; k += 10) {
  console.log('  ' + M.perReq.slice(k, k + 10).map((v, i) => `[${k + i + 1}] ${fmt(v)}/${fmt(M.fresh[k + i])}`).join('  '));
}
console.log(`  Tool result from call 50 (${fmt(M.resultTok[MAX_N - 1])} tokens) is not counted: in a 50-call run, call 50 writes the final answer instead of calling a tool.`);

// ---------- cross-check with the second estimator ----------
const m30 = at(M, 30), m10 = at(M, 10), m50 = at(M, 50);
const b30 = at(mainB, 30), b10 = at(mainB, 10), b50 = at(mainB, 50);
const growthA = m50.totalIn / m10.totalIn, growthB = b50.totalIn / b10.totalIn;
const readA = multiples(m30, chat).read, readB = multiples(b30, chatB).read;
console.log(`\nEstimator cross-check (${MAIN}, 30 calls): word-piece vs chars/4`);
console.log(`  read x chat ${fmt(readA)} vs ${fmt(readB)} | re-sent share ${pct(m30.repeatedShare)} vs ${pct(b30.repeatedShare)} | input growth 10 to 50 calls ${growthA.toFixed(2)}x vs ${growthB.toFixed(2)}x`);

// ---------- RESULT ----------
const mm30 = multiples(m30, chat), mm50 = multiples(m50, chat);
const exponent = Math.log(growthA) / Math.log(5);
const cacheSaving = 1 - m30.costCached / m30.costPlain;
const l30 = multiples(at(results.light, 30), chat), h30 = multiples(at(results.heavy, 30), chat);
// Smallest N (of those run) whose illustrative cost passes 1,000 chats, from the cost metric only.
const costPass = M.rows.find((x) => multiples(x, chat).cost >= 1000);

const conclusion =
  `In this synthetic ${MAIN} workload, every call re-sends the whole history, so 5x more calls (10 to 50) means ${growthA.toFixed(1)}x more input tokens; ` +
  `a 30-call task sends ${fmt(mm30.read)}x the input tokens of one chat (${pct(m30.repeatedShare)} of it re-sent history) and costs ${fmt(mm30.cost)}x one chat at illustrative prices, ` +
  (costPass ? `passing 1,000 chats in cost by ${costPass.N} calls` : `not reaching 1,000 chats in cost even at ${MAX_N} calls (${fmt(mm50.cost)}x)`) +
  `, while prompt caching cuts that 30-call cost by ${pct(cacheSaving)} without reducing tokens.`;

const out = {
  metrics: [
    { name: 'one chat input tokens (estimated)', value: chat.inTok, unit: 'tokens' },
    { name: 'one chat output tokens (estimated)', value: chat.outTok, unit: 'tokens' },
    { name: 'agent request 1 size (fixed part)', value: M.baseTok, unit: 'tokens' },
    { name: `${MAIN} 30-call total input`, value: m30.totalIn, unit: 'tokens' },
    { name: `${MAIN} request 30 size`, value: M.perReq[29], unit: 'tokens' },
    { name: `${MAIN} new tokens in request 30`, value: M.fresh[29], unit: 'tokens' },
    { name: `${MAIN} 30-call re-sent history share`, value: +(m30.repeatedShare * 100).toFixed(1), unit: '%' },
    { name: `${MAIN} 30-call input vs one chat input (read multiple)`, value: Math.round(mm30.read), unit: 'x' },
    { name: `${MAIN} 30-call input+output vs one chat input+output`, value: Math.round(mm30.combined), unit: 'x' },
    { name: `${MAIN} 30-call illustrative cost vs one chat (no cache)`, value: Math.round(mm30.cost), unit: 'x' },
    { name: `${MAIN} 50-call illustrative cost vs one chat (no cache)`, value: Math.round(mm50.cost), unit: 'x' },
    { name: 'light 30-call cost vs one chat', value: Math.round(l30.cost), unit: 'x' },
    { name: 'heavy 30-call cost vs one chat', value: Math.round(h30.cost), unit: 'x' },
    { name: `${MAIN} input growth for 5x more calls (10 to 50)`, value: +growthA.toFixed(2), unit: 'x' },
    { name: 'growth exponent (1 = linear, 2 = square)', value: +exponent.toFixed(2), unit: '' },
    { name: `${MAIN} input growth 10 to 50, chars/4 estimator`, value: +growthB.toFixed(2), unit: 'x' },
    { name: `${MAIN} 30-call read multiple, chars/4 estimator`, value: Math.round(readB), unit: 'x' },
    { name: `${MAIN} 30-call illustrative cost, no cache`, value: +m30.costPlain.toFixed(4), unit: 'USD' },
    { name: `${MAIN} 30-call illustrative cost, with cache`, value: +m30.costCached.toFixed(4), unit: 'USD' },
    { name: 'cache saving at 30 calls', value: +(cacheSaving * 100).toFixed(1), unit: '%' },
  ],
  conclusion,
  setup: `N calls ${STEP_COUNTS.join('/')} (calls 1..N-1 use a tool, call N answers); synthetic profiles light/medium/heavy keep 20/50/100% of the same per-step tool outputs; ` +
    `independent per-step seeds from base seed ${SEED}; each full request serialized as JSON and counted; tokens estimated by a word-piece rule (cross-checked with chars/4), not a model tokenizer; ` +
    `code-shaped text from this lab's own source; illustrative USD per 1M: input ${PRICE.input}, output ${PRICE.output}, cache read ${PRICE.cacheRead}, cache write ${PRICE.cacheWrite}; simulation, not a billed run`,
};
console.log('RESULT ' + JSON.stringify(out));
