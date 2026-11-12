// bulkhead.mjs: per-feature concurrency limits, a total deadline and an execution timeout, Node 22, no packages
class Bulkhead {
  constructor(name, maxActive, maxQueue) {
    Object.assign(this, { name, maxActive, maxQueue, active: 0, queue: [] });
  }
  async run(work, { deadlineMs, execTimeoutMs }) {
    const deadline = Date.now() + deadlineMs;                         // total budget starts at enqueue
    if (this.active < this.maxActive) this.active++;                  // free slot: take it
    else if (this.queue.length < this.maxQueue) {
      await new Promise((resolve, reject) => {                        // wait, but never past the deadline
        const entry = { resolve, timer: setTimeout(() => {
          this.queue.splice(this.queue.indexOf(entry), 1);
          reject(new Error(`${this.name}: deadline passed while queued`));
        }, deadlineMs) };
        this.queue.push(entry);
      });                                                             // resolved = the slot was handed to us
    } else throw new Error(`${this.name}: rejected, bulkhead full`);  // fail fast, hold nothing

    const ctrl = new AbortController();
    const budget = Math.max(0, Math.min(execTimeoutMs, deadline - Date.now()));
    const timer = setTimeout(() => ctrl.abort(), budget);             // abort only SIGNALS the work
    const settled = Promise.resolve().then(() => work(ctrl.signal)).finally(() => {
      clearTimeout(timer);                                            // the slot stays held until work settles
      const next = this.queue.shift();
      if (next) { clearTimeout(next.timer); next.resolve(); }         // hand the slot on
      else this.active--;                                             // or free it
    });
    let callerTimer;                                                  // the caller stops waiting at its deadline,
    const callerLimit = new Promise((_, reject) => {                  // even if the work ignores the abort
      callerTimer = setTimeout(() => reject(new Error(`${this.name}: caller deadline passed`)),
        Math.max(0, deadline - Date.now()));
    });
    try {
      return await Promise.race([settled, callerLimit]);
    } finally {
      clearTimeout(callerTimer);
    }
  }
}

// A downstream call that takes `ms`. A cooperative one stops when aborted; a stubborn one ignores the signal.
const call = (ms, cooperative) => (signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (cooperative) signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('timeout')); });
}).then((v) => { if (signal.aborted) throw new Error('finished after the timeout'); return v; });

async function trial(label, poolFor, execTimeoutMs, cooperative = true) {
  const tally = { checkout: { ok: 0, fail: 0 }, recs: { ok: 0, fail: 0 } };
  const jobs = [];
  for (let i = 0; i < 60; i++) {                                      // 60 requests, one every 5 ms
    const type = i % 3 === 0 ? 'checkout' : 'recs';                  // 1 checkout per 2 recs
    const ms = type === 'recs' ? 2000 : 20;                           // recs is broken: 2 s per call
    jobs.push(poolFor(type).run(call(ms, cooperative), { deadlineMs: 1000, execTimeoutMs })
      .then(() => tally[type].ok++, () => tally[type].fail++));
    await new Promise((r) => setTimeout(r, 5));
  }
  await Promise.all(jobs);
  console.log(label.padEnd(40), `checkout ${tally.checkout.ok} ok ${tally.checkout.fail} failed | ` +
    `recs ${tally.recs.ok} ok ${tally.recs.fail} failed`);
}

const shared = new Bulkhead('shared', 16, 4);
await trial('A shared 16, 1 s exec timeout', () => shared, 1000);

const shortTimeout = new Bulkhead('shared', 16, 4);
await trial('B shared 16, 100 ms exec timeout', () => shortTimeout, 100);

const stubborn = new Bulkhead('shared', 16, 4);
await trial('C as B, but recs ignores the abort', () => stubborn, 100, false);

const pools = { checkout: new Bulkhead('checkout', 4, 4), recs: new Bulkhead('recs', 12, 4) };
await trial('D per-feature 4 + 12, 1 s exec timeout', (type) => pools[type], 1000);
