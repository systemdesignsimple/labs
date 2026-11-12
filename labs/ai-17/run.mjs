// AI 17 lab: same question 10 times, different answers. Which one passes?
// Node.js 22 ESM, standard library only. No network: the "model" is a seeded
// in-process sampler, so every run gives the same numbers.

import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

// ---------- setup ----------
const SEED = 17;
const TEMPERATURE = 0.8;
const ASKS = 10;            // the question asked 10 times
const LONG_RUN = 1000;      // same pipeline, 1000 asks, to show the long-run shape
const MAX_RETRIES = 1;      // guardrail retries once
const MODEL_MS = [700, 1300]; // simulated model latency range per call (virtual clock)

const POLICY = {
  text: 'Full refund of the item price within 14 days. 50% of the item price from day 15 to day 30, rounded half up to the cent. No refund after day 30. Shipping is never refunded. No replacements, store credit or other extras may be promised.',
  fullDays: 14,
  partialDays: 30,
  partialRate: 0.5,
  forbidden: /replacement|store credit|return shipping|free shipping|bonus|discount|voucher|guarantee/i,
};

const CASES = {
  main: { name: 'main', itemCents: 8000, shipCents: 800, days: 20 },
  // Harder case, used only if all 10 main replies pass: day 30 boundary and a cent to round.
  hard: { name: 'hard', itemCents: 7999, shipCents: 800, days: 30 },
};

function expected(c) {
  if (c.days <= POLICY.fullDays) return { decision: 'full', cents: c.itemCents };
  if (c.days <= POLICY.partialDays) return { decision: 'partial', cents: Math.round(c.itemCents * POLICY.partialRate) };
  return { decision: 'none', cents: 0 };
}
const dollars = (cents) => Math.round(cents) / 100;

// ---------- seeded randomness ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

// ---------- the simulated "model" ----------
// No model is called. Each variant is a reply WE authored to look like a kind of
// reply models give to this prompt. Logits set how likely each authored category is.
// TEMPERATURE here only reshapes that authored category distribution (softmax over
// categories); it does not reproduce how a real model samples tokens.
// Two hidden labels a human grader would give, which the guardrail never sees:
//   sound   = the REASONING is right (says nothing about the format).
//   correct = the whole answer is right: follows the requested JSON contract exactly,
//             right decision and amount, no forbidden promise, AND sound reasoning.
// Correctness is set by hand per variant (CORRECT_VARIANTS), not derived from the checks.
const VARIANTS = [
  { id: 'correct_window', logit: { main: 2.0, hard: 1.2 }, format: 'json', sound: true,
    make: (c, e) => ({ decision: e.decision, amount: dollars(e.cents),
      reason: `Bought ${c.days} days ago, inside the day 15 to 30 window, so 50% of the item price. Shipping is not refunded.` }) },
  { id: 'correct_short', logit: { main: 1.8, hard: 1.0 }, format: 'json', sound: true,
    make: (c, e) => ({ decision: e.decision, amount: dollars(e.cents),
      reason: `Day ${c.days} falls in the partial refund period: half of the item price.` }) },
  { id: 'correct_pretty', logit: { main: 1.6, hard: 0.9 }, format: 'json_pretty', sound: true,
    make: (c, e) => ({ reason: `Policy gives 50% between day 15 and day 30. This order is at day ${c.days}.`,
      amount: dollars(e.cents), decision: e.decision }) },
  { id: 'fenced_json', logit: { main: 0.6, hard: 0.6 }, format: 'fenced', sound: true,
    make: (c, e) => ({ decision: e.decision, amount: dollars(e.cents),
      reason: `Day ${c.days} is in the 50% window.` }) },
  { id: 'prose_before_json', logit: { main: 0.3, hard: 0.3 }, format: 'prose', sound: true,
    make: (c, e) => ({ decision: e.decision, amount: dollars(e.cents),
      reason: `Within the 15 to 30 day window.` }) },
  { id: 'amount_as_string', logit: { main: 0.3, hard: 0.3 }, format: 'json', sound: true,
    make: (c, e) => ({ decision: e.decision, amount: dollars(e.cents).toFixed(2),
      reason: `Day ${c.days}, half refund.` }) },
  { id: 'missing_reason', logit: { main: 0.2, hard: 0.2 }, format: 'json', sound: false,
    make: (c, e) => ({ decision: e.decision, amount: dollars(e.cents) }) },
  { id: 'math_full_refund', logit: { main: 0.5, hard: 0.5 }, format: 'json', sound: false,
    make: (c) => ({ decision: 'full', amount: dollars(c.itemCents),
      reason: `The customer asked within a month, so a full refund.` }) },
  { id: 'math_includes_shipping', logit: { main: 0.6, hard: 0.6 }, format: 'json', sound: false,
    make: (c) => ({ decision: 'partial', amount: dollars(Math.round((c.itemCents + c.shipCents) * POLICY.partialRate)),
      reason: `50% of the order total including shipping.` }) },
  { id: 'forbidden_promise', logit: { main: 0.4, hard: 0.4 }, format: 'json', sound: false,
    make: (c, e) => ({ decision: e.decision, amount: dollars(e.cents),
      reason: `Day ${c.days} gets 50%. We will also send a free replacement as a goodwill gesture.` }) },
  { id: 'weak_reasoning', logit: { main: 0.7, hard: 0.7 }, format: 'json', sound: false,
    make: (c, e) => ({ decision: e.decision, amount: dollars(e.cents),
      reason: `You are a loyal customer, so we can refund half.` }) },
  // Only reachable on the hard case (boundary and rounding mistakes).
  { id: 'boundary_none', logit: { main: -Infinity, hard: 0.9 }, format: 'json', sound: false,
    make: (c) => ({ decision: 'none', amount: 0, reason: `Day 30 is past the refund window.` }) },
  { id: 'rounding_down', logit: { main: -Infinity, hard: 0.9 }, format: 'json', sound: false,
    make: (c, e) => ({ decision: e.decision, amount: Math.floor(c.itemCents * POLICY.partialRate) / 100,
      reason: `Day ${c.days} is in the 50% window, half of ${dollars(c.itemCents)}.` }) },
];

const CORRECT_VARIANTS = new Set(['correct_window', 'correct_short', 'correct_pretty']);
for (const v of VARIANTS) v.correct = CORRECT_VARIANTS.has(v.id);

const OPENERS =['Here is the refund decision:', 'Sure! Based on the policy:', 'Decision below.'];

function render(obj, format, rng) {
  switch (format) {
    case 'json_pretty': return JSON.stringify(obj, null, 2);
    case 'fenced': return '```json\n' + JSON.stringify(obj, null, 2) + '\n```';
    case 'prose': return pick(rng, OPENERS) + ' ' + JSON.stringify(obj);
    default: return JSON.stringify(obj);
  }
}

function sampleVariant(rng, caseName, temperature) {
  const weights = VARIANTS.map((v) => Math.exp(v.logit[caseName] / temperature));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < VARIANTS.length; i++) {
    r -= weights[i];
    if (r <= 0) return VARIANTS[i];
  }
  return VARIANTS[VARIANTS.length - 1];
}

function callModel(rng, c) {
  const e = expected(c);
  const v = sampleVariant(rng, c.name, TEMPERATURE);
  const raw = render(v.make(c, e), v.format, rng);
  const ms = Math.round(MODEL_MS[0] + rng() * (MODEL_MS[1] - MODEL_MS[0]));
  return { variant: v.id, raw, sound: v.sound, correct: v.correct, ms };
}

// ---------- the eval suite: 3 checks ----------
function evaluate(raw, c) {
  const t0 = performance.now();
  const failed = [];
  let obj = null;

  // Check 1: valid JSON with the right fields and types.
  try { obj = JSON.parse(raw); } catch { obj = null; }
  const formatOk = obj !== null && typeof obj === 'object' && !Array.isArray(obj)
    && ['full', 'partial', 'none'].includes(obj.decision)
    && typeof obj.amount === 'number' && Number.isFinite(obj.amount)
    && typeof obj.reason === 'string' && obj.reason.trim().length > 0;
  if (!formatOk) failed.push('format');

  // Check 2 and 3 can only run on a parsed object.
  if (obj && typeof obj === 'object') {
    const e = expected(c);
    // The amount must be a whole number of cents (40.004 is not a valid refund),
    // checked with a tiny tolerance for binary floating point, then compared exactly.
    let cents = NaN;
    if (typeof obj.amount === 'number' && Number.isFinite(obj.amount)) {
      const scaled = obj.amount * 100;
      const whole = Math.round(scaled);
      if (Math.abs(scaled - whole) < 1e-6) cents = whole;
    }
    if (obj.decision !== e.decision || cents !== e.cents) failed.push('policy_math');
    if (typeof obj.reason === 'string' && POLICY.forbidden.test(obj.reason)) failed.push('forbidden_promise');
  }
  return { pass: failed.length === 0, failed, checkMs: performance.now() - t0 };
}

// ---------- guardrail: check before the user sees it, retry once ----------
// The guardrail calls the SAME evaluate() as the eval. So "guardrail accepts" and
// "eval passes" agree by construction; that agreement is not evidence of anything.
// What it cannot see is the hidden `correct` label, which is where the gap shows.
function answerWithGuardrail(rng, c) {
  const attempts = [];
  let reply = callModel(rng, c);
  let ev = evaluate(reply.raw, c);
  attempts.push({ ...reply, ...ev });
  let tries = 0;
  while (!ev.pass && tries < MAX_RETRIES) {
    tries++;
    reply = callModel(rng, c);
    ev = evaluate(reply.raw, c);
    attempts.push({ ...reply, ...ev });
  }
  const delivered = ev.pass ? attempts[attempts.length - 1] : null; // null = blocked, sent to a human
  // Extra time the guardrail adds: every check it runs, plus each retry's model call.
  const extraMs = attempts.reduce((s, a) => s + a.checkMs, 0)
    + attempts.slice(1).reduce((s, a) => s + a.ms, 0);
  return { attempts, delivered, retries: tries, extraMs };
}

function runBatch(c, n, seed) {
  const rng = mulberry32(seed);
  const rows = [];
  for (let i = 0; i < n; i++) rows.push(answerWithGuardrail(rng, c));
  const first = rows.map((r) => r.attempts[0]);
  const count = (pred) => rows.filter(pred).length;
  const firstFailBy = (name) => first.filter((a) => a.failed.includes(name)).length;
  const checkMsAll = rows.flatMap((r) => r.attempts.map((a) => a.checkMs));
  const extra = rows.map((r) => r.extraMs);
  const allAttempts = rows.flatMap((r) => r.attempts);
  return {
    // Ground truth (hidden label), counted per attempt the guardrail judged.
    firstIncorrect: first.filter((a) => !a.correct).length,
    attemptsTotal: allAttempts.length,
    incorrectAttempts: allAttempts.filter((a) => !a.correct).length,
    incorrectBlocked: allAttempts.filter((a) => !a.correct && !a.pass).length,
    incorrectAccepted: allAttempts.filter((a) => !a.correct && a.pass).length,
    correctBlocked: allAttempts.filter((a) => a.correct && !a.pass).length,
    deliveredCorrect: count((r) => r.delivered !== null && r.delivered.correct),
    rows,
    n,
    firstPass: first.filter((a) => a.pass).length,
    firstSoundAndPass: first.filter((a) => a.pass && a.sound).length,
    failFormat: firstFailBy('format'),
    failMath: firstFailBy('policy_math'),
    failPromise: firstFailBy('forbidden_promise'),
    retries: rows.reduce((s, r) => s + r.retries, 0),
    deliveredPass: count((r) => r.delivered !== null),
    blocked: count((r) => r.delivered === null),
    slippedWeak: count((r) => r.delivered !== null && !r.delivered.sound),
    distinctTexts: new Set(first.map((a) => a.raw)).size,
    distinctAmounts: new Set(first.map((a) => { try { return String(JSON.parse(a.raw).amount); } catch { return 'unparsed'; } })).size,
    extraMsTotal: extra.reduce((a, b) => a + b, 0),
    extraMsMax: Math.max(...extra),
    avgModelMs: first.reduce((s, a) => s + a.ms, 0) / n,
    avgCheckMs: checkMsAll.reduce((a, b) => a + b, 0) / checkMsAll.length,
  };
}

// ---------- run ----------
const main = runBatch(CASES.main, ASKS, SEED);
const hard = main.firstPass === ASKS ? runBatch(CASES.hard, ASKS, SEED + 1) : null;
const longRun = runBatch(CASES.main, LONG_RUN, SEED + 100);

// Save every raw reply (main, optional hard case, and all long-run attempts).
const outcomeOf = (r) => (r.delivered
  ? (r.delivered.correct ? 'delivered_correct' : 'delivered_but_incorrect')
  : 'blocked');
const dump = (b, c) => ({
  case: c, policy: POLICY.text, expected: { ...expected(c), amount: dollars(expected(c).cents) },
  asks: b.rows.map((r, i) => ({
    ask: i + 1,
    attempts: r.attempts.map((a) => ({
      variant: a.variant, raw: a.raw, pass: a.pass, failed: a.failed, modelMs: a.ms,
      reasoningSoundHumanLabel: a.sound, overallCorrectHumanLabel: a.correct,
    })),
    outcome: outcomeOf(r),
  })),
});
writeFileSync(new URL('./replies.json', import.meta.url),
  JSON.stringify({
    note: 'Simulation: every reply below was authored in run.mjs and sampled from a seeded category distribution. No model was called.',
    seed: SEED, temperature: TEMPERATURE,
    main: dump(main, CASES.main),
    hard: hard ? dump(hard, CASES.hard) : null,
    longRun: { seed: SEED + 100, ...dump(longRun, CASES.main) },
  }, null, 1));

// Human-readable table.
const pct = (x, n) => `${((100 * x) / n).toFixed(1)}%`;
console.log('SIMULATION: authored replies, seeded category sampling. No model is called.');
console.log(`Prompt: refund decision as JSON {decision, amount, reason}. Order $${dollars(CASES.main.itemCents)} + $${dollars(CASES.main.shipCents)} shipping, day ${CASES.main.days}.`);
console.log(`Correct answer: ${JSON.stringify({ ...expected(CASES.main), amount: dollars(expected(CASES.main).cents) })}`);
console.log(`Category temperature ${TEMPERATURE}, seed ${SEED}, ${ASKS} asks\n`);
const label = (a) => (a.correct ? 'correct' : 'incorrect');
main.rows.forEach((r, i) => {
  const a = r.attempts[0];
  const tag = a.pass ? 'PASS' : `FAIL (${a.failed.join(', ')})`;
  const b = r.attempts[1];
  const retry = b ? ` -> retry ${b.variant} ${b.pass ? 'PASS' : `FAIL (${b.failed.join(', ')})`} [${label(b)}]` : '';
  const hidden = r.delivered && !r.delivered.correct ? '  << delivered, but incorrect' : '';
  console.log(`#${String(i + 1).padStart(2)} ${a.variant.padEnd(24)} [${label(a)}] ${tag}${retry}${hidden}`);
});
const summary = (b) => `${b.firstIncorrect}/${b.n} incorrect on first try; of ${b.incorrectAttempts} incorrect attempts the guardrail blocked ${b.incorrectBlocked} and accepted ${b.incorrectAccepted}; ${b.correctBlocked} correct attempts blocked; delivered ${b.deliveredPass}/${b.n} (${b.deliveredCorrect} correct), blocked ${b.blocked}`;
console.log(`\nMain: first-try eval pass ${main.firstPass}/${ASKS}; ${main.retries} retries; ${summary(main)}.`);
if (hard) console.log(`Hard case (day 30, $79.99): first-try eval pass ${hard.firstPass}/${ASKS}; ${summary(hard)}.`);
console.log(`Long run (${LONG_RUN} asks): first-try pass ${pct(longRun.firstPass, LONG_RUN)}, ${summary(longRun)}.`);
console.log('Guardrail and eval use the same checks, so they agree on every attempt by construction.');
console.log('Raw replies (main, hard case if run, long run) saved to replies.json\n');

// ---------- RESULT ----------
const r1 = (x) => Math.round(x * 10) / 10;
const metrics = [
  { name: 'first_try_eval_pass', value: main.firstPass, unit: `of ${ASKS}` },
  { name: 'first_try_fail_format', value: main.failFormat, unit: 'replies' },
  { name: 'first_try_fail_policy_math', value: main.failMath, unit: 'replies' },
  { name: 'first_try_fail_forbidden_promise', value: main.failPromise, unit: 'replies' },
  { name: 'first_try_incorrect', value: main.firstIncorrect, unit: `of ${ASKS} (hidden label)` },
  { name: 'incorrect_attempts_total', value: main.incorrectAttempts, unit: `of ${main.attemptsTotal} attempts` },
  { name: 'incorrect_blocked', value: main.incorrectBlocked, unit: 'attempts' },
  { name: 'incorrect_accepted', value: main.incorrectAccepted, unit: 'attempts' },
  { name: 'correct_blocked', value: main.correctBlocked, unit: 'attempts' },
  { name: 'distinct_reply_texts', value: main.distinctTexts, unit: `of ${ASKS}` },
  { name: 'distinct_amounts', value: main.distinctAmounts, unit: 'values' },
  { name: 'guardrail_retries', value: main.retries, unit: 'retries' },
  { name: 'delivered', value: main.deliveredPass, unit: `of ${ASKS}` },
  { name: 'delivered_correct', value: main.deliveredCorrect, unit: `of ${ASKS}` },
  { name: 'blocked_after_retry', value: main.blocked, unit: `of ${ASKS}` },
  { name: 'extra_latency_avg_per_ask', value: r1(main.extraMsTotal / ASKS), unit: 'ms (simulated)' },
  { name: 'extra_latency_worst_ask', value: r1(main.extraMsMax), unit: 'ms (simulated)' },
  { name: 'avg_model_call', value: r1(main.avgModelMs), unit: 'ms (simulated)' },
  { name: 'avg_eval_check_time', value: Math.round(main.avgCheckMs * 1000) / 1000, unit: 'ms (measured, varies)' },
  { name: 'long_run_first_try_eval_pass', value: r1((100 * longRun.firstPass) / LONG_RUN), unit: `% of ${LONG_RUN}` },
  { name: 'long_run_first_try_incorrect', value: r1((100 * longRun.firstIncorrect) / LONG_RUN), unit: `% of ${LONG_RUN}` },
  { name: 'long_run_incorrect_blocked', value: r1((100 * longRun.incorrectBlocked) / longRun.incorrectAttempts), unit: '% of incorrect attempts' },
  { name: 'long_run_incorrect_accepted', value: r1((100 * longRun.incorrectAccepted) / longRun.incorrectAttempts), unit: '% of incorrect attempts' },
  { name: 'long_run_delivered_incorrect', value: r1((100 * (longRun.deliveredPass - longRun.deliveredCorrect)) / LONG_RUN), unit: `% of ${LONG_RUN} asks` },
];
if (hard) {
  metrics.push(
    { name: 'hard_first_try_eval_pass', value: hard.firstPass, unit: `of ${ASKS}` },
    { name: 'hard_first_try_incorrect', value: hard.firstIncorrect, unit: `of ${ASKS}` },
    { name: 'hard_incorrect_blocked', value: hard.incorrectBlocked, unit: 'attempts' },
    { name: 'hard_incorrect_accepted', value: hard.incorrectAccepted, unit: 'attempts' },
    { name: 'hard_delivered_correct', value: hard.deliveredCorrect, unit: `of ${ASKS}` },
  );
}

const focus = hard || main;
const which = hard ? `on the harder day-30 case (all ${ASKS} easy-case replies passed)` : `in ${ASKS} simulated asks of the same question`;
const conclusion = `In this simulation of authored replies, ${which} ${focus.firstIncorrect} of ${ASKS} first answers were incorrect; a retry-once guardrail running the eval's own checks blocked ${focus.incorrectBlocked} incorrect attempts but accepted ${focus.incorrectAccepted} whose format, amount and wording passed but whose reasoning was wrong (${r1((100 * longRun.incorrectAccepted) / longRun.incorrectAttempts)}% of incorrect attempts over a ${LONG_RUN}-ask run).`;

const setup = `simulation, no model called: ${VARIANTS.length} authored reply categories sampled by softmax over hand-set logits, category temperature ${TEMPERATURE}, seed ${SEED}; ${ASKS} asks plus ${LONG_RUN}-ask long run (seed ${SEED + 100}); order $80 + $8 shipping at day 20 (expected partial, $40); correct = exact JSON contract + right amount in whole cents + no forbidden promise + sound reasoning (hidden label); 3 checks (JSON fields, policy math, forbidden promise), guardrail uses the same checks, retries once then blocks; model latency ${MODEL_MS[0]} to ${MODEL_MS[1]} ms virtual`;

console.log('RESULT ' + JSON.stringify({ metrics, conclusion, setup }));

