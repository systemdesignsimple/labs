# sd-15 lab: load balancer vs reverse proxy

Episode: "The receptionist of the internet"

## Question

When 2,000 requests hit a small site, what changes if they go:

- **A** straight to one server,
- **B** through a load balancer that spreads them over 3 servers, or
- **C** through a reverse proxy that caches answers in front of one server?

## How to run

```
node run.mjs
```

Node.js 22, no npm install, no network. It finishes in well under a second and
writes `results.json` next to this file (the video reads its numbers from there).
The last line printed is a single `RESULT {...}` JSON line.

## What it simulates

Everything runs inside one Node process on a **virtual clock** (a small discrete
event simulation) with a fixed seed, so every run gives the same numbers.

- **Backend server:** fixed 20 ms of work per request, at most 4 requests at a
  time. Extra requests wait in a first-in, first-out queue.
- **Load generator:** 30 clients, each sends a request, waits for the answer,
  then sends the next, until the same 2,000 requests are done. The request list
  is generated once (seed 15): 80% ask for `/home`, the rest for unique
  `/article/<n>` pages. All three setups replay that exact list.
- **A, direct:** clients hit one server.
- **B, load balancer:** round-robin over 3 identical servers, plus 0.2 ms per
  extra hop. It only chooses a server; it does no work itself.
- **C, reverse proxy:** one server behind a proxy that caches each response for
  5 seconds, plus 0.2 ms per hop. Fresh cached answers never reach the server.
  There is no request coalescing, so at the very start the first wave of
  `/home` requests all miss at once (a small "cache stampede"); that count is
  reported as `C_hot_page_backend_fetches`.

For each setup it records total time, p50 and p95 latency, and how many
requests each backend actually received.

## What it shows

- **A** queues up: one server finishing 4 requests per 20 ms can do about 200
  per second, so 30 waiting clients pile up and latency grows well past 20 ms.
- **B** finishes in roughly a third of the time with each server getting about
  667 requests. Every request still costs the same 20 ms of work; the load
  balancer helps only by spreading the queue over more servers.
- **C** sends only about a fifth of the requests (plus the early stampede) to
  the server. Cache hits are answered by the proxy in well under a millisecond.
  The gain comes from answering on the server's behalf, not from adding servers.

## Limits (please read)

- This is a simulation, not a benchmark. It shows the **shape** of the effect,
  not production numbers. Present it in the video as "a local simulation".
- No real network, TCP, TLS, disks, CPU contention or garbage collection.
  Service time is fixed at exactly 20 ms; real servers vary.
- Load balancer is plain round-robin with no health checks; real ones also
  weigh by load, drain bad servers and keep sessions sticky.
- The cache result depends heavily on the 80% repeat rate. Personalised or
  rarely repeated pages would see little or no benefit.
- Real products often do both jobs (a reverse proxy that also load balances);
  the lab separates them only to show which effect comes from which job.
