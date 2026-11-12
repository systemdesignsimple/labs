// sd-61 lab: Publisher/subscriber vs direct calls.
// Node.js 22 ESM, standard library only. Deterministic virtual-time simulation.
//
// One publisher receives 1,000 "order-placed" events, one every 5 ms.
// Direct mode: for each event the publisher calls every subscriber in turn and waits.
// Pub/sub mode: for each event the publisher appends it once to an in-memory topic,
// which puts a reference in one queue per subscriber. Each subscriber drains its own
// queue at its own speed.
//
// Time is simulated (a virtual clock in milliseconds), so the run is fast and repeatable.
// Both modes use the exact same pre-generated service times per subscriber per event.
//
// ASSUMED (inputs picked by hand, not measured): call round trip, subscriber work,
// topic publish cost (0.05 ms + 0.002 ms per subscriber queue), delivery hand-off.
// DERIVED (computed by the simulation from those inputs): queueing, publisher backlog,
// subscriber waits, backlogs and finish times. Publisher cost per event is an input
// in pub/sub mode and a sum of inputs in direct mode, so it illustrates the assumption;
// it is not a timed measurement.
//
// Backlog definition (same in both modes): the largest number of events that had been
// placed (arrival time) but not yet started by that party (publisher or subscriber).

const EVENTS = 1000;
const ARRIVAL_MS = 5;            // a new order every 5 ms (200 orders per second)
const CALL_RTT_MS = 0.3;         // network round trip for one direct call
const DELIVER_MS = 0.3;          // topic queue to subscriber hand-off
const FAST_BASE_MS = 1;          // fast subscriber work per event
const JITTER_MS = 1;             // + uniform 0..1 ms of seeded jitter
const SLOW_EXTRA_MS = 50;        // the slow subscriber's added delay
const PUBLISH_BASE_MS = 0.05;    // append the event to the topic once
const PUBLISH_PER_QUEUE_MS = 0.002; // push a reference into each subscriber queue
const SUB_COUNTS = [1, 3, 10];
const SEED = 61;

// Seeded PRNG (mulberry32) so results never change between runs.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
function pct(a, p) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

// Build subscribers and their per-event service times (shared by both modes).
function makeSubscribers(n, withSlow) {
  const rng = mulberry32(SEED * 1000 + n * 10 + (withSlow ? 1 : 0));
  const slowIndex = withSlow ? Math.floor(n / 2) : -1; // slow one sits mid-list
  const subs = [];
  for (let j = 0; j < n; j++) {
    const slow = j === slowIndex;
    const service = new Float64Array(EVENTS);
    for (let i = 0; i < EVENTS; i++) {
      service[i] = FAST_BASE_MS + rng() * JITTER_MS + (slow ? SLOW_EXTRA_MS : 0);
    }
    subs.push({ id: `sub-${j}`, slow, service });
  }
  return subs;
}

const arrival = (i) => i * ARRIVAL_MS;

// Max number of items that had arrived but not started, given monotonic arrive/start times.
function maxBacklog(arrive, start) {
  let p = 0, max = 0;
  for (let i = 0; i < arrive.length; i++) {
    while (p <= i && start[p] <= arrive[i]) p++;
    max = Math.max(max, i - p + 1);
  }
  return max;
}

function runDirect(subs) {
  let free = 0, busy = 0;
  const pubStart = [], arrive = [];
  const perSub = subs.map(() => ({ delays: [], received: 0, finish: 0, starts: [] }));
  for (let i = 0; i < EVENTS; i++) {
    const t0 = Math.max(arrival(i), free);
    arrive.push(arrival(i)); pubStart.push(t0);
    let t = t0;
    subs.forEach((s, j) => {
      perSub[j].starts.push(t);          // subscriber j starts event i when its call begins
      t += CALL_RTT_MS + s.service[i];   // publisher blocks on each call
      perSub[j].delays.push(t - arrival(i));
      perSub[j].received++;
      perSub[j].finish = t;
    });
    busy += t - t0;
    free = t;
  }
  for (const p of perSub) { p.backlog = maxBacklog(arrive, p.starts); delete p.starts; }
  return { pubPerEvent: busy / EVENTS, pubFinish: free, pubBacklog: maxBacklog(arrive, pubStart), perSub };
}

// A tiny in-memory topic: one log, one queue (array of event refs) per subscriber.
class Topic {
  constructor(subs) { this.log = []; this.queues = new Map(subs.map((s) => [s.id, []])); }
  publish(evt) {
    this.log.push(evt);
    for (const q of this.queues.values()) q.push(evt);
    return PUBLISH_BASE_MS + PUBLISH_PER_QUEUE_MS * this.queues.size;
  }
}

function runPubSub(subs) {
  const topic = new Topic(subs);
  let free = 0, busy = 0;
  const enq = [], arrive = [], pubStart = [];
  for (let i = 0; i < EVENTS; i++) {
    const t0 = Math.max(arrival(i), free);
    arrive.push(arrival(i)); pubStart.push(t0);
    const cost = topic.publish({ id: i, type: 'order-placed', at: arrival(i) });
    busy += cost; free = t0 + cost; enq.push(free);
  }
  const perSub = subs.map((s) => {
    const q = topic.queues.get(s.id);
    let subFree = 0;
    const delays = [], starts = [];
    for (const evt of q) {               // each subscriber drains its own queue
      const start = Math.max(enq[evt.id] + DELIVER_MS, subFree);
      const done = start + s.service[evt.id];
      starts.push(start); delays.push(done - evt.at); subFree = done;
    }
    return { delays, received: q.length, finish: subFree, backlog: maxBacklog(arrive, starts) };
  });
  return { pubPerEvent: busy / EVENTS, pubFinish: free, pubBacklog: maxBacklog(arrive, pubStart), perSub };
}

function summarize(subs, r) {
  const fastIdx = subs.map((s, j) => (s.slow ? -1 : j)).filter((j) => j >= 0);
  const slowIdx = subs.findIndex((s) => s.slow);
  const fastDelays = fastIdx.flatMap((j) => r.perSub[j].delays);
  return {
    pubPerEvent: r.pubPerEvent,
    pubFinish: r.pubFinish,
    pubBacklog: r.pubBacklog,
    fastAvg: fastIdx.length ? mean(fastDelays) : null,
    fastP99: fastIdx.length ? pct(fastDelays, 99) : null,
    fastAllReceived: fastIdx.every((j) => r.perSub[j].received === EVENTS),
    fastMaxBacklog: fastIdx.length ? Math.max(...fastIdx.map((j) => r.perSub[j].backlog)) : null,
    slowFinish: slowIdx >= 0 ? r.perSub[slowIdx].finish : null,
    slowBacklog: slowIdx >= 0 ? r.perSub[slowIdx].backlog : null,
  };
}

const results = {};
const fmt = (x) => (x === null ? '-' : round(x).toString());
console.log(`sd-61 pub/sub lab · ${EVENTS} events, one every ${ARRIVAL_MS} ms · seed ${SEED}\n`);
console.log('mode     subs slow  pub ms/event  pub finish ms  pub backlog  fast avg ms  fast p99 ms  fast got all  fast backlog  slow finish ms  slow backlog');
for (const withSlow of [false, true]) {
  for (const n of SUB_COUNTS) {
    const subs = makeSubscribers(n, withSlow);
    for (const [mode, fn] of [['direct', runDirect], ['pubsub', runPubSub]]) {
      const s = summarize(subs, fn(subs));
      results[`${mode}-${n}-${withSlow ? 'slow' : 'fast'}`] = s;
      console.log(
        [mode.padEnd(8), String(n).padStart(4), (withSlow ? 'yes' : 'no').padEnd(4),
          fmt(s.pubPerEvent).padStart(12), fmt(s.pubFinish).padStart(14), String(s.pubBacklog).padStart(11),
          fmt(s.fastAvg).padStart(11), fmt(s.fastP99).padStart(11),
          (s.fastAvg === null ? '-' : s.fastAllReceived ? 'yes' : 'NO').padStart(12),
          (s.fastMaxBacklog === null ? '-' : String(s.fastMaxBacklog)).padStart(12),
          fmt(s.slowFinish).padStart(15), (s.slowBacklog === null ? '-' : String(s.slowBacklog)).padStart(13),
        ].join('  '),
      );
    }
  }
}

const d1 = results['direct-1-fast'], d10 = results['direct-10-fast'];
const p1 = results['pubsub-1-fast'], p10 = results['pubsub-10-fast'];
const ds = results['direct-10-slow'], ps = results['pubsub-10-slow'];

const slowGap = ds.slowFinish - ps.slowFinish;
console.log('\nHonest catch: pub/sub does not shrink the slow subscriber\'s own work (same 50 ms extra per event in both modes).');
console.log(`Its last event finished at ${fmt(ds.slowFinish)} ms with direct calls and ${fmt(ps.slowFinish)} ms with pub/sub ` +
  `(${slowGap >= 0 ? `${fmt(slowGap)} ms earlier` : `${fmt(-slowGap)} ms later`} with pub/sub).`);
console.log('With direct calls its work is serialized behind the other subscribers\' calls for every event; with pub/sub it overlaps');
console.log(`with them, so only its own demand limits it. It still falls behind: its queue reached ${ps.slowBacklog} events (direct: ${ds.slowBacklog} waiting events).`);
console.log('Assumed inputs: call RTT, work times, and pub/sub publish cost (0.05 ms + 0.002 ms per queue, so it grows a little with fan-out).');
console.log('Derived by the simulation: queueing, backlogs, waits and finish times. Not a real broker, not a timed measurement.\n');

const growthDirect = d10.pubPerEvent / d1.pubPerEvent;
const growthPub = p10.pubPerEvent / p1.pubPerEvent;
const conclusion =
  `Under the assumed costs, going from 1 to 10 subscribers raised direct publisher time per event ${round(growthDirect, 1)}x ` +
  `(${round(d1.pubPerEvent)} to ${round(d10.pubPerEvent)} ms) and the assumed pub/sub publish cost ${round(growthPub, 2)}x ` +
  `(${round(p1.pubPerEvent, 3)} to ${round(p10.pubPerEvent, 3)} ms, small but growing with fan-out); with one 50 ms subscriber ` +
  `the simulated fast subscribers waited ${round(ds.fastAvg)} ms on average with direct calls versus ${round(ps.fastAvg)} ms with pub/sub, ` +
  `and the slow subscriber kept its own work but overlapped it with the others, finishing at ${round(ps.slowFinish)} ms instead of ` +
  `${round(ds.slowFinish)} ms while its queue grew to ${ps.slowBacklog} events.`;

const metrics = [
  { name: 'direct publisher time per event, 1 subscriber', value: round(d1.pubPerEvent, 3), unit: 'ms' },
  { name: 'direct publisher time per event, 10 subscribers', value: round(d10.pubPerEvent, 3), unit: 'ms' },
  { name: 'pubsub publisher time per event, 1 subscriber (assumed cost)', value: round(p1.pubPerEvent, 3), unit: 'ms' },
  { name: 'pubsub publisher time per event, 10 subscribers (assumed cost)', value: round(p10.pubPerEvent, 3), unit: 'ms' },
  { name: 'direct publisher time per event, 10 subscribers with one slow', value: round(ds.pubPerEvent, 3), unit: 'ms' },
  { name: 'pubsub publisher time per event, 10 subscribers with one slow (assumed cost)', value: round(ps.pubPerEvent, 3), unit: 'ms' },
  { name: 'direct publisher max backlog, 10 subscribers with one slow', value: ds.pubBacklog, unit: 'events' },
  { name: 'pubsub publisher max backlog, 10 subscribers with one slow', value: ps.pubBacklog, unit: 'events' },
  { name: 'direct publisher finish time, 10 subscribers with one slow', value: round(ds.pubFinish), unit: 'ms' },
  { name: 'pubsub publisher finish time, 10 subscribers with one slow', value: round(ps.pubFinish), unit: 'ms' },
  { name: 'direct fast subscriber average wait, with one slow', value: round(ds.fastAvg), unit: 'ms' },
  { name: 'pubsub fast subscriber average wait, with one slow', value: round(ps.fastAvg), unit: 'ms' },
  { name: 'direct fast subscriber p99 wait, with one slow', value: round(ds.fastP99), unit: 'ms' },
  { name: 'pubsub fast subscriber p99 wait, with one slow', value: round(ps.fastP99), unit: 'ms' },
  { name: 'pubsub fast subscribers got every event', value: ps.fastAllReceived ? 1 : 0, unit: 'bool' },
  { name: 'direct slow subscriber max backlog (placed, not yet started)', value: ds.slowBacklog, unit: 'events' },
  { name: 'pubsub slow subscriber max queue backlog', value: ps.slowBacklog, unit: 'events' },
  { name: 'direct slow subscriber finish time', value: round(ds.slowFinish), unit: 'ms' },
  { name: 'pubsub slow subscriber finish time', value: round(ps.slowFinish), unit: 'ms' },
];

const setup =
  `virtual-time simulation (costs assumed, queueing derived), ${EVENTS} order-placed events arriving every ${ARRIVAL_MS} ms, subscribers ${SUB_COUNTS.join('/')}, ` +
  `fast work ${FAST_BASE_MS}-${FAST_BASE_MS + JITTER_MS} ms, one slow subscriber +${SLOW_EXTRA_MS} ms, direct call RTT ${CALL_RTT_MS} ms, ` +
  `topic publish ${PUBLISH_BASE_MS} ms + ${PUBLISH_PER_QUEUE_MS} ms per queue, delivery ${DELIVER_MS} ms, seed ${SEED}`;

console.log('RESULT ' + JSON.stringify({ metrics, conclusion, setup }));
