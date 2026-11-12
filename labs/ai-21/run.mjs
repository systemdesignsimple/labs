// Lab ai-21: You sent 1 message. Why does AI say "too many requests"?
// A token-bucket rate limiter with two budgets (requests per minute and
// tokens per minute), driven by three kinds of "one message".
// Node.js 22, standard library only, simulated clock, fixed seeds.
// The limits below are made up for the lab. They are NOT any provider's real limits.

const CONFIG = {
  seed: 21,
  rpm: 6, // requests per minute bucket (made-up lab value)
  tpm: 10000, // tokens per minute bucket (made-up lab value)
  sendsPerChatScenario: 3, // the user sends a message, reads the reply, sends again
  thinkTimeSec: 5, // pause between reading a reply and sending the next message
  chatSystemWords: 60,
  shortQuestion: 'Why does my app get a too many requests error when I only sent one message?',
  longChatTurns: 45, // earlier turns that get resent as input with every new message
  longChatUserWords: 25,
  longChatAssistantWords: 75,
  chatReplyWords: 200,
  agentSystemAndToolWords: 350, // system prompt plus tool definitions
  agentModelCalls: 10, // PLANNED model calls for one user message (the run may stop early on a 429)
  agentStepWords: 40, // model output per step (a tool call request)
  agentToolResultWords: 110, // tool result fed back into the next call
  agentFinalWords: 120,
  toolLatencySec: 0.3,
  modelLatencyBaseSec: 0.5,
  modelLatencyPerOutputTokenSec: 0.01,
  perMessageOverheadTokens: 4, // chat format wrapper per message
  backoff: { baseSec: 1, capSec: 30, maxRetries: 8 }, // exponential, full jitter
};

// ---------- deterministic randomness ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- approximate token charge ----------
// The lab rules allow the standard library only, so no provider tokenizer.
// What this lab measures is an APPROXIMATE token charge, by a fixed rule:
// a word costs 1 token per started 4 letters, digits 1 per 3, each symbol 1.
// Every "tokens" number in this lab means "approximate tokens" by this rule.
function countTokens(text) {
  const pieces = text.match(/[A-Za-z]+|[0-9]+|[^\sA-Za-z0-9]/g) || [];
  let n = 0;
  for (const p of pieces) {
    if (/^[A-Za-z]+$/.test(p)) n += Math.ceil(p.length / 4);
    else if (/^[0-9]+$/.test(p)) n += Math.ceil(p.length / 3);
    else n += 1;
  }
  return n;
}
function countMessages(msgs) {
  return msgs.reduce((s, m) => s + countTokens(m) + CONFIG.perMessageOverheadTokens, 0);
}

const VOCAB = ('the a server request cache user database queue token limit model reply answer ' +
  'question when how why because send retry error minute budget network phone app load fast slow ' +
  'time data key value list history context tool search result step plan check write read page ' +
  'price order friend message window count bucket refill wait second first next more less every').split(' ');
function makeText(rng, words) {
  const out = [];
  let sentence = [];
  for (let i = 0; i < words; i++) {
    sentence.push(VOCAB[Math.floor(rng() * VOCAB.length)]);
    if (sentence.length >= 8 + Math.floor(rng() * 8) || i === words - 1) {
      const s = sentence.join(' ');
      out.push(s[0].toUpperCase() + s.slice(1) + '.');
      sentence = [];
    }
  }
  return out.join(' ');
}

// ---------- the rate limiter: two token buckets ----------
class TwoBucketLimiter {
  constructor(rpm, tpm) {
    this.rpm = rpm; this.tpm = tpm;
    this.reqLeft = rpm; this.tokLeft = tpm; this.last = 0;
  }
  refill(now) {
    const dt = now - this.last;
    if (dt > 0) {
      this.reqLeft = Math.min(this.rpm, this.reqLeft + (dt * this.rpm) / 60);
      this.tokLeft = Math.min(this.tpm, this.tokLeft + (dt * this.tpm) / 60);
      this.last = now;
    }
  }
  // Rejected requests do not spend budget in this lab.
  tryAcquire(now, tokens) {
    this.refill(now);
    const okReq = this.reqLeft >= 1;
    const okTok = this.tokLeft >= tokens;
    if (okReq && okTok) {
      this.reqLeft -= 1; this.tokLeft -= tokens;
      return { ok: true };
    }
    const reason = !okReq && !okTok ? 'requests+tokens' : !okReq ? 'requests' : 'tokens';
    return { ok: false, reason, neverFits: tokens > this.tpm };
  }
}

// ---------- one simulated user/key ----------
function makeSim(mode, scenario, jitterSeed) {
  return {
    mode, scenario, now: 0,
    limiter: new TwoBucketLimiter(CONFIG.rpm, CONFIG.tpm),
    jitter: mulberry32(jitterSeed),
    log: [],
  };
}

// One model request. Charges input + output tokens up front.
function modelCall(sim, label, inputTokens, outputTokens, useBackoff) {
  const cost = inputTokens + outputTokens;
  let attempt = 0;
  let waited = 0;
  let firstFailAt = null;
  for (;;) {
    const r = sim.limiter.tryAcquire(sim.now, cost);
    const row = {
      t: +sim.now.toFixed(2), scenario: sim.scenario, label, attempt,
      inputTokens, outputTokens,
      status: r.ok ? 200 : 429, reason: r.ok ? '' : r.reason,
      rpmLeft: +sim.limiter.reqLeft.toFixed(2), tpmLeft: Math.round(sim.limiter.tokLeft),
    };
    sim.log.push(row);
    printRow(sim.mode, row);
    if (r.ok) {
      sim.now += CONFIG.modelLatencyBaseSec + outputTokens * CONFIG.modelLatencyPerOutputTokenSec;
      return { ok: true, waited, recovery: firstFailAt === null ? 0 : row.t - firstFailAt, cost };
    }
    if (firstFailAt === null) firstFailAt = row.t;
    if (!useBackoff || r.neverFits || attempt >= CONFIG.backoff.maxRetries) {
      return { ok: false, waited, reason: r.reason, row, cost, neverFits: r.neverFits };
    }
    const ceiling = Math.min(CONFIG.backoff.capSec, CONFIG.backoff.baseSec * 2 ** attempt);
    const delay = sim.jitter() * ceiling; // full jitter
    sim.now += delay; waited += delay; attempt++;
  }
}

function printRow(mode, r) {
  console.log(
    `[${mode.padEnd(10)}] t=${r.t.toFixed(2).padStart(6)}s ${r.scenario.padEnd(9)} ${r.label.padEnd(14)} ` +
    `try=${r.attempt} in=${String(r.inputTokens).padStart(5)} out=${String(r.outputTokens).padStart(4)} ` +
    `-> ${r.status}${r.reason ? ' (' + r.reason + ')' : ''}  rpm_left=${r.rpmLeft} tpm_left=${r.tpmLeft}`
  );
}

// ---------- scenarios ----------
function buildContent() {
  const rng = mulberry32(CONFIG.seed);
  const chatSystem = makeText(rng, CONFIG.chatSystemWords);
  const history = [];
  for (let i = 0; i < CONFIG.longChatTurns; i++) {
    history.push(makeText(rng, CONFIG.longChatUserWords));
    history.push(makeText(rng, CONFIG.longChatAssistantWords));
  }
  const chatReply = makeText(rng, CONFIG.chatReplyWords);
  const agentSystem = makeText(rng, CONFIG.agentSystemAndToolWords);
  const agentSteps = [];
  for (let i = 0; i < CONFIG.agentModelCalls - 1; i++) {
    agentSteps.push({ out: makeText(rng, CONFIG.agentStepWords), tool: makeText(rng, CONFIG.agentToolResultWords) });
  }
  const agentFinal = makeText(rng, CONFIG.agentFinalWords);
  return { chatSystem, history, chatReply, agentSystem, agentSteps, agentFinal };
}

function runChat(mode, scenario, content, withHistory, useBackoff, jitterSeed) {
  const sim = makeSim(mode, scenario, jitterSeed);
  const input = countMessages([content.chatSystem, ...(withHistory ? content.history : []), CONFIG.shortQuestion]);
  const output = countTokens(content.chatReply);
  const results = [];
  for (let i = 1; i <= CONFIG.sendsPerChatScenario; i++) {
    const res = modelCall(sim, `send #${i}`, input, output, useBackoff);
    results.push({ send: i, ...res });
    sim.now += CONFIG.thinkTimeSec;
  }
  return { sim, input, output, results };
}

function runAgent(mode, content, useBackoff, jitterSeed) {
  const sim = makeSim(mode, 'agent', jitterSeed);
  const context = [content.agentSystem, CONFIG.shortQuestion];
  const results = [];
  let totalTokens = 0;
  for (let k = 1; k <= CONFIG.agentModelCalls; k++) {
    const last = k === CONFIG.agentModelCalls;
    const outText = last ? content.agentFinal : content.agentSteps[k - 1].out;
    const input = countMessages(context);
    const output = countTokens(outText);
    const res = modelCall(sim, `model call ${k}`, input, output, useBackoff);
    results.push({ call: k, ...res });
    if (!res.ok) break; // the agent run fails and the user sees an error
    totalTokens += input + output;
    if (!last) {
      context.push(outText, content.agentSteps[k - 1].tool); // tool call + tool result grow the context
      sim.now += CONFIG.toolLatencySec;
    }
  }
  return { sim, results, totalTokens };
}

function runAll(mode, useBackoff) {
  const content = buildContent();
  const short = runChat(mode, 'short', content, false, useBackoff, 101);
  const long = runChat(mode, 'long-chat', content, true, useBackoff, 202);
  const agent = runAgent(mode, content, useBackoff, 303);
  return { short, long, agent };
}

// ---------- run ----------
console.log('Lab ai-21: two-bucket rate limiter simulation (made-up limits, simulated clock)');
console.log(`Limits: ${CONFIG.rpm} requests/min, ${CONFIG.tpm} tokens/min, both refill continuously.\n`);

console.log('--- Run 1: no retry (a 429 becomes an error the user sees) ---');
const r1 = runAll('no-retry', false);
console.log('\n--- Run 2: retry with exponential backoff and full jitter ---');
const r2 = runAll('backoff', true);

const failedMessages = (r) =>
  r.short.results.filter((x) => !x.ok).length +
  r.long.results.filter((x) => !x.ok).length +
  (r.agent.results.some((x) => !x.ok) ? 1 : 0);
const totalMessages = 2 * CONFIG.sendsPerChatScenario + 1;

const shortCost = r1.short.input + r1.short.output;
const longCost = r1.long.input + r1.long.output;
const ratio = longCost / shortCost;

const longFirstFail = r1.long.results.find((x) => !x.ok);
const agentFirstFail = r1.agent.results.find((x) => !x.ok);

// Agent counts are OBSERVED from each run, not taken from CONFIG.
// planned   = CONFIG.agentModelCalls (what the agent intended to do)
// attempted = every request that reached the limiter (sim.log rows, 200s and 429s, retries included)
// succeeded = model calls that got a 200 (results with ok)
// rejected  = 429 responses; retries = attempts with attempt > 0
const agentCounts = (r) => ({
  attempted: r.agent.sim.log.length,
  succeeded: r.agent.results.filter((x) => x.ok).length,
  rejected: r.agent.sim.log.filter((x) => x.status === 429).length,
  retries: r.agent.sim.log.filter((x) => x.attempt > 0).length,
});
const ag1 = agentCounts(r1);
const ag2 = agentCounts(r2);

// Waiting in the backoff run, built from accumulated `waited` values.
// Per user message: a chat send is one message; the whole agent run is one message
// (it can hit several recovery periods, so its waits are summed).
const waitPerMessage = [
  ...r2.short.results.map((x) => x.waited || 0),
  ...r2.long.results.map((x) => x.waited || 0),
  r2.agent.results.reduce((s, x) => s + (x.waited || 0), 0),
];
const totalWait = waitPerMessage.reduce((s, w) => s + w, 0);
const maxWaitPerMessage = Math.max(...waitPerMessage);
const agentWait = waitPerMessage[waitPerMessage.length - 1];
// Longest recovery of ONE model call (first 429 to its eventual 200). Not a bound on total waiting.
const allR2 = [...r2.short.results, ...r2.long.results, ...r2.agent.results];
const longestCallRecovery = allR2.reduce((m, x) => Math.max(m, x.recovery || 0), 0);
const fails1 = failedMessages(r1);
const fails2 = failedMessages(r2);

console.log('\n--- Summary ---');
console.log('(All token numbers are approximate charges from the lab\'s fixed rule, not a provider tokenizer.)');
console.log(`Short question: ~${shortCost} tokens per message, ${r1.short.results.filter((x) => x.ok).length}/${CONFIG.sendsPerChatScenario} sends passed.`);
console.log(`Long chat: ~${longCost} tokens per message (${ratio.toFixed(1)}x the short question), still 1 request each.`);
if (longFirstFail) {
  console.log(`  First 429 on send #${longFirstFail.send}, reason=${longFirstFail.reason}, rpm_left=${longFirstFail.row.rpmLeft} of ${CONFIG.rpm}, tpm_left=${longFirstFail.row.tpmLeft}.`);
}
console.log(`Agent: one message, ${CONFIG.agentModelCalls} model calls planned.`);
console.log(`  No retry: ${ag1.attempted} requests attempted, ${ag1.succeeded} succeeded, ${ag1.rejected} rejected.`);
if (agentFirstFail) {
  console.log(`  First 429 on model call ${agentFirstFail.call}, reason=${agentFirstFail.reason}, rpm_left=${agentFirstFail.row.rpmLeft}, tpm_left=${agentFirstFail.row.tpmLeft}.`);
}
console.log(`  Backoff: ${ag2.attempted} requests attempted, ${ag2.succeeded} succeeded, ${ag2.rejected} rejected, ${ag2.retries} retries, ${agentWait.toFixed(1)}s waited.`);
console.log(`Without retry: ${fails1}/${totalMessages} user messages ended in an error.`);
console.log(`With backoff: ${fails2}/${totalMessages} ended in an error; total wait ${totalWait.toFixed(1)}s across all messages, ` +
  `longest wait for one user message ${maxWaitPerMessage.toFixed(1)}s, longest recovery of one model call ${longestCallRecovery.toFixed(1)}s.`);
console.log('Simulation only: the shape of the effect, not any real provider\'s limits or timings.\n');

const metrics = [
  { name: 'short_question_approx_tokens_per_message', value: shortCost, unit: 'approx tokens (lab rule, not a provider tokenizer)' },
  { name: 'long_chat_approx_tokens_per_message', value: longCost, unit: 'approx tokens (lab rule, not a provider tokenizer)' },
  { name: 'long_chat_vs_short_approx_token_ratio', value: +ratio.toFixed(1), unit: 'x' },
  { name: 'long_chat_first_429_send', value: longFirstFail ? longFirstFail.send : 0, unit: 'send number (0 = none)' },
  { name: 'long_chat_requests_left_at_first_429', value: longFirstFail ? +longFirstFail.row.rpmLeft.toFixed(1) : 0, unit: `requests of ${CONFIG.rpm}/min` },
  { name: 'agent_planned_model_calls_per_message', value: CONFIG.agentModelCalls, unit: 'planned calls (config)' },
  { name: 'agent_attempted_requests_no_retry', value: ag1.attempted, unit: 'requests sent (from log)' },
  { name: 'agent_successful_calls_no_retry', value: ag1.succeeded, unit: 'calls with 200' },
  { name: 'agent_attempted_requests_with_backoff', value: ag2.attempted, unit: 'requests sent incl. retries (from log)' },
  { name: 'agent_successful_calls_with_backoff', value: ag2.succeeded, unit: 'calls with 200' },
  { name: 'agent_retry_attempts_with_backoff', value: ag2.retries, unit: 'retries' },
  { name: 'agent_approx_tokens_per_message_with_backoff', value: r2.agent.totalTokens, unit: 'approx tokens (successful calls only)' },
  { name: 'failed_messages_without_retry', value: fails1, unit: `messages of ${totalMessages}` },
  { name: 'failed_messages_with_backoff', value: fails2, unit: `messages of ${totalMessages}` },
  { name: 'backoff_total_wait_all_messages', value: +totalWait.toFixed(1), unit: 'seconds (sum over all messages)' },
  { name: 'backoff_longest_wait_one_user_message', value: +maxWaitPerMessage.toFixed(1), unit: 'seconds' },
  { name: 'backoff_agent_message_wait', value: +agentWait.toFixed(1), unit: 'seconds (sum over its model calls)' },
  { name: 'backoff_longest_single_call_recovery', value: +longestCallRecovery.toFixed(1), unit: 'seconds (one model call)' },
];

const parts = [];
parts.push(`one long-chat message cost ${ratio.toFixed(1)}x the approximate tokens of a short question`);
if (longFirstFail) {
  parts.push(`so send #${longFirstFail.send} got a 429 on ${longFirstFail.reason} with ${longFirstFail.row.rpmLeft.toFixed(1)} of ${CONFIG.rpm} requests still free`);
}
if (agentFirstFail) {
  parts.push(
    `one agent message planned ${CONFIG.agentModelCalls} model calls but without retry sent ${ag1.attempted} requests, ` +
    `${ag1.succeeded} succeeded and call ${agentFirstFail.call} got a 429 on ${agentFirstFail.reason}`
  );
} else {
  parts.push(`one agent message sent ${ag1.attempted} requests without retry and all ${ag1.succeeded} succeeded`);
}
parts.push(
  `and with backoff the agent sent ${ag2.attempted} requests (${ag2.retries} retries) for ${ag2.succeeded} successful calls, ` +
  `failed messages went from ${fails1} to ${fails2}, and waiting totalled ${totalWait.toFixed(1)}s across all messages ` +
  `(longest for one user message ${maxWaitPerMessage.toFixed(1)}s)`
);
const conclusion = 'In this simulation ' + parts.join(', ') + '.';

const setup =
  `simulated clock, seed ${CONFIG.seed}; two token buckets ${CONFIG.rpm} RPM and ${CONFIG.tpm} TPM (made-up, not a provider's limits), ` +
  `continuous refill, rejected requests spend nothing, input+output tokens charged up front; token charges are approximate (stdlib-only rule: 1 token per started 4 letters, 1 per 3 digits, 1 per symbol, ${CONFIG.perMessageOverheadTokens} per message), not a provider tokenizer; ` +
  `${CONFIG.sendsPerChatScenario} sends per chat scenario with ${CONFIG.thinkTimeSec}s think time; long chat resends ${CONFIG.longChatTurns} earlier turns; ` +
  `agent plans ${CONFIG.agentModelCalls} model calls with growing context and stops at a call that still fails; backoff base ${CONFIG.backoff.baseSec}s, cap ${CONFIG.backoff.capSec}s, ` +
  `${CONFIG.backoff.maxRetries} retries, full jitter`;

console.log('RESULT ' + JSON.stringify({ metrics, conclusion, setup }));
