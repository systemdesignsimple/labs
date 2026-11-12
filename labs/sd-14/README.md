# sd-14 lab: Why Netflix doesn't buffer in Kathmandu (CDN push vs pull)

## Question

When a viewer in Kathmandu presses play on a new episode, how much faster does the first chunk
arrive from a pull edge cache, a push edge cache, or the faraway origin server alone?

## How to run

```
node run.mjs
```

Node.js 22, no npm install, no network. It finishes in well under a second because it uses a
virtual clock instead of real sleeps.

## What kind of experiment this is

An earlier plan was to start small local servers and time real requests. This lab does not do
that. It is a **deterministic latency model**: every hop delay, server delay and miss overhead is a
configured number, and the latencies it prints are computed from those numbers on a virtual clock.
No request is sent and nothing is timed with a real clock. Run it twice and you get the same output.

## What it does

Three paths are modeled in one process:

- **Origin only.** Every chunk costs one long round trip, about 250 ms, a round figure for
  Kathmandu to US West taken from public ping tables. Simulated, not measured.
- **Pull edge.** A cache "inside Nepal" about 10 ms away. It starts empty. On a miss it fetches
  the chunk from the origin (about 240 ms more, plus 15 ms to look up and store it), then keeps it.
- **Push edge.** The same 10 ms cache, but all 20 chunks are copied in before anyone presses play.
  This is how Netflix's publicly documented Open Connect boxes are filled during quiet hours.

A viewer plays a new episode of 20 two-second chunks. The player keeps a tight buffer: it asks
for each next chunk 300 ms before it is needed. A chunk that arrives after its playback deadline
counts as a stall, and playback is pushed back by the lateness.

Each path gets 3 cold runs (fixed seeds 11, 22, 33). In each run a first viewer watches, then a
second viewer watches through the same edge. Every network hop has +/-10% jitter.

**Matched jitter.** For each run, one table of jitter factors is drawn up front, indexed by viewer,
chunk and hop (hop 0 = the viewer's own hop, hop 1 = edge to origin on a pull miss). All three paths
read the same cell, so chunk 7 of viewer 1 gets the same jitter on origin, pull and push, even
though a pull miss uses two hops and the others use one.

Body transfer time is the same 60 ms on every path, so bandwidth is not part of the difference.
What does differ between rows is:

- where the chunk is stored (edge in Nepal or origin in US West), which sets the hop delays;
- on a pull miss only, the extra edge-to-origin hop, a 15 ms lookup and store overhead, and a
  second 5 ms server delay (the origin server, then the edge server).

So the pull first-viewer gap is file location plus that miss cost, not file location alone.

## What it prints

1. A per-chunk table for run 1: modeled time to first byte, HIT or MISS, and STALL markers, with
   columns origin (viewer 1), pull (viewer 1), pull (viewer 2) and push (viewer 1). Viewer 1 on the
   pull edge misses every chunk because each one is new to the edge; the pull viewer 2 column next
   to it shows the hit on that same chunk. Read across a line to see "miss, then hit".
2. An averages table: first frame time, mean time to first byte, stalls, rebuffer time and hit
   rate for each path and viewer.
3. One final `RESULT {...}` line with the metrics, a one sentence conclusion and the setup.

## What to expect

- Origin only: every chunk pays the long round trip, the first frame is slow, and the tight buffer
  stalls often.
- Pull edge: the first viewer pays the origin trip plus a little extra on every chunk (all
  misses), so it is about as slow as the origin, even a bit slower. The second viewer gets about
  10 ms per chunk.
- Push edge: about 10 ms from the very first request, no misses, no stalls.

## Limits (please read)

- This is a deterministic model, not a measurement. It shows the shape of the effect of the
  configured cache placement, hop delays and miss overhead, not production numbers. All delays are
  made-up stand-ins chosen from public ballpark figures; nothing here was measured over a real
  Nepal link or a real Netflix server.
- Real players buffer far more than 300 ms, so real stalls are much rarer than in this lab. The
  tight buffer is there to make the difference visible.
- Real transfers over a long path are also slower because TCP ramps up per round trip. This lab
  keeps transfer time equal on purpose, so it understates the real gap if anything.
- Real CDNs mix both methods: they push popular titles and pull the long tail, because pushing
  every title to every box wastes storage. The lab does not model storage cost or popularity.
- Diagrams in the video based on this lab are conceptual, not Netflix's exact architecture.
