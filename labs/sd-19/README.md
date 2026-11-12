# sd-19 lab: Why Amazon split one app into thousands

## Question

When one feature goes bad, does splitting the app into separate services keep checkout working, and what does the split cost on a normal day?

## How to run

```
node run.mjs
```

Node.js 22, no npm packages, no network, no child processes, no files written. It runs on a virtual clock, so the 8 simulated runs (4 scenarios x 2 designs, 20 simulated seconds each) finish in well under a second of real time. The seed is fixed, so every run prints the same numbers.

The last line is a single `RESULT {...}` JSON line with the metrics, a one-sentence conclusion and the setup.

## What it simulates

A toy shop with three features: **checkout**, **search** and **recommendations (recs)**. Both designs get exactly the same traffic (200 requests per second, 20% checkout, 40% search, 40% recs, same random stream).

- **Monolith:** one process with one shared pool of 16 workers that serves all three features.
- **Split:** three small services (checkout 4 workers, search 6, recs 6, so the same 16 in total) behind a gateway. Every request pays a simulated network hop each way (0.8 to 1.6 ms) plus 0.2 ms of gateway work.

Clients give up after 1 s. A request that waited longer than that in a queue is dropped as an error.

Four scenarios, each run on both designs:

| Scenario | What happens to recs |
|---|---|
| baseline | Normal day, nothing breaks. Measures what the hop costs. |
| slow | From t = 2 s every recs call takes 2 s. |
| crash | From t = 2 s every recs call crashes its process after 50 ms; a crashed process takes 2 s to restart, then crashes again on the next recs call. |
| redeploy | At t = 8 s the recs feature is redeployed. Monolith: the whole app restarts (4 s). Split: only the recs service restarts (1.5 s). |

Service times: each call draws uniformly from 0.5x to 1.5x of a base time (checkout 20 ms, search 10 ms, recs 15 ms), and 3% of calls take 3x as long. With that tail the expected means are 21.2 / 10.6 / 15.9 ms.

**What is assumed and what is measured.** The network hop, gateway work, crash restart (2 s) and redeploy restart (4 s vs 1.5 s) durations are assumed inputs, not measurements. The lab does not measure real network overhead or real deployment time. What it records is the simulated effect of those assumed delays on checkout (requests after a 2 s warmup): p50 and p95 latency of successful orders, error rate, successful orders per second, and how many checkouts fail during the redeploy. Recs error rate is also printed so you can see the bad feature still fails in the split version.

If a scenario has no successful checkouts, its latency percentiles are unavailable. They print as `-` in the table and are left out of the RESULT metrics (the setup string names any omitted metric), instead of being reported as 0 ms.

## What it shows

- **Normal day:** the split version is a little slower, by roughly the size of the assumed hop (a few milliseconds of checkout p50). Splitting is not free.
- **Slow feature:** in the monolith, slow recs calls hold the shared workers, the queue backs up, and checkout requests time out. In the split version recs is just as broken, but checkout has its own workers and stays near its baseline.
- **Crash loop:** in the monolith every recs crash takes the whole process down, so checkout fails with it. In the split version only the recs service keeps dying.
- **Redeploy:** given the assumed restart times, restarting the monolith to ship one feature drops every checkout in that window. Redeploying the recs service drops no checkouts. The lab counts the failed checkouts; it does not measure how long a real deploy takes.

## Limits (please say this in the video)

- This is a simulation, not a benchmark. It shows the **shape** of the effect, not real numbers, and certainly not Amazon's figures.
- The network hop is a made-up delay, not a measured one. Real hops can be much bigger (TLS, serialization, cross-zone traffic) or smaller.
- Restart times (4 s vs 1.5 s) are assumptions fed into the model, not results.
- Checkout here does not call recs. If checkout waited on recs synchronously, splitting alone would not help; you would also need timeouts, fallbacks or circuit breakers.
- A monolith can get some of this isolation without splitting (separate worker pools per feature, bulkheads, timeouts). The lab compares the simplest version of each design.
- It leaves out the other costs of splitting: more things to deploy and monitor, harder debugging across services, and data that now lives in more than one place.
