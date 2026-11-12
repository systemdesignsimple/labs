// AI #5 lab: "AI can't see a clock. So how did it tell me the time?"
// Node.js 22 ESM, standard library only. No network, no child processes, no files written.
//
// A demonstration of tool-call MECHANICS, not a measurement of any real model.
// The "model" is a scripted, seeded function whose behaviour (refusing, guessing, using the tool,
// slipping on the timezone) is ASSUMED. A real-model experiment would need network access to a
// model API, which the lab rules forbid, so it cannot be run here.
//
// Same prompt, same scripted model, two modes, 20 runs each:
//   Mode A: no tools. Nothing in the scripted model's input says what "now" is.
//   Mode B: one tool, get_current_time(timezone), backed by the app's (virtual) clock.
// Everything is seeded and runs on a virtual clock with simulated latencies, so every run prints
// the same numbers.

const SEED = 20261105;
const RUNS = 20;
const PROMPT = 'What time is it right now in Tokyo?';
const TIMEZONE = 'Asia/Tokyo';
const TOKYO_OFFSET = '+09:00';
// Illustrative assumption: when the scripted model guesses, it guesses on this fixed past date.
// This is programmed behaviour, not a claim about how real models pick a date.
const ASSUMED_GUESS_DAY = '2025-06-01';
const CLOCK_START_MS = Date.UTC(2026, 10, 5, 14, 0, 0); // 2026-11-05 23:00:00 in Tokyo
const GAP_BETWEEN_RUNS_MS = 30_000;

// Behaviour rates of the scripted model. These are assumptions, not measurements.
const P_REFUSE_WITHOUT_TOOL = 0.45; // "I can't know the current time"
const P_SKIP_TOOL = 0.05;           // mode B: answers from memory even though the tool exists
const P_TIMEZONE_SLIP = 0.05;       // mode B: reads the UTC field and calls it Tokyo time

// ---------- seeded random ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
const between = (lo, hi) => lo + rng() * (hi - lo);

// ---------- virtual clock (stands in for the machine clock so runs repeat) ----------
const clock = {
  now: CLOCK_START_MS,
  advance(ms) { this.now += ms; },
};

// ---------- formatting helpers ----------
const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
function tokyoLocal(ms) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
}
const pad = (n) => String(n).padStart(2, '0');

// ---------- the tool (app code, not the model) ----------
const TOOLS = [{
  name: 'get_current_time',
  description: 'Returns the current time for an IANA timezone.',
  parameters: { type: 'object', properties: { timezone: { type: 'string' } }, required: ['timezone'] },
}];
function get_current_time({ timezone }) {
  if (timezone !== TIMEZONE) return { error: `unsupported timezone ${timezone}` };
  const t = tokyoLocal(clock.now);
  return {
    timezone,
    local: `${t.date} ${t.time}`,
    utc_offset: TOKYO_OFFSET,
    utc_iso: new Date(clock.now).toISOString(),
  };
}

// ---------- scripted model ----------
// One "call" = one simulated round trip to the model. It returns either a tool call or a final reply.
// The model never reads clock.now. It only sees messages.
function modelLatencyMs(isFollowUp) {
  return Math.round(isFollowUp ? between(300, 800) : between(400, 1000));
}

function answerFromMemory() {
  if (rng() < P_REFUSE_WITHOUT_TOOL) {
    return { type: 'reply', text: "I can't know the current time. I don't have access to a clock.", claimedMs: null };
  }
  // Assumed behaviour: guesses a time of day on ASSUMED_GUESS_DAY.
  const hh = pad(Math.floor(between(0, 24)));
  const mm = pad(Math.floor(between(0, 60)));
  const claimedMs = Date.parse(`${ASSUMED_GUESS_DAY}T${hh}:${mm}:00${TOKYO_OFFSET}`);
  return { type: 'reply', text: `It's probably around ${hh}:${mm} in Tokyo (${ASSUMED_GUESS_DAY}).`, claimedMs };
}

function modelCall(messages, tools) {
  const last = messages[messages.length - 1];
  if (last.role === 'tool') {
    const r = JSON.parse(last.content);
    if (rng() < P_TIMEZONE_SLIP) {
      // Assumed mistake: reads the UTC field and presents it as Tokyo time.
      const [d, t] = r.utc_iso.split('T');
      const hhmm = t.slice(0, 5);
      return { type: 'reply', text: `It's ${hhmm} in Tokyo right now.`, claimedMs: Date.parse(`${d}T${hhmm}:00${TOKYO_OFFSET}`) };
    }
    const [d, t] = r.local.split(' ');
    const hhmm = t.slice(0, 5);
    return { type: 'reply', text: `It's ${hhmm} on ${d} in Tokyo right now.`, claimedMs: Date.parse(`${d}T${hhmm}:00${r.utc_offset}`) };
  }
  if (tools.length && rng() >= P_SKIP_TOOL) {
    return { type: 'tool_call', name: 'get_current_time', arguments: { timezone: TIMEZONE } };
  }
  return answerFromMemory();
}

// ---------- the app loop (this is the "agent") ----------
function runOnce(useTools) {
  const tools = useTools ? TOOLS : [];
  const messages = [{ role: 'user', content: PROMPT }];
  const trace = [{ step: 'user', text: PROMPT }];
  let latency = 0;
  let calledTool = false;
  let toolMs = 0;     // simulated time spent running the tool
  let followUpMs = 0; // simulated time of model calls made after a tool result
  for (let turn = 0; turn < 4; turn++) {
    const l = modelLatencyMs(turn > 0);
    clock.advance(l); latency += l;
    if (turn > 0) followUpMs += l;
    const out = modelCall(messages, tools);
    if (out.type === 'tool_call') {
      calledTool = true;
      trace.push({ step: 'model -> tool_call', text: `${out.name}(${JSON.stringify(out.arguments)})`, ms: l });
      const tMs = Math.round(between(1, 5));
      clock.advance(tMs); latency += tMs; toolMs += tMs;
      const result = get_current_time(out.arguments);
      trace.push({ step: 'app runs tool', text: JSON.stringify(result), ms: tMs });
      messages.push({ role: 'assistant', tool_call: out });
      messages.push({ role: 'tool', name: out.name, content: JSON.stringify(result) });
      continue;
    }
    trace.push({ step: 'model -> reply', text: out.text, ms: l });
    const errorMin = out.claimedMs === null ? null : Math.abs(clock.now - out.claimedMs) / 60_000;
    return {
      calledTool, latency, errorMin, answered: out.claimedMs !== null, trace,
      toolMs, followUpMs, addedMs: toolMs + followUpMs,
    };
  }
  throw new Error('agent loop did not finish');
}

function runMode(useTools) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    runs.push(runOnce(useTools));
    clock.advance(GAP_BETWEEN_RUNS_MS);
  }
  return runs;
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (x, d = 0) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

// ---------- run ----------
const A = runMode(false);
const B = runMode(true);

const aAnswered = A.filter((r) => r.answered);
const aRefused = A.length - aAnswered.length;
const aMedianErrMin = median(aAnswered.map((r) => r.errorMin));
const bToolRuns = B.filter((r) => r.calledTool);
const bToolCalls = bToolRuns.length;
const bWithin1 = B.filter((r) => r.answered && r.errorMin <= 1).length;
const bOff = B.filter((r) => !r.answered || r.errorMin > 1);
const bMedianErrSec = median(B.filter((r) => r.answered).map((r) => r.errorMin * 60));
// Added cost of the tool path, recorded directly inside each tool-using run
// (tool time + follow-up model call), not a difference of medians across separate samples.
const addedMedianMs = median(bToolRuns.map((r) => r.addedMs));
const toolMedianMs = median(bToolRuns.map((r) => r.toolMs));
const followUpMedianMs = median(bToolRuns.map((r) => r.followUpMs));

const printTrace = (run) => {
  for (const s of run.trace) console.log(`${s.step.padEnd(20)} ${s.ms !== undefined ? `[sim ${s.ms} ms] ` : ''}${s.text}`);
};

// One mode B trace for the on-screen terminal.
const shown = B.find((r) => r.calledTool && r.errorMin <= 1) ?? B[0];
console.log('--- one mode B run (with clock tool, scripted model, simulated ms) ---');
printTrace(shown);
console.log('');
console.log('--- one mode A run (no tools, scripted model, simulated ms) ---');
printTrace(aAnswered[0] ?? A[0]);
console.log('');
console.log(`Mode A: ${aRefused}/${RUNS} scripted refusals, ${aAnswered.length}/${RUNS} scripted guesses, median error ${round(aMedianErrMin / 1440, 1)} days`);
console.log(`Mode B: ${bToolCalls}/${RUNS} called the tool, ${bWithin1}/${RUNS} within 1 minute of the virtual clock, median error ${round(bMedianErrSec, 1)} s`);
for (const r of bOff) {
  console.log(`  mode B miss: tool=${r.calledTool} answered=${r.answered} error=${r.errorMin === null ? 'n/a' : round(r.errorMin, 1) + ' min'} reply="${r.trace.at(-1).text}"`);
}
console.log(`Simulated added cost per tool-using run (median): ${round(addedMedianMs)} ms = tool ${round(toolMedianMs)} ms + follow-up model call ${round(followUpMedianMs)} ms`);

const result = {
  metrics: [
    { name: 'No tool: scripted refusals', value: aRefused, unit: `of ${RUNS}` },
    { name: 'No tool: scripted guesses', value: aAnswered.length, unit: `of ${RUNS}` },
    { name: 'No tool: median error of scripted guesses (virtual clock)', value: round(aMedianErrMin), unit: 'minutes' },
    { name: 'With tool: runs where the scripted model called the tool', value: bToolCalls, unit: `of ${RUNS}` },
    { name: 'With tool: runs within 1 minute of the virtual clock', value: bWithin1, unit: `of ${RUNS}` },
    { name: 'With tool: median error (virtual clock)', value: round(bMedianErrSec, 1), unit: 'seconds' },
    { name: 'Simulated added cost per tool run, tool + follow-up call (median)', value: round(addedMedianMs), unit: 'simulated ms' },
    { name: 'Simulated tool execution time (median)', value: round(toolMedianMs), unit: 'simulated ms' },
    { name: 'Simulated follow-up model call (median)', value: round(followUpMedianMs), unit: 'simulated ms' },
  ],
  conclusion: `In this scripted demonstration with assumed behaviour, the reply matched the clock only when the app ran the tool and passed its result back (${bWithin1} of ${RUNS} tool-mode runs within a minute, against ${aRefused} refusals and guesses off by a median of ${round(aMedianErrMin / 1440)} days without it), and the tool path added a simulated median of ${round(addedMedianMs)} ms per run.`,
  setup: `scripted (not real) model, seed ${SEED}, ${RUNS} runs per mode, prompt "${PROMPT}", assumed guess date ${ASSUMED_GUESS_DAY}, virtual clock from ${new Date(CLOCK_START_MS).toISOString()}, simulated latency 400-1000 ms first call and 300-800 ms follow-up, tool 1-5 ms, assumed rates: refuse ${P_REFUSE_WITHOUT_TOOL}, skip tool ${P_SKIP_TOOL}, timezone slip ${P_TIMEZONE_SLIP}`,
};
console.log('RESULT ' + JSON.stringify(result));
