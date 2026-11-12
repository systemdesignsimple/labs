// ai-21 second lab (rate limiter designs; the first lab, run.mjs, measures token budgets). Writes nothing itself;
// its saved output is rate-limiter-run-output.txt and rate-limiter-results.json (kept apart from run.mjs's results.json).
// "You sent 1 message. Why does it say 'too many requests'?"
// Node.js 22 ESM, standard library only, deterministic. Simulates one API key's traffic against a limit of
// 60 requests per minute and compares limiter designs. It shows the shape of the effect, not any provider's numbers.
//
// Part 1, one server: fixed window vs sliding log vs token bucket, under (a) an attacker who bursts at the window edge
// and (b) a normal app whose requests come in small bursts (a chat app sends several calls per message).
// Part 2, four servers behind a load balancer, each with its OWN counter vs one SHARED counter.

const LIMIT = 60, WINDOW = 60000;         // 60 requests per minute
const SEED = 2100;
function mulberry32(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function fixedWindow() { let start = 0, n = 0; return (t) => { const w = Math.floor(t / WINDOW) * WINDOW; if (w !== start) { start = w; n = 0; } if (n < LIMIT) { n++; return true; } return false; }; }
function slidingLog() { const log = []; return (t) => { while (log.length && log[0] <= t - WINDOW) log.shift(); if (log.length < LIMIT) { log.push(t); return true; } return false; }; }
function tokenBucket(capacity = 10, perMs = LIMIT / WINDOW) { let tokens = capacity, last = 0; return (t) => { tokens = Math.min(capacity, tokens + (t - last) * perMs); last = t; if (tokens >= 1) { tokens -= 1; return true; } return false; }; }

// most requests accepted in any 60 s span (the real rate the server had to absorb)
function worstMinute(accepted) { let best = 0, j = 0; for (let i = 0; i < accepted.length; i++) { while (accepted[i] - accepted[j] >= WINDOW) j++; best = Math.max(best, i - j + 1); } return best; }
// most accepted in any 1 s span (the spike)
function worstSecond(accepted) { let best = 0, j = 0; for (let i = 0; i < accepted.length; i++) { while (accepted[i] - accepted[j] >= 1000) j++; best = Math.max(best, i - j + 1); } return best; }

function play(times, limiter) { const acc = []; let rej = 0; for (const t of times) { if (limiter(t)) acc.push(t); else rej++; } return { accepted: acc.length, rejected: rej, worstMinute: worstMinute(acc), worstSecond: worstSecond(acc) }; }

// (a) edge burst: 60 requests in the last second of minute 1, 60 in the first second of minute 2
const edge = []; for (let i = 0; i < 60; i++) edge.push(59000 + i * 16); for (let i = 0; i < 60; i++) edge.push(60000 + i * 16);
// (b) a normal chat app for 10 minutes: one message every 4 to 20 s, each message = 3 to 6 calls within 400 ms
const rand = mulberry32(SEED); const chat = []; let msgs = 0;
for (let t = 0; t < 600000;) { t += 4000 + rand() * 16000; if (t >= 600000) break; msgs++; const k = 3 + Math.floor(rand() * 4); for (let i = 0; i < k; i++) chat.push(Math.round(t + rand() * 400)); }
chat.sort((a, b) => a - b);

const designs = [['fixed window', fixedWindow], ['sliding log', slidingLog], ['token bucket (burst 10)', () => tokenBucket(10)], ['token bucket (burst 3)', () => tokenBucket(3)]];
console.log(`ai-21 rate limiter lab: limit ${LIMIT} requests per minute, seed ${SEED}`);
console.log('\n(a) edge burst: 120 requests in 2 seconds across a minute boundary');
console.log('design                     accepted  rejected  worst 60 s  worst 1 s');
const A = {}; for (const [name, mk] of designs) { const r = play(edge, mk()); A[name] = r; console.log(`${name.padEnd(26)} ${String(r.accepted).padStart(8)}  ${String(r.rejected).padStart(8)}  ${String(r.worstMinute).padStart(10)}  ${String(r.worstSecond).padStart(9)}`); }
console.log(`\n(b) normal chat app, 10 minutes: ${msgs} messages, ${chat.length} calls (avg ${(chat.length / 10).toFixed(0)} per minute, under the limit)`);
console.log('design                     accepted  rejected  worst 60 s');
const B = {}; for (const [name, mk] of designs) { const r = play(chat, mk()); B[name] = r; console.log(`${name.padEnd(26)} ${String(r.accepted).padStart(8)}  ${String(r.rejected).padStart(8)}  ${String(r.worstMinute).padStart(10)}`); }

// Part 2: four servers, round robin, a client sending 4 requests per second for one minute (240 requests)
const flood = []; for (let i = 0; i < 240; i++) flood.push(i * 250);
const own = Array.from({ length: 4 }, () => slidingLog()); let ownAcc = 0; flood.forEach((t, i) => { if (own[i % 4](t)) ownAcc++; });
const shared = slidingLog(); let sharedAcc = 0; for (const t of flood) if (shared(t)) sharedAcc++;
console.log('\n(c) four servers, 240 requests in one minute (4 per second)');
console.log(`each server counts on its own : ${ownAcc} accepted (limit was ${LIMIT})`);
console.log(`one shared counter            : ${sharedAcc} accepted`);

const metrics = [
  { name: 'fixed window: accepted in the worst 60 s (edge burst)', value: A['fixed window'].worstMinute, unit: 'requests' },
  { name: 'fixed window: accepted in the worst 1 s (edge burst)', value: A['fixed window'].worstSecond, unit: 'requests' },
  { name: 'sliding log: accepted in the worst 60 s (edge burst)', value: A['sliding log'].worstMinute, unit: 'requests' },
  { name: 'token bucket: accepted in the worst 1 s (edge burst)', value: A['token bucket (burst 10)'].worstSecond, unit: 'requests' },
  { name: 'normal chat app: calls per 10 min', value: chat.length, unit: 'calls' },
  { name: 'normal chat app: rejected by token bucket (burst 10)', value: B['token bucket (burst 10)'].rejected, unit: 'calls' },
  { name: 'normal chat app: rejected by token bucket (burst 3)', value: B['token bucket (burst 3)'].rejected, unit: 'calls' },
  { name: 'normal chat app: messages', value: msgs, unit: 'messages' },
  { name: 'normal chat app: rejected by sliding log', value: B['sliding log'].rejected, unit: 'calls' },
  { name: 'four servers, own counters: accepted of 240', value: ownAcc, unit: 'requests' },
  { name: 'four servers, shared counter: accepted of 240', value: sharedAcc, unit: 'requests' },
];
console.log('RESULT ' + JSON.stringify({ metrics,
  conclusion: `With a ${LIMIT}/min limit, a fixed window let ${A['fixed window'].worstMinute} requests through in one minute when they straddled the boundary, a sliding log held it to ${A['sliding log'].worstMinute}; four servers with their own counters accepted ${ownAcc} of 240 while one shared counter accepted ${sharedAcc}.`,
  setup: `limit ${LIMIT}/60 s; edge burst 2x60 requests 16 ms apart around t=60 s; chat app 10 min, a message every 4 to 20 s with 3 to 6 calls within 400 ms; token buckets with capacity 10 and 3, refilling at 1/s; 4 servers round robin; seed ${SEED}` }));
