// AI #2 lab: streaming vs buffered replies (time to first text vs total time).
// Node.js 22 ESM, standard library only. No network, no child processes.
// Everything runs in-process: a stand-in text generator, two "endpoints"
// that return byte streams like an HTTP body would, and a client that reads them.
// Only file written: timeline.json in this folder (word arrival times for the video).

import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------- parameters
const TRIALS = 20;        // calls per mode
const WORDS = 120;        // tokens in the fixed answer (one word = one token here)
const BASE_MS = 33;       // average delay per token, so ~4 s for the full answer
const JITTER_MS = 8;      // seeded +/- jitter per token
const SEED = 42;          // fixed seed: trial i uses the same delays in both modes
// Tolerances used to word the conclusion (the conclusion is derived only from these checks):
const TOTAL_TOL_PCT = 5;            // total-time medians within this % of buffered = "about the same"
const FIRST_TEXT_MIN_GAP_MS = 100;  // streaming must beat buffered first text by more than this...
const FIRST_TEXT_MIN_GAP_PCT = 50;  // ...and by more than this % of the buffered first-text time

const HERE = dirname(fileURLToPath(import.meta.url));

// A fixed answer, cut or repeated to exactly WORDS words.
const SOURCE_TEXT = `A model does not write the whole answer at once. It makes the answer one small
piece at a time, and each piece takes a little while. If the app waits for every piece before
showing anything, you stare at an empty screen until the very end. If the app shows each piece
the moment it exists, you start reading almost right away. The total time is the same in both
cases, because the model still has to make every piece. What changes is when you see the first
words. That first moment is what makes an app feel fast or slow. This is why chat apps stream
their replies. The answer is not finished sooner. It just starts sooner, and you can read while
the rest is still being made.`;
const base = SOURCE_TEXT.split(/\s+/).filter(Boolean);
const ANSWER = Array.from({ length: WORDS }, (_, i) => base[i % base.length]);

// ---------------------------------------------------------------- seeded RNG
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tokenDelays(trial) {
  const rand = mulberry32(SEED + trial);
  return Array.from({ length: WORDS }, () => BASE_MS + Math.round((rand() * 2 - 1) * JITTER_MS));
}

// ---------------------------------------------------------------- generator
// Stand-in for a model: yields one token after each delay.
async function* generate(trial) {
  const delays = tokenDelays(trial);
  for (let i = 0; i < WORDS; i++) {
    await sleep(delays[i]);
    yield (i === 0 ? '' : ' ') + ANSWER[i];
  }
}

const enc = new TextEncoder();

// ---------------------------------------------------------------- "endpoints"
// /buffered: collect every token, send the whole reply as one JSON body at the end.
function bufferedEndpoint(trial) {
  return new ReadableStream({
    async start(controller) {
      let text = '';
      for await (const tok of generate(trial)) text += tok;
      controller.enqueue(enc.encode(JSON.stringify({ text })));
      controller.close();
    },
  });
}

// /stream: send each token the moment it is made, framed as Server-Sent Events.
function streamEndpoint(trial) {
  return new ReadableStream({
    async start(controller) {
      for await (const tok of generate(trial)) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(tok)}\n\n`));
      }
      controller.enqueue(enc.encode('event: done\ndata: {}\n\n'));
      controller.close();
    },
  });
}

// ---------------------------------------------------------------- client
async function callBuffered(trial) {
  const t0 = performance.now();
  const reader = bufferedEndpoint(trial).getReader();
  const dec = new TextDecoder();
  let raw = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    raw += dec.decode(value, { stream: true });
  }
  raw += dec.decode();
  const { text } = JSON.parse(raw);
  const shown = performance.now() - t0; // no text is available to the client until the full body is parsed
  const words = text.split(' ');
  return {
    ttft: shown,
    total: shown,
    timeline: words.map((word, i) => ({ i, word, ms: round1(shown) })),
  };
}

async function callStream(trial) {
  const t0 = performance.now();
  const reader = streamEndpoint(trial).getReader();
  const dec = new TextDecoder();
  let buf = '';
  let ttft = null;
  let last = 0;
  const timeline = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let cut;
    while ((cut = buf.indexOf('\n\n')) !== -1) {
      const event = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      if (event.startsWith('event: done')) continue;
      const line = event.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      const tok = JSON.parse(line.slice(6));
      const now = performance.now() - t0;
      if (ttft === null && tok.trim().length > 0) ttft = now;
      last = now;
      timeline.push({ i: timeline.length, word: tok.trim(), ms: round1(now) });
    }
  }
  return { ttft, total: last, timeline };
}

// ---------------------------------------------------------------- stats
function round1(x) { return Math.round(x * 10) / 10; }
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function p95(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
}

// ---------------------------------------------------------------- run
const runStart = performance.now();

// Both modes for every trial run at the same time on the same event loop,
// so they share the same conditions. Trial i uses identical token delays in both modes.
const jobs = [];
for (let t = 0; t < TRIALS; t++) {
  jobs.push(callBuffered(t).then((r) => ({ mode: 'buffered', trial: t, ...r })));
  jobs.push(callStream(t).then((r) => ({ mode: 'stream', trial: t, ...r })));
}
const results = await Promise.all(jobs);

const by = (mode) => results.filter((r) => r.mode === mode);
const buf = by('buffered');
const str = by('stream');

const bTtftMed = round1(median(buf.map((r) => r.ttft)));
const bTtftP95 = round1(p95(buf.map((r) => r.ttft)));
const sTtftMed = round1(median(str.map((r) => r.ttft)));
const sTtftP95 = round1(p95(str.map((r) => r.ttft)));
const bTotMed = round1(median(buf.map((r) => r.total)));
const bTotP95 = round1(p95(buf.map((r) => r.total)));
const sTotMed = round1(median(str.map((r) => r.total)));
const sTotP95 = round1(p95(str.map((r) => r.total)));
const totDiff = round1(sTotMed - bTotMed);
const firstTextSooner = round1(bTtftMed - sTtftMed);
const totTolMs = round1((TOTAL_TOL_PCT / 100) * bTotMed);
const totSame = Math.abs(totDiff) <= totTolMs;
const startsSooner =
  firstTextSooner > FIRST_TEXT_MIN_GAP_MS && firstTextSooner > (FIRST_TEXT_MIN_GAP_PCT / 100) * bTtftMed;
const startsLater = -firstTextSooner > FIRST_TEXT_MIN_GAP_MS;

// Timeline of trial 0 in both modes, for drawing the two runs filling in on screen.
const timelineFile = join(HERE, 'timeline.json');
writeFileSync(
  timelineFile,
  JSON.stringify(
    {
      note: 'Simulated generator, in-process byte streams (no HTTP). Times are client text-availability, not render time. Not a real AI product.',
      trial: 0,
      words: WORDS,
      buffered: buf.find((r) => r.trial === 0).timeline,
      stream: str.find((r) => r.trial === 0).timeline,
    },
    null,
    2,
  ),
);

const runMs = round1(performance.now() - runStart);

console.log('Streaming vs buffered, simulated generator, in-process');
console.log(`trials per mode: ${TRIALS}, words: ${WORDS}, delay per token: ${BASE_MS} +/- ${JITTER_MS} ms, seed ${SEED}`);
console.log('');
console.log('mode       first text median  first text p95   total median   total p95');
console.log(`buffered   ${String(bTtftMed).padStart(10)} ms  ${String(bTtftP95).padStart(10)} ms  ${String(bTotMed).padStart(10)} ms  ${String(bTotP95).padStart(8)} ms`);
console.log(`stream     ${String(sTtftMed).padStart(10)} ms  ${String(sTtftP95).padStart(10)} ms  ${String(sTotMed).padStart(10)} ms  ${String(sTotP95).padStart(8)} ms`);
console.log('');
console.log(`first text available ${firstTextSooner} ms sooner when streaming; total time stream minus buffered: ${totDiff} ms (tolerance +/- ${totTolMs} ms)`);
console.log('times = when the client has parsed the text, not when characters are drawn on a screen');
console.log(`timeline written to ${timelineFile}`);
console.log(`lab run time: ${runMs} ms`);

// Every part of the conclusion comes from the measured differences and the tolerances above.
const firstPhrase = startsSooner
  ? `the client had the first text after a median ${sTtftMed} ms when streaming versus ${bTtftMed} ms buffered`
  : startsLater
    ? `the client had the first text later when streaming (median ${sTtftMed} ms versus ${bTtftMed} ms buffered)`
    : `the client had the first text at a similar time in both modes (median ${sTtftMed} ms stream versus ${bTtftMed} ms buffered)`;
const totalPhrase = totSame
  ? `total time was within ${TOTAL_TOL_PCT}% (${sTotMed} ms vs ${bTotMed} ms)`
  : `total time differed by more than ${TOTAL_TOL_PCT}% (${sTotMed} ms stream vs ${bTotMed} ms buffered)`;
let meaning;
if (startsSooner && totSame) meaning = 'so here streaming made the text start sooner, not finish sooner';
else if (startsSooner && totDiff < 0) meaning = 'so here streaming started sooner and also finished sooner, which differs from the expected result';
else if (startsSooner) meaning = 'so here streaming started sooner but finished later';
else meaning = 'so this run did not show the expected start-sooner effect';
const conclusion =
  `In this in-process simulation, ${firstPhrase} and ${totalPhrase}, ${meaning}.`;

const result = {
  metrics: [
    { name: 'stream_time_to_first_text_median', value: sTtftMed, unit: 'ms' },
    { name: 'stream_time_to_first_text_p95', value: sTtftP95, unit: 'ms' },
    { name: 'buffered_time_to_first_text_median', value: bTtftMed, unit: 'ms' },
    { name: 'buffered_time_to_first_text_p95', value: bTtftP95, unit: 'ms' },
    { name: 'stream_total_time_median', value: sTotMed, unit: 'ms' },
    { name: 'stream_total_time_p95', value: sTotP95, unit: 'ms' },
    { name: 'buffered_total_time_median', value: bTotMed, unit: 'ms' },
    { name: 'buffered_total_time_p95', value: bTotP95, unit: 'ms' },
    { name: 'first_text_sooner_by_streaming', value: firstTextSooner, unit: 'ms' },
    { name: 'total_time_difference_stream_minus_buffered', value: totDiff, unit: 'ms' },
  ],
  conclusion,
  setup:
    `in-process simulated generator, ${WORDS} words, ${BASE_MS}+/-${JITTER_MS} ms per token (seed ${SEED}), ` +
    `${TRIALS} calls per mode run concurrently, buffered = one JSON body at the end, stream = SSE frame per token, ` +
    `in-process byte streams replace the planned HTTP chunked transport (no network), no model think-time before the first token, ` +
    `times are client text-availability (parsed, not rendered), total-time tolerance ${TOTAL_TOL_PCT}%, ` +
    `first-text gap must exceed ${FIRST_TEXT_MIN_GAP_MS} ms and ${FIRST_TEXT_MIN_GAP_PCT}% of buffered`,
};
console.log('RESULT ' + JSON.stringify(result));
