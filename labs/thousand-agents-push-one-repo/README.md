# Lab: many writers, one ref store, compare-and-swap

Used by the article `blog/src/content/posts/thousand-agents-push-one-repo.md`.

## Question

How much does sharing one ref cost compared with one ref per writer, and what does serializing every update cost?

## How to run

```sh
python3 -I ref_cas_lab.py
```

Python 3.11 or later, standard library only, no network, no files written. Finishes in about 15 seconds.

## What it does

An in-process ref store with an assumed 10 ms round trip (asyncio sleeps). Each agent reads its ref, attempts a CAS with the value it read, and retries on rejection. Three cases:

| Case | Agents | Refs |
| --- | ---: | --- |
| Separate refs, parallel | 1,000 | one each |
| Separate refs, serialized | 1,000 | one each, one CAS at a time (lock) |
| Shared ref | 100 | all on `main` |

There is no round barrier in the code. The shared-ref case still lands on 4,950 rejections because every remaining agent reads after the same 10 ms sleep and so sees the same version; the triangular formula n(n+1)/2 assumes those synchronized rounds.

## Recorded runs

See `results.md`. Operation counts are deterministic for this code; elapsed times depend on the machine and event-loop scheduling.

These numbers measure the simulation and its assumed delays, not Git, storage, networking or consensus.
