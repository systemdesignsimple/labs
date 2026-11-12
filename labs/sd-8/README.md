# sd-8 lab: why your like count can be wrong, but your balance never

## Question

On the same 3-replica setup, how often does a read return a stale value, what does
it cost to make sure it doesn't, and what actually stops a balance from going below
zero?

## How to run

```
node run.mjs
```

Node.js 22, no npm packages, no network, no files written. It finishes in well under
a second (the simulation runs on a virtual clock, not real timers). The last line is
`RESULT {...}` with the metrics, a one-sentence conclusion and the setup. `setup` is
the full configuration as JSON: every parameter, the derived per-run seeds, and what
each mode and each balance check does. Seeds are fixed, so every run prints the same
numbers.

## What it simulates

One leader and two followers hold the same value. Every write goes to the leader;
the leader forwards it to the followers, and each follower applies it after a random
lag of 0 to 200 ms. 2% of those forwarding messages are lost.

Three modes, same workload:

| Mode | Writes | Reads | Lost forwarding message |
|---|---|---|---|
| weak | acked as soon as the leader has it | one random replica | gone for good |
| eventual | acked as soon as the leader has it | one random replica | resent after 100 ms until it arrives |
| strong (quorum) | acked only when 2 of 3 replicas have it (W=2), followers apply in order | ask 2 replicas, keep the newest version (R=2) | resent after 100 ms |

W + R > N (2 + 2 > 3) means every read set overlaps every acked write set, so a
quorum read always sees every write that was acked to a client before the read
started. **That is the whole guarantee here, and it is narrower than
linearizability.** A quorum read can return a write the leader has but has not acked
yet; a later read that misses the leader can then return an older value. The lab
counts this as "went back".

Where the cost lands: replicas answer reads from their current state at once, so a
quorum read only waits for the slower of two round trips. The waiting for
replication is paid on the write ack (W=2). Read protocols that wait for
synchronization on the read path (read repair, commit-index reads, leader leases)
would shift cost onto reads; they are not modelled.

**Run 1, like counter.** 20 likes per second and 200 reads per second for 20
simulated seconds. A read is *stale* if it returns fewer likes than the writes
already acknowledged to clients when the read started; we record by how many. A read
*went back* if it returns fewer likes than some read that had already finished
before it started. We also record when the last follower update lands after writes
stop, and how many likes a follower is still missing at the end. A mode only gets a
convergence time if every follower really ends equal to the leader.

**Run 2, balance.** 300 accounts, each starting at 300, each hit by 6 withdrawals of
100 a few tens of ms apart. Rule: withdraw only if balance >= 100. An *overdraft* is
an approved withdrawal that takes the real balance below zero. This is two separate
experiments, each run in all three modes with the same withdrawal semantics:

- **client check:** the client reads the balance (1 replica, or 2 in strong), checks
  the rule, then sends a plain "minus 100".
- **leader check:** same read and client check, then the leader checks the rule again
  in one serial place and applies it atomically (an atomic conditional withdrawal).

This separates the two effects: the read mode changes how fresh the balance the
client sees is; the leader check decides whether two withdrawals can both pass on
the same balance.

## What it shows

- Weak and eventual reads are fast (about one round trip), but a large share of them
  are stale, usually by a few likes. Reads that land on the leader are never stale,
  which is why the stale share stays well below 100%.
- Eventual followers catch up within about the injected lag once writes stop. Weak
  followers can stay wrong forever, because lost messages are never resent, so weak
  gets no convergence time, only "last follower update".
- Quorum reads never miss an already-acked write. They cost a little more (the slower
  of two replicas); writes cost much more, because the ack waits for a follower.
  `strong_reads_went_back` shows they still are not linearizable.
- On balances, a fresh read is not enough. With the client check, strong can still
  approve overdrafts (`strong_overdrafts_client_check`): a quorum read only covers
  *acked* writes, and a withdrawal that the leader has applied but not yet acked is
  invisible to a read that misses the leader. Two requests can also read the same
  balance before either decrement lands. With the leader check, overdrafts are zero
  in every mode, weak included, by construction. The protection comes from the atomic
  conditional withdrawal, not from quorum reads. Compare `stopped at leader` across
  modes to see how often each read mode handed the client an out-of-date balance.

So a like count that is a few behind for a fraction of a second is a fine trade for
speed. A balance needs one place that checks and applies the rule atomically, and
real banks pair that with strongly consistent storage so the check itself runs on
correct data.

## Limits (read before quoting numbers)

- This is a simulation, not a measurement of any real database. It shows the shape
  of the effect, not production numbers. The percentages depend entirely on the
  chosen lag, loss rate, write rate and read rate, which are printed in `setup` and
  should be shown on screen next to any number.
- No real network, disks, CPU or clock skew. Lag is uniform random, loss is
  independent per message, the leader never fails and there is no leader election.
  In this lab the leader is always correct, which is why its atomic check works even
  in weak mode; with failover, a weak leader could lose acked writes.
- "Strong" here means W=2/R=2 quorums with freshness against acked writes, not
  linearizability.
- Weak and eventual followers apply increments in any order (fine for a counter or a
  plain decrement); strong followers apply in order.
- Real systems offer many points between these three modes (read-your-writes,
  session tokens, bounded staleness, leader leases). They are not modelled here.
