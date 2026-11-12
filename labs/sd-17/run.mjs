// sd #17 lab: Layer 4 vs Layer 7 load balancing, "reading the envelope vs reading the letter".
// Node.js 22 ESM, standard library only. Everything runs in-process: no sockets, no network,
// no child processes, no files. Fixed seed, so the request bytes and routing results repeat exactly.
//
// Part 1, routing (deterministic):
//   * Clients produce real HTTP/1.1 request bytes, cut into random TCP-sized segments.
//   * The L4 balancer never reads those bytes. It picks a backend once per connection from the
//     "envelope" (source ip + port hash) and copies every segment through untouched.
//   * The L7 balancer runs an HTTP parser over the stream, finds each request, reads the path,
//     picks a backend per request (round robin, plus a rule: /images/* goes to B only), and
//     rebuilds the request for the upstream (adds X-Forwarded-For).
//   * Backends A and B parse what they receive and count the requests they serve.
// Part 2, processing time (measured, varies by machine and run):
//   * The same seeded byte stream is pushed through four in-process paths: direct to a backend,
//     through L4, through L7 that only parses and routes (forwards the original bytes), and through
//     the full L7 (parse, route, rebuild). Warmup first, then many interleaved timed samples.
//   * This is in-process processing time of this JavaScript code on this machine. No network, no responses, no TLS.

import { performance } from 'node:perf_hooks';

const SEED = 17;
const CFG = {
  requestsPerTest: 1000,
  manyConnections: 50,
  imagesShare: 0.3,
  segmentMin: 64,
  segmentMax: 1460,
  // timing experiment
  benchRequests: 2000,     // requests per timed sample (one kept-open connection)
  warmupRounds: 40,        // untimed rounds per path, lets the JIT settle
  sampleRounds: 200,       // timed rounds per path, paths interleaved in a rotating order
};

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
const randInt = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

// ---------- HTTP bytes ----------
const UAS = ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6)', 'okhttp/4.12.0'];
function buildRequest(r, path) {
  const cookie = 'session=' + Math.floor(r() * 1e12).toString(36) + '; theme=dark' + (r() < 0.5 ? '; cart=' + 'x'.repeat(randInt(r, 10, 120)) : '');
  return Buffer.from(
    `GET ${path} HTTP/1.1\r\n` +
    `Host: shop.local\r\n` +
    `User-Agent: ${UAS[randInt(r, 0, UAS.length - 1)]}\r\n` +
    `Accept: */*\r\n` +
    `Cookie: ${cookie}\r\n` +
    `Connection: keep-alive\r\n\r\n`, 'latin1');
}

// Streaming HTTP/1.1 request parser (GET only, no bodies). Requests can arrive split across
// segments or several per segment; the parser has to find the boundaries itself.
class HttpStreamParser {
  constructor() { this.buf = Buffer.alloc(0); }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      const end = this.buf.indexOf('\r\n\r\n', 0, 'latin1');
      if (end === -1) break;
      const raw = this.buf.subarray(0, end + 4);
      const lines = this.buf.subarray(0, end).toString('latin1').split('\r\n');
      const [method, path, version] = lines[0].split(' ');
      const headers = [];
      for (let i = 1; i < lines.length; i++) {
        const c = lines[i].indexOf(':');
        headers.push([lines[i].slice(0, c).trim(), lines[i].slice(c + 1).trim()]);
      }
      out.push({ method, path, version, headers, raw });
      this.buf = this.buf.subarray(end + 4);
    }
    return out;
  }
}

// L7 writes a fresh request for the upstream: same line and headers, plus X-Forwarded-For.
function rebuild(req, clientIp) {
  let s = `${req.method} ${req.path} ${req.version}\r\n`;
  for (const [k, v] of req.headers) s += `${k}: ${v}\r\n`;
  s += `X-Forwarded-For: ${clientIp}\r\n\r\n`;
  return Buffer.from(s, 'latin1');
}

// ---------- backends ----------
class Backend {
  constructor(name) { this.name = name; this.count = 0; this.parsers = new Map(); }
  receive(connKey, chunk) {
    if (!this.parsers.has(connKey)) this.parsers.set(connKey, new HttpStreamParser());
    const reqs = this.parsers.get(connKey).push(chunk);
    this.count += reqs.length;
    return reqs.map((q) => ({ backend: this.name, path: q.path }));
  }
}

// ---------- balancers ----------
// L4: sees only the envelope (src ip, src port, dst ip, dst port). One decision per connection.
class L4Balancer {
  constructor(backends) { this.backends = backends; this.table = new Map(); this.bytesCopied = 0; this.decisions = 0; }
  connect(conn) {
    const h = fnv1a(`${conn.srcIp}:${conn.srcPort}->10.0.0.1:443`);
    this.table.set(conn.id, this.backends[h % this.backends.length]);
    this.decisions++;
  }
  data(conn, chunk) {
    const copy = Buffer.from(chunk);                          // copied into the upstream, never read
    this.bytesCopied += copy.length;
    return this.table.get(conn.id).receive(`l4:${conn.id}`, copy);
  }
}

// L7: opens the letter. Parses every request, one decision per request.
// rebuildUpstream=false forwards a plain copy of the original bytes, like L4 does (used only to
// split the timing into parts: parse + route, then rebuild).
class L7Balancer {
  constructor(backends, rebuildUpstream = true) {
    this.backends = backends; this.rebuildUpstream = rebuildUpstream;
    this.parsers = new Map(); this.rr = 0; this.decisions = 0;
  }
  connect(conn) { this.parsers.set(conn.id, { parser: new HttpStreamParser(), ip: conn.srcIp }); }
  pick(req) {
    this.decisions++;
    if (req.path.startsWith('/images/')) return this.backends.find((b) => b.name === 'B');
    return this.backends[this.rr++ % this.backends.length];
  }
  data(conn, chunk) {
    const st = this.parsers.get(conn.id);
    const served = [];
    for (const req of st.parser.push(chunk)) {
      const b = this.pick(req);
      const bytes = this.rebuildUpstream ? rebuild(req, st.ip) : Buffer.from(req.raw); // both write new upstream bytes
      for (const s of b.receive(`l7pool:${b.name}`, bytes)) served.push(s); // pooled upstream per backend
    }
    return served;
  }
}

// ---------- client workload ----------
function makePlan(r, connections, total, withImages) {
  const plan = [];
  const per = Math.floor(total / connections);
  for (let c = 0; c < connections; c++) {
    const paths = [];
    for (let i = 0; i < per; i++) {
      const img = withImages && r() < CFG.imagesShare;
      paths.push(img ? `/images/p${randInt(r, 1, 500)}.jpg` : `/api/items/${randInt(r, 1, 9999)}`);
    }
    plan.push({ id: c, srcIp: `203.0.113.${randInt(r, 2, 254)}`, srcPort: randInt(r, 32768, 60999), paths });
  }
  return plan;
}

function runTest(kind, plan, segSeed) {
  const backends = [new Backend('A'), new Backend('B')];
  const lb = kind === 'L4' ? new L4Balancer(backends) : new L7Balancer(backends);
  const r = mulberry32(segSeed);                 // same request bytes and segment cuts for L4 and L7
  const served = [];
  for (const conn of plan) {
    lb.connect(conn);
    const stream = Buffer.concat(conn.paths.map((p) => buildRequest(r, p)));
    for (let off = 0; off < stream.length;) {
      const len = randInt(r, CFG.segmentMin, CFG.segmentMax);
      for (const s of lb.data(conn, stream.subarray(off, off + len))) served.push(s);
      off += len;
    }
  }
  const imgs = served.filter((s) => s.path.startsWith('/images/'));
  return {
    A: backends[0].count, B: backends[1].count, decisions: lb.decisions,
    imagesTotal: imgs.length, imagesOnB: imgs.filter((s) => s.backend === 'B').length,
  };
}

// ---------- run part 1: routing ----------
const t0 = performance.now();
const plans = {
  keepalive: makePlan(rng, 1, CFG.requestsPerTest, false),
  many: makePlan(rng, CFG.manyConnections, CFG.requestsPerTest, false),
  mixed: makePlan(rng, CFG.manyConnections, CFG.requestsPerTest, true),
};
const res = {};
for (const [name, plan] of Object.entries(plans)) {
  const segSeed = SEED * 1000 + name.length;
  res[name] = { L4: runTest('L4', plan, segSeed), L7: runTest('L7', plan, segSeed) };
}

// ---------- run part 2: measured processing time ----------
// One seeded stream of benchRequests requests on one connection, pre-cut into segments, so every
// path processes exactly the same bytes. Only the processing is timed (setup is outside the clock).
const benchR = mulberry32(SEED + 2);
const benchConn = { id: 0, srcIp: '203.0.113.17', srcPort: 40017 };
const benchStream = Buffer.concat(Array.from({ length: CFG.benchRequests }, () =>
  buildRequest(benchR, benchR() < CFG.imagesShare ? `/images/p${randInt(benchR, 1, 500)}.jpg` : `/api/items/${randInt(benchR, 1, 9999)}`)));
const benchSegs = [];
for (let off = 0; off < benchStream.length;) {
  const len = randInt(benchR, CFG.segmentMin, CFG.segmentMax);
  benchSegs.push(benchStream.subarray(off, off + len));
  off += len;
}

const PATHS = {
  direct: () => { const b = new Backend('A'); return (seg) => b.receive('direct', seg).length; },
  L4: () => { const lb = new L4Balancer([new Backend('A'), new Backend('B')]); lb.connect(benchConn); return (seg) => lb.data(benchConn, seg).length; },
  L7parse: () => { const lb = new L7Balancer([new Backend('A'), new Backend('B')], false); lb.connect(benchConn); return (seg) => lb.data(benchConn, seg).length; },
  L7full: () => { const lb = new L7Balancer([new Backend('A'), new Backend('B')], true); lb.connect(benchConn); return (seg) => lb.data(benchConn, seg).length; },
};
const NAMES = Object.keys(PATHS);
function sampleOnce(name) {
  const step = PATHS[name]();
  let n = 0;
  const s = performance.now();
  for (const seg of benchSegs) n += step(seg);
  const elapsedMs = performance.now() - s;
  if (n !== CFG.benchRequests) throw new Error(`${name} served ${n} of ${CFG.benchRequests}`);
  return (elapsedMs * 1e6) / n;                           // ns per request for this sample
}
for (let i = 0; i < CFG.warmupRounds; i++) for (const nm of NAMES) sampleOnce(nm);
const samples = Object.fromEntries(NAMES.map((n) => [n, []]));
for (let i = 0; i < CFG.sampleRounds; i++) {
  for (let j = 0; j < NAMES.length; j++) {               // rotate order so no path always runs first
    const nm = NAMES[(i + j) % NAMES.length];
    samples[nm].push(sampleOnce(nm));
  }
}
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const T = Object.fromEntries(NAMES.map((n) => [n, { p50: Math.round(pct(samples[n], 0.5)), p90: Math.round(pct(samples[n], 0.9)) }]));
const l4Over = T.L4.p50 - T.direct.p50;
const parseRoute = T.L7parse.p50 - T.L4.p50;
const rebuildCost = T.L7full.p50 - T.L7parse.p50;
const l7Over = T.L7full.p50 - T.L4.p50;
const ratio = Math.round((T.L7full.p50 / T.L4.p50) * 10) / 10;

// ---------- report ----------
const k = res.keepalive, m = res.many, x = res.mixed;
const rulePct = (t) => Math.round((1000 * t.imagesOnB) / t.imagesTotal) / 10;
const busiest = (t) => Math.round((1000 * Math.max(t.A, t.B)) / (t.A + t.B)) / 10;

console.log('test                         L4 (A/B)      L7 (A/B)');
console.log(`1 kept-open connection       ${k.L4.A}/${k.L4.B}`.padEnd(43) + `${k.L7.A}/${k.L7.B}`);
console.log(`${CFG.manyConnections} new connections           ${m.L4.A}/${m.L4.B}`.padEnd(43) + `${m.L7.A}/${m.L7.B}`);
console.log(`mixed /api + /images          ${x.L4.A}/${x.L4.B}`.padEnd(43) + `${x.L7.A}/${x.L7.B}`);
console.log(`/images rule followed        ${rulePct(x.L4)}%`.padEnd(43) + `${rulePct(x.L7)}%   (${x.L7.imagesTotal} image requests)`);
console.log(`routing decisions (test 1)   ${k.L4.decisions}`.padEnd(43) + `${k.L7.decisions}`);
console.log('');
console.log(`measured processing time per request, in-process, ${CFG.sampleRounds} samples of ${CFG.benchRequests} requests (median / p90 of samples, ns)`);
for (const n of NAMES) console.log(`  ${n.padEnd(9)} ${String(T[n].p50).padStart(7)} / ${T[n].p90}`);
console.log(`  L4 over direct (copy + lookup)        ${l4Over} ns`);
console.log(`  L7 over L4, total proxy overhead      ${l7Over} ns  = parse + route ${parseRoute} ns + rebuild ${rebuildCost} ns`);
console.log(`run time                     ${Math.round(performance.now() - t0)} ms`);

const sign = (v) => (v >= 0 ? 'more' : 'less');
const out = {
  metrics: [
    { name: 'L4 one kept-open connection: requests to busiest backend', value: busiest(k.L4), unit: '%' },
    { name: 'L7 one kept-open connection: requests to busiest backend', value: busiest(k.L7), unit: '%' },
    { name: 'L4 50 new connections: requests to busiest backend', value: busiest(m.L4), unit: '%' },
    { name: 'L7 50 new connections: requests to busiest backend', value: busiest(m.L7), unit: '%' },
    { name: 'L4 routing decisions for 1,000 requests on 1 connection', value: k.L4.decisions, unit: 'decisions' },
    { name: 'L7 routing decisions for 1,000 requests on 1 connection', value: k.L7.decisions, unit: 'decisions' },
    { name: 'L4 /images requests sent to B (rule)', value: rulePct(x.L4), unit: '%' },
    { name: 'L7 /images requests sent to B (rule)', value: rulePct(x.L7), unit: '%' },
    { name: 'Measured processing time per request, direct to backend (median)', value: T.direct.p50, unit: 'ns' },
    { name: 'Measured processing time per request, through L4 (median)', value: T.L4.p50, unit: 'ns' },
    { name: 'Measured processing time per request, through L7 full (median)', value: T.L7full.p50, unit: 'ns' },
    { name: 'Measured processing time per request, through L7 full (p90 of samples)', value: T.L7full.p90, unit: 'ns' },
    { name: 'L7 total proxy overhead over L4 (median difference)', value: l7Over, unit: 'ns' },
    { name: 'of which: parse + route (L7 parse-only minus L4)', value: parseRoute, unit: 'ns' },
    { name: 'of which: rebuild upstream request (L7 full minus L7 parse-only)', value: rebuildCost, unit: 'ns' },
    { name: 'L4 overhead over direct (copy + table lookup)', value: l4Over, unit: 'ns' },
  ],
  conclusion:
    `On one kept-open connection L4 sent ${busiest(k.L4)}% of 1,000 requests to one backend after a single decision while L7 made ${k.L7.decisions} decisions and split them ${k.L7.A}/${k.L7.B}, ` +
    `only L7 followed the /images rule (${rulePct(x.L7)}% vs ${rulePct(x.L4)}% by chance for L4), and in this in-process JavaScript measurement the full L7 path used ${Math.abs(l7Over)} ns ${sign(l7Over)} processing time per request than L4 at the median (${ratio}x; parse + route ${parseRoute} ns, rebuild ${rebuildCost} ns), which is in-process processing time on this machine, not network latency.`,
  setup:
    `In-process simulation, seed ${SEED}, Node ${process.version}, ${process.platform}/${process.arch}; 2 backends (A, B); routing tests of ${CFG.requestsPerTest} requests each: 1 kept-open connection, ${CFG.manyConnections} new connections, ` +
    `${CFG.manyConnections} connections with ${CFG.imagesShare * 100}% /images paths; real HTTP/1.1 bytes cut into ${CFG.segmentMin} to ${CFG.segmentMax} byte segments; ` +
    `L4 = hash of source ip:port once per connection, bytes copied unread; L7 = per-request parse, round robin, /images/* to B, request rebuilt with X-Forwarded-For; ` +
    `timing = ${CFG.warmupRounds} warmup + ${CFG.sampleRounds} timed interleaved samples per path of ${CFG.benchRequests} identical seeded requests, performance.now(), backend parse included in every path, no responses, no network, no TLS.`,
};
console.log('RESULT ' + JSON.stringify(out));
