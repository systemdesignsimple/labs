# sd-10 lab · Two servers in a row are less reliable than one

## Question

If each server is up about 99% of the time, how often does a request succeed when it has to pass
through two servers in a row, and how often when either of two side-by-side servers can answer?

## How to run

```sh
node run.mjs
```

Node.js 22, standard library only. No network, no npm packages, no child processes. It finishes in a
few seconds and writes `run-result.json` next to itself (seed, request count, timestamps, every number).

## What it does

- Three simulated servers (`solo`, `A`, `B`) live inside one Node process. Each has its own chaos
  schedule from its own seed: up stretches of random length (mean 1980 ms), then a short outage
  (10 to 30 ms, mean 20 ms). That targets about 99% uptime; the lab measures the real uptime of each
  server from its schedule and prints it.
- A load generator sends 200,000 requests down each of three paths on a simulated clock (100 per second,
  same arrival times for every path):
  - **single**: the request needs `solo` to be up.
  - **sequence**: the request hits `A`, and `A` must call `B` 1 ms later. Both must be up.
  - **parallel**: the client tries `A`; if `A` refuses, it retries on `B` 5 ms later.
- Arrival times are generated first, then every outage schedule is built through the last arrival plus
  the largest delay any path adds (5 ms). Asking a server about a time outside that window throws, so no
  request can land in unsimulated "always up" time.
- It counts successes and failures per path and prints the measured success rate next to the formula,
  using each server's own measured uptime: `pSolo`, `pA * pB`, `1 - (1 - pA) * (1 - pB)`.

## What it shows

- All three servers target 99% uptime; the run prints each one's measured uptime (solo, A, B).
- One server alone succeeds about as often as it is up, near 99%.
- Two in a row succeed near 98% (`pA * pB`): roughly twice as many failed requests as one server.
- Two side by side succeed near 99.99%: only a handful of failures out of 200,000.

The last line is a `RESULT {...}` JSON line with the metrics, a one-sentence conclusion built from the
actual counts, and the setup.

## Limits (be honest in the video)

- This is a simulation. It shows the shape of the effect, not production numbers. Real servers do not
  fail independently: a shared database, network or bad deploy can take both "parallel" servers down
  together, which makes parallel much worse than the formula.
- Outages here are short and random. Real outages vary from milliseconds to hours, which changes how
  many requests each outage hits.
- Measured rates wobble around the formulas because of sample size. Parallel failures are rare, so a
  different seed can give noticeably more or fewer of them. Quote the measured numbers with the request
  count, not the exact formula values.
- The 5 ms retry delay only changes which moment of `B`'s schedule gets sampled. `B` might have gone down
  or come back up in those 5 ms; since `B` fails independently of `A` and its uptime does not drift, that
  shift does not by itself lower the expected success rate. Any gap between parallel and its formula here
  is sampling noise. The lab models no request deadline and no latency, so it does not show requests lost
  to timeouts; real clients with a tight deadline would lose some of those retries.
- The plan mentioned real local HTTP servers; the lab rules require an in-process simulation, so the
  "servers" are schedules of up and down time, not sockets.
