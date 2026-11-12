# sd #20 lab: 500 services. How do they find each other?

## Question

When one of 500 service instances dies, how long do callers keep sending requests to it? How much do a registry's heartbeat and TTL settings shrink that window compared with a hardcoded address list, and what does a shorter TTL cost?

## How to run

```sh
node run.mjs
```

Node.js 22 or later. No npm packages, no network, no child processes, and no files written. It finishes in a few seconds.

## What it does

Everything runs inside one Node process on a virtual clock that moves in 10 ms ticks, with fixed seeds, so every run gives the same request counts.

- **500 instances** register with a small in-process registry at start.
- **20 callers** each send 100 requests per second (2,000 per second total), picking instances round robin from their own list.
- At **t = 20 s**, 50 instances (10 percent, same set in every setup) die. Dead instances stop heartbeating. Every request that still lands on one is counted as failed. There are no retries, so each stale route shows up as an error.
- The run lasts 60 virtual seconds, and three setups face the same workload:

| Setup | How callers get addresses |
| --- | --- |
| Hardcoded list | All 500 addresses, fixed. Nobody edits the config during the run. |
| Registry, 10 s TTL | Instances heartbeat every 2.5 s. The registry drops an instance it has not heard from in 10 s. Callers cache the answer for 3 s. |
| Registry, 2 s TTL | Instances heartbeat every 0.5 s. The registry drops an instance after 2 s of silence. Callers cache for 3 s. |

Heartbeats have a random starting phase and plus or minus 10 percent jitter.

**Same workload in every setup.** Caller start positions (the round robin pointer) and cache phases come from one seeded generator, made once and shared by all three setups. Heartbeat timing and the assumed round trip each use their own generator, so registry setup never shifts the caller sequence.

**Cache refresh on the virtual clock.** When a caller's cache expires, it sends a lookup. The registry answers with its view at that moment. The answer arrives after the assumed round trip, landing on the first 10 ms tick at or after it. Until then the caller keeps using its old list. Requests never wait for a refresh.

## What it shows

- **Failed requests per 5 s window** for each setup. The hardcoded list keeps failing at the same rate until the end of the run. The registry setups fail for a while and then drop to zero.
- **Stale window**: time from the crash to the last failed request. For a registry it should be at most TTL plus the caller cache time (about 13 s for the slow setting, about 5 s for the fast one). For the hardcoded list it is the whole rest of the run.
- **Heartbeat traffic**: messages per second the registry receives. The two registry setups change two things together: the TTL (10 s vs 2 s) and the heartbeat interval (2.5 s vs 0.5 s). The heartbeat traffic ratio comes from the 5 times shorter interval, not from the TTL. A short TTL needs frequent heartbeats so healthy instances are not dropped. These two configurations trade faster detection for more traffic; changing the TTL alone would not produce this exact ratio.
- **Lookup cost**, reported as separate parts:
  - Cached pick: measured CPU time, far below a microsecond.
  - Registry query: measured CPU time of one in-process lookup over 500 entries.
  - Registry round trip: **assumed**, not measured. It is drawn from a model (0.25 ms plus an exponential tail with a 0.5 ms mean).
  - Uncached lookup estimate: the measured CPU plus the assumed round trip. It is an estimate, not a measurement.

  Because refreshes run in the background, the round trip only delays when a caller sees the new list. At a sub-millisecond round trip and 10 ms ticks, that is one tick, tiny next to the TTL and the 3 s cache.

The last line is a single `RESULT {...}` JSON line with the metrics, a one sentence conclusion built from the numbers, and the setup.

## Limits

This is a simulation. It shows the shape of the effect, not production numbers.

- There is no real network. The registry round trip is an assumed number, not a measurement, and real networks add loss, timeouts and slow nodes. The lab cannot check what a real lookup costs over the network.
- Time moves in 10 ms ticks, so round trips shorter than a tick all count as one tick. A slow registry (hundreds of milliseconds) would make the stale window a little longer. This lab does not test that.
- Instances die cleanly and all at once. Real failures are often partial: a slow instance that still heartbeats, or a network split where the instance is fine but the registry cannot hear it.
- Callers do not retry or mark an address bad after a failure. Real clients usually do, which shortens the stale window further.
- The registry is one perfect in-process object. Real registries (Consul, etcd, Eureka, Kubernetes endpoints) are replicated, and their own replication and watch delays add to the window.
- The CPU timings for lookups depend on the machine and change slightly between runs. Request counts and stale windows do not.
