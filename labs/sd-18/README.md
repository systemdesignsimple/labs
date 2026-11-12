# sd-18 lab: One giant server or a thousand small ones?

Topic: horizontal vs vertical scaling.

## Question

In a simple queueing model, how does one server with more cores compare with several
one-core servers behind a load balancer, and how much of the difference comes from the
costs we assume for each design rather than from the topology itself?

This is a queueing simulation. It does not measure real CPU work, real cores, an HTTP
server or your laptop. Every service time, lock hold, hop and contention penalty is a
number we chose, and the scaling curves follow from those numbers. The 8-core limit on
the big server is a setting (`maxVerticalCores`), not something the run detects.

## How to run

```sh
node run.mjs
```

Needs Node.js 22. No npm packages, no network, no child processes, no files written.
Fixed seeds, so it prints the same numbers every time. The last line is a single
`RESULT {...}` JSON line with the metrics, a one-sentence conclusion and the setup.

Run time: the script has a 50-second wall-clock deadline, checked before every load
step and every 65,536 events inside the event loop. If the deadline is hit, it stops and
prints a `RESULT` with `run_completed: 0` and no comparison. The actual run time still has
to be checked once on the target Node.js 22 machine; it prints `wall time` before the
`RESULT` line.

## What it simulates

Everything runs in one Node process as a discrete-event simulation in virtual time.
Each request needs about 5 ms of CPU (Erlang-2 random) plus one read from a shared
store. Arrivals are random (Poisson).

**Vertical baseline (one big server).** One instance with 1, 2, 4 or 8 cores sharing one
queue. The store is in the same process behind one mutex (0.4 ms hold), and a worker keeps
its core while it waits for the lock. Each extra core adds an assumed 3% CPU cost per request,
a stand-in for memory contention.

**Horizontal baseline (many small servers).** 1, 2, 4 or 8 one-core instances behind a
round-robin load balancer. Each request pays a 0.3 ms load balancer hop each way, a 0.25 ms
hop each way to a separate single-threaded store (0.15 ms per read, waited for without
holding a core), and 0.3 ms extra CPU to encode and decode. Each instance has its own queue.

These two baselines differ in more than topology: store design, blocking behaviour and the
contention penalty all favour one side or the other by construction. So the run adds:

**Contention sensitivity.** The 8-core big server again at 0%, 1.5%, 3% and 6% assumed
contention per extra core.

**Matched comparison.** Both sides use the same async single-threaded store (same 0.15 ms
cost, no core held while waiting), with no contention penalty, no hops and no serialize cost.
The only difference left is one shared queue for 8 cores versus 8 round-robin queues of one
core each. Any gap here comes from queueing, not from the store or the network.

## How sustainable throughput is measured

For each setup the offered rate starts at 20 req/s and rises 20% per step until a step is
not stable, then rises 2% per step from the last stable rate. Each step:

- Arrivals run for 4 seconds. The observation window is second 1 to second 4 (after warmup).
  The simulation then runs 0.4 s more, only so requests that arrived in the window can finish.
- It counts arrivals in the window (actual arrival rate), completions in the window
  (completions per second) and the number of accepted unfinished requests at the start and
  end of the window (backlog growth).
- A step is stable when there are no errors, the p95 latency of requests that arrived in
  the window is at most 200 ms (requests still unfinished count as over the limit), and the
  backlog grew by no more than the larger of the number of cores or 2% of window arrivals.

The reported sustained throughput is the measured completion rate at the highest stable step,
not the configured arrival rate. For the 8-core setups it also reports the backlog growth per
second at the first unstable step, which shows the queue starting to build.

## Failure test

Both 8-core baselines run for 10 seconds at 70% of the weaker one's sustained rate. At
4 seconds one instance is killed and takes 3 seconds to restart. No retries.

- Vertical: everything in flight fails, and every new request is refused until restart.
- Horizontal: the killed instance's in-flight requests fail. The load balancer keeps sending
  it traffic until two health checks (every 250 ms) fail, then routes around it, and adds it
  back once it passes a check again.

Metrics, kept separate on purpose:

- **In flight at kill**: every accepted request not yet finished, including requests
  travelling through the load balancer. **Lost at kill** is the share of those bound for the
  killed instance that had not yet left it with a reply.
- **Event-time windows** (100 ms, by when a request completes or fails, from the kill on):
  `majority_failed_windows` is the total time in windows where 50% or more of resolved
  requests failed. This is not a "full outage" count. `failures_end_after_kill` is the end of
  the last window with more than 1% failed, measured from the kill, so it has 100 ms resolution
  and is an upper bound on when failures stopped.
- **Arrival cohort** (100 ms, by when the failed request arrived): `cohort_failures_end_after_kill`
  is the end of the last arrival window with more than 1% of its requests failing, and
  `oldest_failed_arrival_before_kill` shows that requests that arrived before the kill can
  still fail at the kill.

## What to expect

Under these assumptions the big server's 8-core number should move noticeably across the
contention sweep, which tells you how much of the baseline gap is the 3% penalty we chose.
In the matched comparison the shared queue usually does at least as well as round-robin
queues, because no core sits idle while another has work waiting. The difference that does
not depend much on the cost assumptions is the kill test: one big server fails everything
until it restarts, while losing one of 8 small servers fails roughly its share of in-flight
work and a short burst until the health checks route around it. The run prints whatever it
finds; the conclusion line is built from the measured numbers.

## Limits (please read before quoting numbers)

- This is a simulation. It shows the shape of the effect under stated assumptions, not
  production numbers, and it is not a benchmark of any machine or cloud.
- All costs (5 ms CPU, 0.4 ms lock hold, 3% per extra core, hop and store times) are chosen
  by hand. Change them at the top of `run.mjs` and the results move with them.
- It cannot tell you where real vertical or horizontal scaling stops helping. Real limits
  come from memory bandwidth, NUMA, garbage collection, the largest machine on sale, the load
  balancer, the database, deploys, sessions and data consistency. None of that is modelled.
- The external store is one instance and never fails here; in a real system it is often the
  next bottleneck and a single point of failure of its own.
- No retries. With client retries the horizontal error count would be close to zero, and the
  vertical outage would turn into a burst of retry traffic at restart.
