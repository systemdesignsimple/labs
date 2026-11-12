# sd-9 lab: 99.9% sounds perfect. It is 8 hours down a year.

## Question

If a service is up for 99.9% of the time, how much downtime is that over a year?
And what happens when one request has to pass through three such services?

## How to run

```
node run.mjs
```

Needs Node.js 22. No npm packages, no network, no child processes, no files written.
The run uses a virtual clock, so it finishes in well under a second. The last line it
prints is a single `RESULT {...}` JSON line with the metrics.

## What it does

This is an in-process simulation. There are no HTTP servers, no real processes being
stopped, and no real health-check code. Everything below is plain functions and a
virtual clock inside one Node process.

- Three simulated services live in the same process: A calls B, B calls C. Each hop
  adds 1 to 3 ms of simulated time.
- Each service has an outage schedule: random, non-overlapping windows of 100 to 400 ms
  during which it counts as down. The windows add up to a fixed share of the run: 1%,
  0.1% or 0.01%. Every window, including the last one, stays inside 100 to 400 ms: a
  short leftover at the end is merged into the window before it, or, if that would make
  it too long, the two are split into equal halves. Each service gets its own seed, so
  outages on A, B and C are independent and only rarely overlap.
- A simulated probe runs every 50 ms of virtual time. It asks A, B and C on their own
  "are you inside an outage window right now?", and sends one simulated request through
  the A to B to C chain. A run is 20 simulated minutes, which is 24,000 probes per target.
- It counts failed probes and turns that into a simulated availability (share of probes
  that passed). It then makes an annualized estimate: downtime per year = failure ratio
  x 8,760 hours.
- It repeats the run for the 99%, 99.9% and 99.99% budgets so the three can be shown
  next to each other.
- The "single service" numbers in the RESULT line are the mean of A, B and C. The
  per-service values are printed above the RESULT line.

## What it shows

All of these are simulated probe ratios and annualized estimates, not measurements of a
real system.

- 99.9% is not "almost never down". Scaled to a year it is around 8 to 9 hours.
- 99% is around 3.65 days a year. 99.99% is around 53 minutes.
- A chain of three 99.9% services lands near 99.7% (0.999 x 0.999 x 0.999 is about
  0.997), so roughly 26 hours a year. Each extra service in the path adds its own
  downtime. When two outages happen at the same moment, the chain loses less, so the
  chain can come in slightly better than the simple product.

## Limits (please read before quoting numbers)

- This is a compressed-time, in-process simulation on one Mac, not a production
  measurement. It shows the shape of the effect, not real numbers for any real system.
- It cannot test real probing or real operational availability. There are no HTTP
  servers, no crashed or stopped processes, and no real health checks. A probe is simply
  "is the virtual clock inside an outage window". There are no slow responses, timeouts,
  retries, partial failures or load.
- The year figure assumes the simulated failure ratio is representative of a full year.
  It does not predict when outages happen. Real outages are bursty: one bad 8 hour
  outage and many tiny blips both work out to 99.9%, but feel very different.
- Outages here are independent. Real services often fail together (shared database,
  shared network, bad deploy), which changes the chain result in either direction.
- The 99.99% run only has about 120 ms of downtime per service, so only two or three
  probes fail. Its number is the noisiest of the three and should be labeled that way
  on screen.
- Fixed seeds make the output repeatable. A different seed will give slightly different
  numbers around the same values.
