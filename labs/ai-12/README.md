# ai-12 lab: search a pile of photos without reading every caption

## Question

On a small, fixed, synthetic set of "photo embeddings", if we stop comparing the query against every
vector and use an HNSW vector index instead, how much less work and time does a search take, and how
often does it still find the same 10 best matches?

## How to run

```
node run.mjs
```

Node.js 22 or later. No npm packages, no network, no files written. The last line it prints is a single
`RESULT {...}` JSON line.

## The accepted experiment

This lab is a small standard-library simulation, and that is the whole experiment:

- 20,000 synthetic vectors of 64 numbers, grouped into 100 clusters. Each cluster really varies along only
  8 hidden directions plus a little noise, because real embeddings are clumpy rather than pure random noise.
- 200 timed query vectors from the same distribution, plus 20 untimed warmup queries.
- A teaching HNSW index (a layered "who is near whom" graph) written in plain JavaScript inside the script:
  M=12 links per node, up to 24 on the bottom layer, efConstruction=60.
- Fixed seeds and a fixed workload: the index always holds all 20,000 vectors, whatever the machine speed.

It is not the episode plan's 1,000,000 x 128-dim run with 1,000 queries and real CLIP embeddings, and it
does not use a production library. Those are not tested here.

## What it does

1. Generates the data and builds the HNSW index over all of it.
2. **Full scan**: compares each query with every stored vector and keeps the 10 closest. This is the exact answer.
3. **HNSW**: starts at the top of the graph, hops toward closer neighbours, and stops once nothing closer
   turns up. Repeated for efSearch = 10, 20, 40, 80, 160, 320 (how wide it looks before stopping).
4. Records, for the full scan and for every efSearch setting: average and p95 latency, distance evaluations
   per query, distinct vectors touched per query, and recall@10 (how many of the true 10 closest it found).
5. Picks the "chosen" setting: the lowest efSearch reaching recall@10 of 0.95, or the best one if none does
   (the RESULT says which).

## What to look for

- Compare distinct vectors touched per query: the full scan touches all 20,000; check how many HNSW touches.
- The expected trend is that raising efSearch raises recall and costs more work and time. Read the table
  to see whether this run shows that, and where recall levels off.
- The conclusion sentence is built from the measured numbers. If HNSW is not faster on your machine, it
  says so rather than claiming a speedup.
- The costs sit next to the gains: build time, the estimated link payload, and any missed true matches.

## How the numbers are counted

- **Distance evaluations per query** counts every distance computed, including the same vector evaluated
  again on a different graph layer. It is a work count, not a vector count.
- **Distinct vectors touched per query** counts each vector ID once per query. The "share of vectors"
  percentage uses this count.
- **Indexed vector data** is computed as 20,000 x 64 x 4 bytes (the float32 array that holds them).
- **HNSW link payload** is an estimate: number of stored links x 4 bytes, as if each link were an int32 id.
  Neither figure is measured JavaScript memory; the real heap use of the JS arrays is higher and is not reported.

## Run time

The whole run, from script start, has a 50-second deadline (the rule is under 60 seconds). The fixed workload
is sized to finish well inside it on a recent Mac, and the RESULT reports the total run time. Every stage
(data generation, index build, warmup, full scan, sweep) checks the deadline. If it is ever hit, the script
does not shrink the experiment or report partial numbers as a benchmark: it prints `INCOMPLETE`, a RESULT with
`run completed = 0` and no speed or recall claim, and exits with code 1.

## Limits (read before quoting numbers)

- **This is a simulation that shows the shape of the effect, not production numbers.**
- It says nothing about how the gap changes at 1,000,000 vectors or 128 dims; that was not run.
- The data is synthetic. Behaviour on real photo embeddings (recall at a given efSearch, speed) is untested.
- The HNSW is a compact teaching version in JavaScript. Production libraries (hnswlib, FAISS) were not run,
  so their performance is untested here.
- Latency depends on this machine, other running apps and JavaScript garbage collection. The data, graph,
  distance counts and recall repeat exactly across runs because seeds and workload are fixed; times do not.
