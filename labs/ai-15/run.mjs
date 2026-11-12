// AI #15 lab: "I interrupted the AI mid-sentence. Why did it keep talking?"
// Node.js 22 ESM, standard library only. Everything runs on a simulated clock,
// so it finishes in a second or two. Fixed seeds make every run identical.
import { writeFileSync } from 'node:fs';

// ---------- parameters ----------
const SR = 16000;              // mic sample rate (Hz)
const FRAME = 320;             // 20 ms frames
const FRAME_MS = 20;
const REPLY_MS = 8000;         // length of the assistant's spoken reply
const TOTAL_MS = REPLY_MS + 1000;
const CHUNK_MS = 100;          // streaming playback chunk; the chunk already sent to the speaker cannot be recalled
const CALIB_FRAMES = 25;       // first 500 ms of mic (background only) sets the noise floor
const MIN_FRAMES = 3;          // detector needs 3 frames in a row (60 ms) above threshold
const RUNS = 20;               // runs per case
const NOISE_STD = 0.003;       // room background noise
const THRESH = { low: 6, mid: 12, high: 18 }; // dB above the noise floor
const ONSET_MIN = 1500, ONSET_MAX = 6500;     // when the user (or cough, or clatter) starts, ms into the reply
const USER_DB = [26, 3];       // user voice level above floor: mean, spread
const COUGH_DB = [22, 3];
const CLATTER_DB = [10, 3];
const SEED = 15;
const USER_CLIP_MS = 850;      // "wait, stop"

// ---------- seeded random ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rng) {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}
const msToSample = (ms) => Math.round((ms * SR) / 1000);
const dbToAmp = (db) => (db <= -60 ? 0 : Math.pow(10, db / 20));

// piecewise-linear envelope in dB: keys = [[ms, dB], ...]
function envDb(keys, ms) {
  if (ms <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [m1, d1] = keys[i];
    const [m0, d0] = keys[i - 1];
    if (ms <= m1) return d0 + ((d1 - d0) * (ms - m0)) / (m1 - m0);
  }
  return keys[keys.length - 1][1];
}

// ---------- synthetic sounds (no recordings allowed, so we build them) ----------
// "wait, stop": soft voiced "w" lead-in, vowel, stop gap, hissy "s", vowel, "p".
const VOICED_KEYS = [[0, -60], [30, -15], [90, -15], [160, 0], [260, -2], [300, -20], [330, -60],
  [520, -60], [560, -3], [700, 0], [800, -4], [850, -60]];
const HISS_KEYS = [[0, -60], [400, -60], [420, -12], [500, -12], [520, -60], [850, -60]];
const HARM = 8;
const HARM_NORM = 1 / Math.sqrt([...Array(HARM)].reduce((s, _, k) => s + 1 / ((k + 1) ** 2), 0) / 2);

function addSpeech(buf, startMs, levelDb, rng) {
  const g = NOISE_STD * dbToAmp(levelDb);
  const s0 = msToSample(startMs);
  let phase = 0;
  for (let i = 0; i < msToSample(USER_CLIP_MS); i++) {
    const ms = (i * 1000) / SR;
    const f0 = 140 + 20 * Math.sin(2 * Math.PI * 1.5 * (ms / 1000));
    phase += (2 * Math.PI * f0) / SR;
    let v = 0;
    for (let k = 1; k <= HARM; k++) v += Math.sin(k * phase) / k;
    const sample = dbToAmp(envDb(VOICED_KEYS, ms)) * v * HARM_NORM + dbToAmp(envDb(HISS_KEYS, ms)) * gauss(rng);
    if (s0 + i < buf.length) buf[s0 + i] += g * sample;
  }
}

// cough: sharp 10 ms attack, fast exponential decay, 300 ms total
function addCough(buf, startMs, levelDb, rng) {
  const g = NOISE_STD * dbToAmp(levelDb);
  const s0 = msToSample(startMs);
  for (let i = 0; i < msToSample(300); i++) {
    const ms = (i * 1000) / SR;
    const env = ms < 10 ? ms / 10 : Math.exp(-(ms - 10) / 60);
    if (s0 + i < buf.length) buf[s0 + i] += g * env * gauss(rng);
  }
}

// background clatter: 400 ms burst, 30 ms ramps
function addClatter(buf, startMs, levelDb, rng) {
  const g = NOISE_STD * dbToAmp(levelDb);
  const s0 = msToSample(startMs);
  for (let i = 0; i < msToSample(400); i++) {
    const ms = (i * 1000) / SR;
    const env = Math.min(1, ms / 30, (400 - ms) / 30);
    if (s0 + i < buf.length) buf[s0 + i] += g * env * gauss(rng);
  }
}

// ---------- detector ----------
function frameDbOverFloor(buf) {
  const n = Math.floor(buf.length / FRAME);
  const ms = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    let e = 0;
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) e += buf[i] * buf[i];
    ms[f] = e / FRAME;
  }
  let floor = 0;
  for (let f = 0; f < CALIB_FRAMES; f++) floor += ms[f];
  floor /= CALIB_FRAMES;
  return Array.from(ms, (e) => 10 * Math.log10(e / floor));
}

// returns ms at which the detector fires while the reply is still playing, or null
function detect(db, thr) {
  let run = 0;
  const lastFrame = REPLY_MS / FRAME_MS;
  for (let f = CALIB_FRAMES; f < lastFrame; f++) {
    run = db[f] > thr ? run + 1 : 0;
    if (run >= MIN_FRAMES) return (f + 1) * FRAME_MS;
  }
  return null;
}

// streaming playback: on a stop, the queue is cleared but the chunk already at the speaker plays out.
// Event order: a stop that lands exactly on a chunk boundary cancels before the next chunk starts,
// so it adds no extra chunk (ceil, not floor + 1).
const streamingStop = (detectMs) => Math.min(REPLY_MS, Math.ceil(detectMs / CHUNK_MS) * CHUNK_MS);

// ---------- run ----------
const KINDS = ['speech', 'cough', 'clatter'];
const SETUPS = [
  { key: 'A', label: 'A no barge-in', thr: null },
  { key: 'B', label: 'B stream + VAD 12 dB', thr: THRESH.mid },
  { key: 'C-low', label: 'C stream + VAD 6 dB', thr: THRESH.low },
  { key: 'C-high', label: 'C stream + VAD 18 dB', thr: THRESH.high },
];
const res = Object.fromEntries(SETUPS.map((s) => [s.key, { talk: [], delay: [], missed: 0, early: 0, cough: 0, clatter: 0 }]));
const timeline = [];

for (let k = 0; k < KINDS.length; k++) {
  const kind = KINDS[k];
  for (let r = 0; r < RUNS; r++) {
    const rng = mulberry32(SEED * 1000 + k * 100 + r);
    const onset = Math.round(ONSET_MIN + rng() * (ONSET_MAX - ONSET_MIN));
    const buf = new Float32Array(msToSample(TOTAL_MS));
    for (let i = 0; i < buf.length; i++) buf[i] = NOISE_STD * gauss(rng);
    if (kind === 'speech') addSpeech(buf, onset, USER_DB[0] + USER_DB[1] * gauss(rng), rng);
    if (kind === 'cough') addCough(buf, onset, COUGH_DB[0] + COUGH_DB[1] * gauss(rng), rng);
    if (kind === 'clatter') addClatter(buf, onset, CLATTER_DB[0] + CLATTER_DB[1] * gauss(rng), rng);
    const db = frameDbOverFloor(buf);

    for (const s of SETUPS) {
      const out = res[s.key];
      const d = s.thr === null ? null : detect(db, s.thr);
      if (kind === 'speech') {
        let stop = REPLY_MS;
        if (d === null) { if (s.thr !== null) out.missed++; }
        else if (d < onset) { out.early++; stop = streamingStop(d); }
        else { out.delay.push(d - onset); stop = streamingStop(d); }
        out.talk.push(Math.max(0, stop - onset));
        if (r === 0) timeline.push({ setup: s.label, userStartMs: onset, userEndMs: onset + USER_CLIP_MS, detectMs: d, stopMs: stop, replyEndMs: REPLY_MS });
      } else if (d !== null) {
        out[kind]++;
      }
    }
  }
}

// ---------- report ----------
const mean = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
const p90 = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.ceil(0.9 * s.length) - 1]; };
const pct = (n) => Math.round((100 * n) / RUNS);
// detection delay is conditional on a successful detection (fired at or after the user's onset);
// missed runs and early triggers are excluded from it and reported on their own
const delayText = (o) => (o.delay.length ? `${mean(o.delay)} ms (n=${o.delay.length}/${RUNS})` : `n/a (n=0/${RUNS})`);

console.log('AI #15 lab: talk-over time and false stops (simulation, not product numbers)\n');
console.log('setup                   talk-over mean     p90  detect delay (valid n)   missed  early  cough stops  clatter stops');
for (const s of SETUPS) {
  const o = res[s.key];
  const det = s.thr === null ? '-' : delayText(o);
  const fs = (n) => (s.thr === null ? '-' : `${pct(n)}%`);
  console.log(
    `${s.label.padEnd(24)}${(mean(o.talk) + ' ms').padStart(10)}${(p90(o.talk) + ' ms').padStart(10)}` +
    `${det.padStart(22)}${fs(o.missed).padStart(9)}${fs(o.early).padStart(7)}${fs(o.cough).padStart(12)}${fs(o.clatter).padStart(14)}`
  );
}
console.log('detect delay counts only speech runs where the detector fired at or after the user started.');
console.log('missed = never fired during the reply; early = fired before the user spoke (a premature stop, not a handled interruption).');

// timeline strip for the first speech run, 50 ms per character
const t0 = Math.max(0, timeline[0].userStartMs - 500);
const STEP = 50;
const strip = (fn) => { let s = ''; for (let t = t0; t < REPLY_MS; t += STEP) s += fn(t) ? '#' : '.'; return s; };
console.log(`\ntimeline, speech run 1, from ${t0} ms to ${REPLY_MS} ms, one character = ${STEP} ms`);
console.log(`${'user "wait, stop"'.padEnd(24)}${strip((t) => t >= timeline[0].userStartMs && t < timeline[0].userEndMs)}`);
for (const row of timeline) console.log(`${row.setup.padEnd(24)}${strip((t) => t < row.stopMs)}`);
writeFileSync(new URL('./timeline.json', import.meta.url), JSON.stringify({ stepMs: STEP, runs: timeline }, null, 2));
console.log('\nwrote timeline.json (first speech run, all setups)\n');

const A = res.A, B = res.B, L = res['C-low'], H = res['C-high'];
const metrics = [
  { name: 'A talk-over mean', value: mean(A.talk), unit: 'ms' },
  { name: 'A talk-over p90', value: p90(A.talk), unit: 'ms' },
];
for (const [key, name] of [['B', 'B 12 dB'], ['C-low', 'C 6 dB'], ['C-high', 'C 18 dB']]) {
  const o = res[key];
  metrics.push(
    { name: `${name} talk-over mean`, value: mean(o.talk), unit: 'ms' },
    { name: `${name} talk-over p90`, value: p90(o.talk), unit: 'ms' },
    { name: `${name} valid detections`, value: o.delay.length, unit: `of ${RUNS} speech runs` },
  );
  // an empty sample has no delay; report it as missing rather than 0 ms
  if (o.delay.length) metrics.push({ name: `${name} detection delay mean (valid detections only)`, value: mean(o.delay), unit: 'ms' });
  metrics.push(
    { name: `${name} missed speech`, value: pct(o.missed), unit: '%' },
    { name: `${name} early triggers before speech`, value: pct(o.early), unit: '%' },
    { name: `${name} false stops on cough`, value: pct(o.cough), unit: '%' },
    { name: `${name} false stops on clatter`, value: pct(o.clatter), unit: '%' },
  );
}
const reacted = (o) => {
  const parts = [o.delay.length
    ? `reacted in ${mean(o.delay)} ms on the ${o.delay.length} of ${RUNS} speech runs it caught in time`
    : `caught none of the ${RUNS} speech runs`];
  if (o.missed) parts.push(`missed ${o.missed}`);
  if (o.early) parts.push(`fired before the user spoke on ${o.early}`);
  return parts.join(', ');
};
const conclusion =
  `With no barge-in handling the assistant kept talking for ${mean(A.talk)} ms on average after the user spoke, ` +
  `streaming in ${CHUNK_MS} ms chunks with a 12 dB energy detector cut that to ${mean(B.talk)} ms (it ${reacted(B)}), ` +
  `and the 6 dB threshold ${reacted(L)} with ${pct(L.cough)}% cough and ${pct(L.clatter)}% clatter false stops, ` +
  `while the 18 dB threshold ${reacted(H)} with ${pct(H.cough)}% and ${pct(H.clatter)}%.`;
const setup =
  `simulated 16 kHz mic, 20 ms frames, ${REPLY_MS} ms reply, ${CHUNK_MS} ms playback chunks (a stop on a chunk boundary cancels before the next chunk starts), detection delay averaged over valid detections only, energy VAD firing after ${MIN_FRAMES} frames above 6/12/18 dB over a noise floor calibrated on the first 500 ms, ` +
  `${RUNS} runs per case (speech, cough, clatter), onset ${ONSET_MIN} to ${ONSET_MAX} ms, levels user ${USER_DB[0]}±${USER_DB[1]} dB, cough ${COUGH_DB[0]}±${COUGH_DB[1]} dB, clatter ${CLATTER_DB[0]}±${CLATTER_DB[1]} dB, echo assumed cancelled, seed ${SEED}`;
console.log('RESULT ' + JSON.stringify({ metrics, conclusion, setup }));
