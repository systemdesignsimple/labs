# sd-12 lab: One database writes, ten read

Topic: replication, master-slave (primary + read replicas) and master-master.

## Question

If one primary takes the writes and we add read replicas, how much more read traffic can the system serve, and how often does a user read old data right after writing? And what happens when two primaries both accept writes?

## How to run

```sh
node run.mjs
```

Node.js 22, standard library only. No npm install, no network, no files written. It finishes in a few seconds because time is simulated, not waited for. The last line printed is `RESULT {...}` with the metrics as JSON.

## What it does

Everything runs in one process on a virtual clock (a small discrete-event simulator). Random choices use a fixed seed, so every run prints the same numbers.

Each database node has one worker and a queue. A read takes 2 ms and a write takes 0.5 ms on that worker, so a node can only serve a limited number of queries per second. The primary also spends 0.01 ms per replica on each write to send the change out.

**Part 1, capacity.** One primary with 0, 1, 3 and 10 read replicas. 200 busy clients send a 90% read / 10% write mix with no pause. Writes go to the primary. Reads go round-robin to the replicas (with 0 replicas the primary serves reads too). We measure reads per second, writes per second and p95 read latency. A second run with write-only clients finds the write ceiling for each replica count.

**Part 2, stale reads.** Light traffic so queues stay short. Each user writes a new row, waits 20 to 1000 ms (like a page refresh), then reads the same row back from a replica. Changes reach each replica after a lag of 50 ms, then 500 ms (plus or minus 10%, in order). A read counts as stale when the replica does not have the row yet.

**Part 3, master-master.** Two primaries both accept writes to the same 100 keys (400 writes/s for 10 s) and copy them to each other after 50 ms, then 500 ms. Conflicts are resolved by last-write-wins on the timestamp. Each write remembers the version it was built on. At the end we follow that chain back from each key's final value: any acknowledged write that is not on the chain was silently overwritten. With a single primary that count is always zero, because every write builds on the one before it.

## What it shows

- Read throughput grows roughly in line with the number of replicas. The first replica mostly moves reads off the primary, so 1 replica is close to 0 replicas; 10 replicas give about 10x.
- The write ceiling does not go up with replicas. It goes down a little, because the primary has to ship every write to more copies.
- Stale read-backs depend on the lag, not on how many replicas there are. Low at 50 ms lag, clearly visible at 500 ms.
- Two primaries give you two places to write, but writes to the same key at nearly the same time collide, and last-write-wins drops one of them without telling anyone. The longer the lag, the more get lost. You need a conflict rule you actually chose (merge, version check, route each key to one primary).

## Limits

- This is a simulation on one laptop. It shows the shape of the effect, not production numbers. Real databases, disks, networks and replication protocols behave differently.
- The numbers follow directly from the chosen service times, lag, traffic mix and read-back gap. Change those and the numbers change; the trends should not.
- Replicas apply changes for free here. In real systems applying changes costs replica CPU and I/O, so read capacity grows a bit less than shown.
- Lag is a fixed value with small jitter. Real lag spikes under load, which makes stale reads worse.
- Clocks are perfect in Part 3. Real clock skew makes last-write-wins pick the wrong winner even more often.
- Failover, synchronous replication and quorum reads are not modeled.
