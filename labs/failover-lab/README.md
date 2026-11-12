# failover-lab: active-passive vs active-active, measured

A server dies. In our one-machine simulation (median of 5 runs):

| Setup | Requests lost | Outage gap |
|---|---|---|
| Active-passive (spare waits, 3 missed 1 s health checks) | 111 | 2.2 s with no success |
| Active-active (dead server dropped after the first failed request) | 1 | none |

The survivor pays: p95 latency for successful requests went from 79.1 ms to 87.8 ms, so each server needs spare capacity.

## Run it

```sh
node --version   # Node 22 or newer
node simulate-failover.mjs     # under a second, standard library only
cat results.json # the numbers above come from this file
```

A simulation shows the shape of the trade-off, not production numbers.

How it works, settings and limits: [METHOD.md](METHOD.md). The simulation is seeded, so you should get exactly these numbers.

Full article: https://systemdesignsimple.com/main-server-dies-at-3am/

From System Design Simple, system design explained simply with our own labs.

License: MIT.
