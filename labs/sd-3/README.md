# sd #3 lab: Instagram on one napkin

## Question

How many home-feed requests per second can one **in-process feed handler** serve
on one core? How close does a napkin estimate get to that measured number? And
in a **simulated** FIFO queue in front of that handler, what happens to served
throughput and tail latency as offered load rises?

This lab does not measure an HTTP server. A real HTTP server would need the
network, and the lab rules forbid that. It measures the CPU cost of one
synchronous handler function, then simulates the queueing.

## How to run

```sh
node run.mjs
```

Needs Node.js 22. Standard library only: no npm packages, no network, no child
processes, no files written. It usually takes about 10–15 seconds. A hard
40-second budget is checked during data setup, measurement and simulation. If the
budget runs out, the script stops early and still prints one `RESULT {...}` line
that says it aborted. It always ends with exactly one `RESULT {...}` line.

## What it does

1. **Napkin estimate first.** Before measuring anything, the script writes down a
   guess: about 150 followee timelines at ~0.5 µs each, ~25 µs to serialize the
   JSON, rounded up to ~100 µs per request. That gives ~10,000 requests per
   second on one core.
2. **Synthetic store.** 10,000 users, 20 posts each, 150 follows each, all built
   in memory from a fixed seed.
3. **Feed handler.** For a user, it merges their followees' timelines with a
   small heap, takes the 20 newest posts, and serializes them to JSON (~3 KB). A
   startup check confirms it returns the correct 20 posts.
4. **Measure.** After a warmup, it calls the handler in a tight loop for 4
   seconds and counts requests per second. Then it times individual requests to
   get the spread of the per-request cost.
5. **Load sweep (simulated).** It models one single-threaded handler with a FIFO
   queue. Seeded Poisson arrivals come in at 25% to 125% of the measured
   capacity, and each request costs a sample from the measured times. Each level
   runs a 5-second simulated window, capped at 300,000 arrivals; the window
   shortens if the cap would be hit. It reports:
   - **served req/s**: requests that arrived *and* finished inside the window;
   - **backlog**: requests that arrived in the window but were still queued or
     running when it ended;
   - **p50/p99 "all"**: latency of every arrival. After the window, the backlog
     drains with nothing dropped, so under overload this is the eventual wait;
   - **p99 in-window**: latency of only the requests counted as served.
   Under overload, the two latency figures differ a lot. The "in-window" figure
   leaves out the worst-hit requests, so it looks better than reality.
6. **Compare and size.** It prints measured ÷ napkin, then uses both numbers to
   size a **hypothetical** load: 100M daily users × 10 feed loads a day, peak 3×
   average, cores at 50% utilization. The answer is in **hypothetical
   handler-core equivalents**: how many cores of this exact in-process handler
   that load would need. It is not a count of real servers.
7. **Conclusion from the numbers.** The `RESULT` conclusion is chosen from the
   actual comparisons. Throughput counts as "flattened" if going from 110% to
   125% load adds less than 5% served throughput. p99 counts as "rose" if p99 at
   110% load is more than twice p99 at 50%. The conclusion also says whether the
   napkin guess was within 3× or missed by more. If a run does not show an
   effect, the conclusion says so.

## What it is expected to show (hypotheses, checked by the run)

- **Hypothesis:** the napkin number lands within a small factor (≤3×) of the
  measured one, not orders of magnitude away. The run reports the actual factor.
  The conclusion says so if the miss is bigger.
- **Hypothesis:** below saturation, latency stays near the cost of one request.
  Near and above 100% load, served throughput stops rising, while backlog and
  p99 climb because the queue keeps growing. Queueing theory predicts this
  shape. The simulation checks it for this service-time distribution.
- With a measured per-core number, "how many handler cores?" becomes one
  division.

## Limits (read before quoting numbers)

- These numbers come from **one laptop core, in-process, with synthetic data**.
  There is no HTTP parsing, network, TLS, disk, database, cache miss or
  cross-machine fan-out. A real server does far less per core than this.
- The load sweep is a **queueing simulation** that uses measured handler costs.
  It is not real concurrent load, and it ignores GC pauses under load and the
  extra cores a real machine has. A simulation shows the shape of the effect,
  not production numbers.
- The "all" latency assumes an unbounded queue that drains after the window,
  with no timeouts and no dropped requests. Real systems shed or time out work
  under overload.
- Seeds fix the data, the request stream and the arrivals. CPU speed, thermal
  state and Node version still change the measured numbers from run to run and
  from machine to machine.
- The 100M-user load is a made-up example used to show the sizing method. It is
  **not** Instagram's real traffic. The handler-core equivalents say nothing
  about Instagram's actual capacity, server count or architecture.
