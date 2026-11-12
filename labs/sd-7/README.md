# sd-7 lab: The cable to Asia breaks. Your bank must choose.

Topic: CAP theorem, consistency (CP) vs availability (AP).

## Question

When the link between two bank replicas breaks, what does choosing consistency (CP) cost compared with choosing availability (AP), counted in refused requests and wrong balances? And for AP, how much does the repair policy matter?

## How to run

```
node run.mjs
```

Node.js 22, standard library only. No network, no npm packages, no child processes, no files written. The clock is simulated, so the whole 60 simulated seconds run in well under a second, and the same seed gives the same numbers every time.

## What it does

- One shared account balance (start: 1000) is copied on two replicas, **Europe** and **Asia**.
- A seeded client sends a fixed stream of requests, about 20 per second for 60 seconds, split evenly between the two sides: 50% balance reads, 25% deposits, 25% withdrawals (5 to 25 each).
- From second 20 to second 40 the link between the replicas is cut, then repaired.
- At second 30, inside the cut, one scripted moment: a customer at each side asks to withdraw a fixed 700. This is the "two ATMs, one account" case.
- **Identical workload.** Every request, side, time and amount (including the two 700 withdrawals) is decided before any mode runs. Every mode gets the exact same requests; only the accept or refuse decisions differ. The run prints the requested withdrawal total per mode so you can check.
- **What each replica knows.** Each replica keeps only its own balance, the time of its last write, and its own log of the operations it has accepted. While the link is up, every accepted operation is copied to the other side at once. During the cut nothing crosses.
- The stream runs three times:
  - **CP.** A small third vote (a witness) sits in Europe, so Europe holds the majority (2 of 3) and keeps serving. Asia cannot reach the majority, so it refuses every request, reads included, because it cannot prove its copy is current. On repair, the two replica logs are combined and replayed, so Asia picks up what Europe accepted.
  - **AP-merge.** Both sides keep answering from their own copy. On repair, the two replica logs are combined by operation id, sorted by timestamp, and replayed from the start balance.
  - **AP-LWW.** Both sides keep answering from their own copy. On repair, plain last-writer-wins: the replica whose last write is later keeps its balance, and the other replica's balance is overwritten. The overwritten side's cut-time writes are gone. Traffic then continues on the repaired state, so the effect after repair is measured, not guessed.

## How it measures

- **Accepted-operation ledger (oracle only).** The lab separately records every operation any replica accepted, in time order. No replica reads it and no repair step uses it. It is only the yardstick: money that was really handed out or taken in.
- A read is **stale** if the balance a replica shows differs from that ledger at that moment.
- **Withdrawals accepted while the ledger lacked funds:** the replica said yes, but the ledger of everything accepted so far did not hold that much money.
- **Serial reference bank:** a separate bank with one copy and no cut runs the same request stream in time order and makes its own accept or refuse decisions. The lab counts withdrawals a mode accepted that this bank refused.
- **Balance error after repair:** the repaired balance minus the ledger. After AP-LWW, every read that differs from the ledger is counted too.

## What it shows

Printed per mode and per phase (before, during, after the cut): requests, served, refused, stale reads, normal "not enough money" declines, ledger-overdrawn withdrawals, and withdrawals the serial bank refused. Then what each side showed at repair, how the repair went, and the end balances. The last line is a `RESULT {...}` JSON with the headline metrics.

Expected shape (the run reports what it measures, not these guesses):

- Before the cut, every mode looks the same: nothing refused, nothing wrong.
- During the cut, CP refuses about half the traffic (everything that lands on Asia) and shows zero stale reads.
- During the cut, AP serves 100% of traffic, but Asia's reads miss Europe's writes and the other way round, and both 700 withdrawals are accepted, so the ledger goes below zero. Nobody sees that until repair.
- After repair, AP-merge's balance matches the ledger (still negative, the overdraft is real). AP-LWW drops one side's cut-time writes, so its balance stays wrong for the rest of the run and every later read is off.
- Variant to try by hand: if neither side had the majority (no witness), CP would have to refuse every write on both sides during the cut.

## Limits

- This is a simulation. It shows the shape of the tradeoff, not production numbers. Real counts depend on traffic, cut length, and the workload you choose.
- It is a simplified two-replica model with one account. It is not how any real bank works. Real banks add things like holds, overdraft limits, reconciliation teams, and per-account routing.
- Replication is instant while the link is up, so there is no normal replication lag here. Real systems have some even without a cut.
- Clocks are perfect. Real last-writer-wins also suffers from clock skew between sites, which this lab does not model.
- The workload is fixed, not adaptive: customers do not change what they ask for based on the balance they see. Real customers do.
- The scripted 700 withdrawals are there on purpose to make the conflict visible. Without them, unsafe withdrawals only happen when the random balance gets low.
- "CP refuses about half" holds only because traffic is split 50/50 and the majority is on one side. Change either and the share changes.
