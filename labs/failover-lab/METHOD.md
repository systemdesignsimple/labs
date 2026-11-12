# sd-11 lab: the main server dies at 3 a.m. Who takes over?

Topic: fail-over, active-passive vs active-active.

## Question

When the main server is killed mid-traffic, how many requests fail and for how long under
active-passive versus active-active?

## How to run

```
node simulate-failover.mjs
```

Node.js 22, standard library only. No npm packages, no network, no child processes, no files written.
The whole lab runs on a virtual clock inside one process, so it finishes in well under a second and
gives the same numbers every time.

## Plan (what this lab is, and what it is not)

The first plan for this lab used real HTTP servers, a real proxy and killing a real primary process.
To keep the lab safe to run anywhere (no network, no child processes), the plan is now:

- **An in-process discrete-event simulation.** One Node.js process holds a virtual clock and an event
  queue. The client, the proxy, both servers, the health checks and the kill are all events on that
  clock. Nothing listens on a port, nothing is spawned, nothing is written to disk.
- **"Killing the primary"** means flipping the simulated server to dead: its in-flight and queued
  requests fail as "reset", and later requests to it fail as "refused", the way a closed port would.
- **What it can show:** how detection settings, routing and spare capacity shape the number of failed
  requests, the length of the interruption and the latency after takeover.
- **What it cannot show:** real server failure, real TCP behavior (timeouts, half-open connections,
  RSTs), real proxy code, DNS or virtual IP switching. See Limits.

## What it simulates

- **Load:** a client sends a steady 50 requests per second for 30 seconds (one every 20 ms, plus 0 to 4 ms
  of seeded jitter). Every request is logged with send time, finish time, status and server.
- **Servers:** two servers, each handling 2 requests at once with a queue for the rest. Service time is
  8 ms plus a random exponential part (mean 22 ms). Each network hop is 1 ms.
- **The failure:** at the 10 second mark the primary is killed. Requests running or queued on it fail
  at once ("reset"). Later requests sent to it fail immediately because the port is closed ("refused").
- **Active-passive:** the proxy sends everything to the primary and checks its health every 1 second.
  After 3 failed checks in a row it switches all traffic to the standby. The standby was idle, so it
  starts "cold": its first 50 requests take up to 30 ms longer (fading to zero), standing in for empty
  caches and connection pools.
- **Active-active:** the proxy sends requests round-robin to both servers, which are both warm. As soon as
  one request to a server fails, the proxy drops that server. No retries, no health checks.
- Each mode runs 5 times with seeds 1100 to 1104 (the same seeds for both modes). Only the health check
  timing (where the 1 second checks fall relative to the kill) and the random service times change.

## What it measures

- **Failed requests** per run, split into reset (in flight on the dead server) and refused (sent to it after
  it died).
- **Outage gap:** from the first observed failure to the first successful completion of *any* request
  after it, including requests that were already in flight on the survivor. This is the time during which
  nobody got a successful answer. In active-active the survivor keeps answering throughout, so this gap is
  only the time until its next in-flight request finishes.
- **Recovery latency:** from the first observed failure to the first success of a request *sent after*
  that failure. This is how long a brand-new user waits before the system serves them again. It is a
  different number from the outage gap and is reported separately.
- **p95 latency** before the kill (1 s to 10 s), in the first second after takeover (from the first
  newly sent request that succeeds), and in steady state after the kill (15 s to 30 s). Reported for
  both modes.
- Every measurement above is reported as median, min and max over the 5 runs, both in the printed
  summary and in the `RESULT` line.

The last line printed is `RESULT {...}` with all those metrics, a one-sentence conclusion computed from
the numbers, and the setup.

## What it shows

- **Active-passive** has a real outage. Detection takes 3 checks, 1 second apart, and the first check
  can fall anywhere in the first second after the kill, so the gap is about 2 to 3 seconds (the worst case
  is interval x threshold = 3 s). At 50 requests per second that is roughly 100 to 150 failed requests.
  After the switch, the standby carries the same load the primary did, so steady p95 returns to about the
  old level, with a short bump while it warms up.
- **Active-active** loses only the requests that were already on the dead server plus the one that
  revealed the failure, usually a handful. The survivor keeps answering the whole time, so the outage
  gap and the recovery for new requests should both be milliseconds to tens of milliseconds. The cost shows up later:
  the survivor now carries double load, so its queue grows and p95 latency rises compared with before
  the kill.
- The trade-off: active-passive is simple and the standby has spare room, but you pay with seconds of
  errors. Active-active hides the failure almost completely, but each server must have enough headroom
  to absorb the other's traffic.

## Limits (be honest about these)

- This is a simulation of the shape of the effect, not a benchmark. The numbers are not production
  figures and do not come from real servers or a real network.
- The outage length in active-passive is set almost entirely by the detection settings (interval and
  threshold). Real systems also spend time on DNS or virtual IP switching, connection draining and
  process start-up, which this lab does not model.
- The "cold standby" penalty is an assumption chosen to make warm-up visible; real warm-up can be much
  smaller or much larger.
- The active-active proxy does not retry. A real proxy that retries failed requests on the survivor would
  lose even fewer, at the risk of sending some requests twice.
- No data is stored, so there is no replication lag, lost writes or split-brain (both sides thinking they
  are primary). Those are often the hardest part of fail-over and are not shown here.
- The killed server fails cleanly (port closed). Slow or half-dead servers that hang instead of refusing
  make detection slower and are not modeled.
