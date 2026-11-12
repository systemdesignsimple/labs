// sd-14 lab: CDN push vs pull as a DETERMINISTIC LATENCY MODEL on a virtual clock.
// Node.js 22 ESM, standard library only. No network, no files, no child processes.
// Nothing is timed with a real clock and no request is sent: every delay below is a configured
// number, and the latencies printed are computed from those numbers. Nothing is measured over a
// real Nepal link.

const CONFIG = {
  chunks: 20,              // 20 video chunks of a "new episode"
  chunkMs: 2000,           // each chunk holds 2 s of video
  runs: 3,                 // three cold runs per path
  seeds: [11, 22, 33],     // fixed seeds, one per run, jitter is drawn once per run and shared by all paths
  originRttMs: 250,        // viewer in Kathmandu to origin in US West (round figure from public ping tables)
  edgeRttMs: 10,           // viewer to an edge box inside Nepal
  edgeToOriginRttMs: 240,  // edge in Nepal to origin on a cache miss
  missOverheadMs: 15,      // edge lookup + writing the fetched chunk into its cache
  serverMs: 5,             // time a server spends finding and starting to send a chunk
  transferMs: 60,          // body transfer time, identical on every path (same bandwidth everywhere)
  jitter: 0.1,             // +/-10% seeded jitter on every network hop
  leadMs: 300,             // tight player buffer: next chunk is requested 300 ms before it is needed
};

// Small seeded PRNG (mulberry32) so every run is repeatable.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Matched jitter: for each run ONE table of jitter factors indexed by [viewer][chunk][hop] is drawn
// before any path runs. Hop 0 is the viewer's own hop (to the origin or to the edge); hop 1 is the
// edge-to-origin hop, used only on a pull miss. Every path reads the same cell for the same viewer,
// chunk and hop, so chunk 7 of viewer 1 gets identical jitter on the origin, pull and push paths,
// no matter how many hops a path happens to use.
const VIEWERS = 2;
const HOPS = 2;
function jitterTable(seed) {
  const rng = mulberry32(seed);
  const table = [];
  for (let v = 0; v < VIEWERS; v++) {
    const perViewer = [];
    for (let c = 0; c < CONFIG.chunks; c++) {
      const perChunk = [];
      for (let h = 0; h < HOPS; h++) perChunk.push(1 + (rng() * 2 - 1) * CONFIG.jitter);
      perViewer.push(perChunk);
    }
    table.push(perViewer);
  }
  return table;
}

// j is the per-hop factor array for one viewer and one chunk.
const hop = (j, h, baseMs) => baseMs * j[h];

// ---- The three paths ------------------------------------------------------

class Origin {
  constructor() { this.name = 'origin'; this.requests = 0; }
  fetch(_chunk, j) {
    this.requests++;
    return { ttfb: hop(j, 0, CONFIG.originRttMs) + CONFIG.serverMs, cache: 'none' };
  }
}

class EdgeCache {
  constructor(name, origin) {
    this.name = name;
    this.origin = origin;
    this.store = new Map();   // chunk id -> bytes (a placeholder string here)
    this.hits = 0;
    this.misses = 0;
  }
  // Push: copy chunks in ahead of time (how Open Connect boxes are filled during quiet hours).
  prefill(count) {
    for (let i = 0; i < count; i++) this.store.set(i, `chunk-${i}`);
  }
  fetch(chunk, j) {
    const toEdge = hop(j, 0, CONFIG.edgeRttMs);
    if (this.store.has(chunk)) {
      this.hits++;
      return { ttfb: toEdge + CONFIG.serverMs, cache: 'HIT' };
    }
    // Pull: a miss means the edge itself goes to the faraway origin, then keeps the chunk.
    // So a miss costs more than "the file is far away": it adds the edge-to-origin hop, the
    // configured miss overhead, and a second server delay (origin server, then edge server).
    this.misses++;
    this.origin.requests++;
    const fill = CONFIG.missOverheadMs + hop(j, 1, CONFIG.edgeToOriginRttMs) + CONFIG.serverMs;
    this.store.set(chunk, `chunk-${chunk}`);
    return { ttfb: toEdge + fill + CONFIG.serverMs, cache: 'MISS' };
  }
}

// ---- A viewer pressing play -------------------------------------------------
// Chunk 0 is requested at t=0; playback starts when it arrives (first frame).
// Chunk i must arrive before playStart + i*chunkMs (+ any rebuffering so far).
// The player asks for it leadMs before that deadline. Late = one stall.

function watch(path, jv) {
  let t = 0;
  let playStart = 0;
  let stalls = 0;
  let rebufferMs = 0;
  const rows = [];
  for (let i = 0; i < CONFIG.chunks; i++) {
    const deadline = i === 0 ? null : playStart + i * CONFIG.chunkMs + rebufferMs;
    const reqAt = i === 0 ? 0 : Math.max(t, deadline - CONFIG.leadMs);
    const r = path.fetch(i, jv[i]);
    const arrive = reqAt + r.ttfb + CONFIG.transferMs;
    let late = 0;
    if (i === 0) {
      playStart = arrive;
    } else if (arrive > deadline) {
      late = arrive - deadline;
      stalls++;
      rebufferMs += late;
    }
    t = arrive;
    rows.push({ chunk: i, ttfb: r.ttfb, cache: r.cache, late });
  }
  const ttfbs = rows.map((r) => r.ttfb);
  return {
    firstFrameMs: playStart,
    meanTtfbMs: ttfbs.reduce((a, b) => a + b, 0) / ttfbs.length,
    stalls,
    rebufferMs,
    hits: rows.filter((r) => r.cache === 'HIT').length,
    misses: rows.filter((r) => r.cache === 'MISS').length,
    rows,
  };
}

// ---- Experiment -------------------------------------------------------------

const PATHS = ['origin', 'pull', 'push'];
const results = {};
for (const p of PATHS) results[p] = { v1: [], v2: [] };

for (let run = 0; run < CONFIG.runs; run++) {
  const jt = jitterTable(CONFIG.seeds[run]);    // one jitter table per run, reused by every path
  for (const p of PATHS) {
    const origin = new Origin();
    let path = origin;
    if (p === 'pull') path = new EdgeCache('pull-edge', origin);          // starts empty (cold)
    if (p === 'push') { path = new EdgeCache('push-edge', origin); path.prefill(CONFIG.chunks); }
    results[p].v1.push(watch(path, jt[0]));   // first viewer of the new episode
    results[p].v2.push(watch(path, jt[1]));   // second viewer, same edge
  }
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const agg = (list) => ({
  firstFrameMs: Math.round(mean(list.map((x) => x.firstFrameMs))),
  meanTtfbMs: Math.round(mean(list.map((x) => x.meanTtfbMs))),
  stalls: +mean(list.map((x) => x.stalls)).toFixed(1),
  rebufferMs: Math.round(mean(list.map((x) => x.rebufferMs))),
  hitRate: Math.round((100 * mean(list.map((x) => x.hits))) / CONFIG.chunks),
});

const A = {};
for (const p of PATHS) A[p] = { v1: agg(results[p].v1), v2: agg(results[p].v2) };

// Per-chunk trace of run 1. The pull "miss then hit" shape needs two viewers: viewer 1 misses every
// chunk (each one is new to the edge), and viewer 2 then hits that same chunk. Both pull columns sit
// side by side so each chunk's miss and its later hit are on one line.
console.log('Run 1, modeled time to first byte per chunk (ms, computed from configured delays):');
console.log('chunk  origin v1     pull v1        pull v2        push v1');
for (let i = 0; i < CONFIG.chunks; i++) {
  const o = results.origin.v1[0].rows[i];
  const l1 = results.pull.v1[0].rows[i];
  const l2 = results.pull.v2[0].rows[i];
  const s = results.push.v1[0].rows[i];
  const cell = (r) => `${r.ttfb.toFixed(0).padStart(4)} ${r.cache.padEnd(4)}${r.late ? ' STALL' : '      '}`;
  console.log(`${String(i).padStart(5)}  ${cell(o)}  ${cell(l1)}  ${cell(l2)}  ${cell(s)}`);
}

console.log('\nAverages over 3 cold runs (deterministic model):');
console.log('path / viewer        first frame  mean TTFB  stalls  rebuffer  edge hit rate');
const line = (label, a) =>
  console.log(
    `${label.padEnd(20)} ${String(a.firstFrameMs).padStart(8)} ms ${String(a.meanTtfbMs).padStart(6)} ms ` +
      `${String(a.stalls).padStart(6)} ${String(a.rebufferMs).padStart(6)} ms ${String(a.hitRate).padStart(8)}%`,
  );
line('origin, viewer 1', A.origin.v1);
line('origin, viewer 2', A.origin.v2);
line('pull edge, viewer 1', A.pull.v1);
line('pull edge, viewer 2', A.pull.v2);
line('push edge, viewer 1', A.push.v1);
line('push edge, viewer 2', A.push.v2);
console.log('\nAll delays are configured stand-ins, not measurements, not Netflix numbers and not a real Nepal link.\n');

const metrics = [
  { name: 'origin_first_frame', value: A.origin.v1.firstFrameMs, unit: 'ms' },
  { name: 'pull_first_viewer_first_frame', value: A.pull.v1.firstFrameMs, unit: 'ms' },
  { name: 'pull_second_viewer_first_frame', value: A.pull.v2.firstFrameMs, unit: 'ms' },
  { name: 'push_first_viewer_first_frame', value: A.push.v1.firstFrameMs, unit: 'ms' },
  { name: 'origin_mean_ttfb', value: A.origin.v1.meanTtfbMs, unit: 'ms' },
  { name: 'pull_first_viewer_mean_ttfb', value: A.pull.v1.meanTtfbMs, unit: 'ms' },
  { name: 'pull_second_viewer_mean_ttfb', value: A.pull.v2.meanTtfbMs, unit: 'ms' },
  { name: 'push_first_viewer_mean_ttfb', value: A.push.v1.meanTtfbMs, unit: 'ms' },
  { name: 'origin_stalls_per_view', value: A.origin.v1.stalls, unit: 'stalls' },
  { name: 'pull_first_viewer_stalls', value: A.pull.v1.stalls, unit: 'stalls' },
  { name: 'pull_second_viewer_stalls', value: A.pull.v2.stalls, unit: 'stalls' },
  { name: 'push_first_viewer_stalls', value: A.push.v1.stalls, unit: 'stalls' },
  { name: 'pull_first_viewer_hit_rate', value: A.pull.v1.hitRate, unit: '%' },
  { name: 'push_first_viewer_hit_rate', value: A.push.v1.hitRate, unit: '%' },
];

const conclusion =
  `With the same bandwidth everywhere, the push edge showed the first frame in ${A.push.v1.firstFrameMs} ms ` +
  `for the very first viewer with ${A.push.v1.stalls} stalls, while the first pull viewer waited ` +
  `${A.pull.v1.firstFrameMs} ms with ${A.pull.v1.stalls} stalls and the origin alone took ` +
  `${A.origin.v1.firstFrameMs} ms with ${A.origin.v1.stalls} stalls; pull only caught up for the second viewer ` +
  `(${A.pull.v2.firstFrameMs} ms), so in this deterministic model the gap reflects the configured cache ` +
  `placement and hop delays plus the pull miss overhead and extra server delay, not a measured network.`;

const setup =
  `deterministic latency model, virtual clock, no real requests; ${CONFIG.chunks} chunks x ${CONFIG.chunkMs / 1000} s; ` +
  `${CONFIG.runs} cold runs, seeds ${CONFIG.seeds.join('/')}, jitter matched across paths by run/viewer/chunk/hop; origin RTT ${CONFIG.originRttMs} ms, ` +
  `edge RTT ${CONFIG.edgeRttMs} ms, edge-to-origin ${CONFIG.edgeToOriginRttMs} ms, miss overhead ` +
  `${CONFIG.missOverheadMs} ms, server ${CONFIG.serverMs} ms, transfer ${CONFIG.transferMs} ms on every path, ` +
  `jitter +/-${CONFIG.jitter * 100}%, player lead ${CONFIG.leadMs} ms`;

console.log('RESULT ' + JSON.stringify({ metrics, conclusion, setup }));
