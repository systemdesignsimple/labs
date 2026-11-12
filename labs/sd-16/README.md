# sd-16 lab: Which server gets your request?

Load balancer algorithms under load: round robin, least connections and hashing by user ID.

## The question

When some requests take much longer than others, which algorithm keeps the slowest
user waits (p99) lowest across 4 servers: round robin, least connections or hashing by user ID?

## How to run

```sh
node run.mjs
```

Needs Node.js 22. No npm install, no network, no extra files besides `results.json`,
which it writes next to `run.mjs`. It finishes in about a second.

The last line printed is the machine-readable result:

```
RESULT {"metrics":[...],"conclusion":"...","setup":"..."}
```

The lines above it are a readable table of every run.

## What the simulation does

- **4 servers**, each able to work on **8 requests at a time**. Extra requests wait in that
  server's own first-in, first-out queue.
- **20,000 requests**, Poisson arrivals at a fixed average rate. The random seed is fixed (16),
  so every run gives the same numbers.
- **Mixed run:** each request is slow (400 ms) with probability 10%, otherwise it takes 20 ms.
  The arrival rate is chosen so the 32 slots would be 65% busy on average. Those are
  *targets*: the sampled stream has its own realized slow share and load, and the script
  measures and prints both (in the table, `results.json` and the RESULT line).
- **Control run:** the exact same arrivals (same rate, same arrival times, same users),
  but every request takes 20 ms. Only the service times change. Because the work per request
  drops, the control is much less loaded (its realized load is printed too). So the control
  answers "does the algorithm matter when requests all cost the same?" at the same traffic,
  not at equal load. It does not show what round robin and least connections do with equal
  20 ms requests at a high load like 65%.
- **2,000 users** with a skewed (Zipf, s = 1) traffic pattern: a few heavy users send a large
  part of the traffic, most users send very little.
- The exact same request stream (same arrival gaps, same users, same slow requests) goes
  through all three balancers:
  - **Round robin:** server 1, 2, 3, 4, 1, 2, ... no matter how busy each one is.
  - **Least connections:** the server with the fewest requests in flight plus waiting.
    Ties rotate so no server is favoured.
  - **Hash by user ID:** `FNV-1a("user-<id>") mod 4`. The same user always lands on the
    same server.

The simulation uses a simulated clock (a discrete-event simulation), not real timers, so
the results do not depend on how fast your machine is.

## What it records

For each balancer in each run:

- p50 and p99 latency (time from arrival to finish, including waiting in the queue)
- p99 of the fast 20 ms requests only, which shows how long quick requests get stuck
  behind slow ones
- peak queue depth on any server
- each server's share of requests and its offered load (work sent to it divided by what
  its 8 slots can do)

Everything is written to `results.json` for the on-screen chart.

## What we expect it to show

- **Control (all 20 ms):** round robin and least connections should come out almost the same.
  When every request costs the same, "next in line" is already fair. That is an honest point
  worth saying on screen.
- **Mixed:** least connections should give a clearly lower p99 than round robin. Round robin
  keeps handing new requests to a server that is already stuck on several 400 ms requests,
  so fast requests wait behind slow ones. Least connections sees that server is busy and
  sends work elsewhere.
- **Hash by user ID:** each user stays on one server (useful for caches and sessions), but the
  heavy users pile onto one or two servers. Those servers get more than their 25% share and
  the worst p99 of the three.

The `conclusion` in the RESULT line is built from the measured numbers, so if a result
comes out differently from this expectation, the sentence says what actually happened.
If two algorithms have the same p99 at the printed precision, the sentence calls them tied
instead of ranking one above the other.

## Limits (please read before quoting numbers)

- **This is a simulation, not production traffic.** It shows the shape of the effect, not
  real numbers for any real system. Label it as a simulation on screen.
- The control keeps traffic fixed, so it is also at lower load than the mixed run. Part of
  any gap between the two runs comes from that lower load, not only from equal request costs.
- The exact numbers depend on the settings: 65% target load, 8 slots per server, the 20/400 ms
  split, the 10% slow share and the user skew. Change any of them and the gaps grow or shrink.
  At very low load all three look the same; near 100% load all of them get bad.
- The balancer here sees server state instantly and perfectly. Real balancers often run as
  several copies, each with a partial or slightly stale view, which makes least connections
  less precise.
- No network delay, no retries, no timeouts, no health checks, no servers failing or
  restarting, no autoscaling.
- Hashing uses plain `mod 4`. Real systems often use consistent hashing or bounded-load
  hashing to limit hot spots and reshuffling. Those are not tested here.
- Which servers the heavy users land on depends on the hash and the seed. With a different
  seed or hash, the hot server could be hotter or cooler.
