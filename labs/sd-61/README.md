# sd-61 lab: Publisher/subscriber

## Question

When one app has to tell many other services that something happened, does sending each one a direct call cost more than publishing the event once to a topic?

## How to run

```sh
node run.mjs
```

Node.js 22, no packages, no network, no files written. It finishes in well under a second because time is simulated.

## What it does

One publisher gets 1,000 `order-placed` events, one every 5 ms. It runs them in two modes:

- **Direct:** for each event the publisher calls every subscriber in turn and waits for each reply (0.3 ms round trip + the subscriber's work).
- **Pub/sub:** for each event the publisher appends it once to an in-memory topic, which puts a reference into one queue per subscriber. Each subscriber drains its own queue at its own speed.

It runs 1, 3 and 10 subscribers, first with all of them fast (1 to 2 ms of work), then with one of them given an extra 50 ms. Both modes use the same seeded service times, so the comparison is fair and every run prints the same numbers.

For each run it prints:

- publisher time per event and when the publisher finished
- the publisher's own backlog
- how long fast subscribers waited from order placed to handled (average and p99), and whether they got all 1,000 events
- the largest backlog of any fast subscriber, and the slow subscriber's finish time and largest backlog

Backlog has one definition in both modes, for the publisher and for every subscriber: the largest number of events that had been placed but not yet started by that party. Every backlog is computed from simulated times, none is hard-coded.

The last line is a `RESULT {...}` JSON line with the key metrics.

## Assumed versus derived

- **Assumed (inputs picked by hand):** the 0.3 ms call round trip, subscriber work times, the 0.3 ms delivery hand-off, and the pub/sub publish cost of 0.05 ms + 0.002 ms per subscriber queue. So the pub/sub publisher cost is set by a formula, not measured. It is small but it grows with fan-out (about 35% more from 1 to 10 subscribers). The direct publisher cost is just the sum of the assumed call costs.
- **Derived (computed by the simulation):** what those costs lead to over time: publisher and subscriber backlogs, how long each subscriber waits, and when each one finishes.

The lab does not prove publishing is free of subscriber count. It shows what follows if publishing is cheap and calls are not.

## What it shows

- **Direct:** the publisher's time per event is the sum of every call, so it grows with every subscriber. With one 50 ms subscriber among 10, each event takes over 50 ms, longer than the 5 ms between orders. The publisher falls behind, and every fast subscriber ends up waiting seconds too.
- **Pub/sub:** under the assumed costs the publish step stays far below the 5 ms gap between orders even at 10 subscribers, so the publisher never builds a backlog. Fast subscribers keep a wait of a few milliseconds even when the slow one is there.
- **The catch:** pub/sub does not make the slow subscriber's work smaller. It still needs about 51 ms per event, far more than the 5 ms between orders, so it falls behind in both modes and its queue grows to hundreds of events. What changes is the waiting around it. With direct calls, every one of its events also waits behind the other nine subscribers' calls, so it finishes noticeably later (the lab prints both finish times and the gap). With pub/sub its work overlaps with the other subscribers, so only its own demand limits it. In a real system that backlog still needs limits, monitoring, and enough consumers to drain it.

## Limits

- This is a simulation on a virtual clock, not a real broker such as Kafka, RabbitMQ, SNS or Redis. It shows the shape of the effect, not production numbers.
- Cost numbers (round trip, publish cost, work time) are picked by hand to be realistic in proportion, not measured. Publisher time per event is an input, not a timed result.
- No failures, retries, ordering guarantees, persistence, acks or network loss are modelled. Real direct calls can run in parallel, which narrows the per-event gap but still ties the publisher to the slowest subscriber.
- The publisher's fan-out cost (0.002 ms per queue) is small but not zero. A real broker does that work for you on its own servers.
