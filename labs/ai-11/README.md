# AI #11 lab: I searched "car". Why did it find "vehicle"?

Topic: embeddings.

## Question (revised plan)

On 42 sentences we wrote, how many of the relevant results for "car" does plain keyword
search find, compared with search using a **small count-based (PPMI) embedding model we
train in this script**? And does that toy embedding search also pull in wrong matches?

The earlier plan named the free all-MiniLM-L6-v2 model. The lab rules (no packages, no
network) mean it cannot run here, so the plan now studies the toy model only. **Every
claim and number below is about this toy model on this constructed data.** None of it
tells you how MiniLM or any real embedding model scores, ranks or fails.

## How to run

```
node run.mjs
```

Node.js 22, standard library only. No npm packages, no network, no child processes.
It runs in a few seconds and writes `results.json` next to this file. The last line it
prints is one `RESULT {...}` JSON line with the metrics.

## What it does

1. **Test set: 42 short sentences we wrote and labeled by hand before any search runs.**
   - 12 are about cars but never contain the letters "car" (vehicle, automobile, sedan,
     my Toyota, the engine would not start, gas station, windshield wipers ...).
   - 2 are about cars and say "car".
   - 8 are traps: they contain "car" but are not about cars (train car, car-pool karaoke,
     cardboard, Carl, cardigan, career, caramel, scar).
   - 20 are unrelated filler.
   Labeling is our judgment. For example we call "car-pool karaoke" a singing sentence, not
   a car sentence.
2. **Keyword search.** Exact word match on "car" (or "cars"), ranked with BM25. We also run
   a naive "contains the letters car" search to show how substring matching drags in
   cardboard, Carl and caramel.
3. **Toy embedding search.** Every sentence becomes a list of numbers (a vector). We compare
   the query vector for "car" with each sentence vector using cosine similarity and rank.
4. **Scores, same cutoff for every method (top 10).** For each method the run reports:
   - returned: how many results it gave in its top 10,
   - relevant hits among those,
   - precision of returned = hits / returned,
   - precision@10 = hits / 10,
   - recall@10 = hits / 14 (all relevant sentences).

   Exact keyword search returns only the few sentences that contain the word, fewer than
   10. Its "precision of returned" only looks at what it gave back, so it can look high.
   Precision@10 counts the empty slots as misses, which puts it on the same denominator as
   embedding search (which always fills all 10). Read both. Recall@10 uses the same
   denominator (14) for every method. Embedding recall in the top 14 is printed as an extra
   metric only.
5. **Training/test overlap check.** The run measures, for every test sentence, the best word
   overlap with any training sentence and counts exact and near copies (see below).
6. **Word similarity and a 2D PCA map.** Cosine of "car" with vehicle, cardboard and others,
   and a PCA map for the video.

## The embedding model

- It reads ~125 training sentences that we also wrote.
- A word's vector records which other words it shares sentences with (PPMI, a standard
  count-based method). "car" and "vehicle" end up close because both keep company with
  engine, road, garage, insurance. "cardboard" sits near box, tape, recycling.
- A sentence vector is the average of its word vectors.

This is the same core idea a real model builds on (meaning from the company a word keeps),
but tiny and transparent. Words the toy model never saw are ignored and listed in the
output.

## Training/test overlap (read this, it matters)

The training text is **not** independent of the test set. We wrote both, and on purpose:

- Several test sentences appear in the training text exactly or almost word for word
  (for example most filler lines, "She changed her career to become a teacher", "She
  knitted a wool cardigan", "The caramel sauce burned..." vs "...needs sugar and butter").
- We added training contexts aimed at the exact synonyms we test (vehicle, automobile,
  sedan, Toyota, windshield) and at the exact traps (train car, cardboard, Carl, karaoke,
  cardigan, career, caramel, scar).

The run prints how many test sentences are exact copies and how many share at least 60% of
their content words with one training sentence, and `results.json` lists the overlap per
sentence. So this is a **constructed demonstration** of how an embedding can rank synonyms
above keyword misses. It is not evidence that the toy model generalizes to sentences it
was not shaped for.

## What it shows

- Keyword search cannot find a car sentence that does not say "car". It also returns
  "train car" and "car-pool karaoke", and substring matching adds cardboard, Carl, caramel.
- Toy embedding search finds many of the vehicle, automobile and sedan sentences without
  the word ever appearing.
- Toy embedding search still makes mistakes. "train car" contains the word itself and the
  toy model also saw "car" in train contexts, so it can rank high. "gas station" shares
  "station" with trains. Indirect lines like "my Toyota" may score lower than expected.
- Scores are moderate, not near 1.0. Show the real numbers from the run.

## The 2D map

PCA is fit on the 42 **sentence** vectors. Because a sentence vector is an average of word
vectors, the word vectors live in the same space, so the run also pushes the words car,
vehicle, cardboard (and the other compared words) through the same PCA transform. In
`results.json`, `pca.points` are sentences, `pca.query` is the query, and `pca.wordPoints`
are the single words. The video can draw "vehicle" near "car" and "cardboard" far away
only if the printed 2D distances say so; use the actual run output.

## Limits (say these in the video)

- This is one toy PPMI model on our own 42 sentences, not a benchmark and not MiniLM.
- We wrote both the training text and the test text, with overlap and tailored contexts,
  so we shaped what the model could learn. A real model learns from billions of sentences
  we did not write, and its exact scores and mistakes will differ.
- The run shows the shape of the effect (keyword search misses synonyms, embedding search
  can catch them and also makes its own errors), not production numbers.
- The 2D PCA map throws away most of the information in the vectors, and it was fit on
  sentences, not words. The run prints how much variance it keeps. Treat it as a rough
  picture, not the truth.
- Everything is deterministic (fixed seed 11 for PCA), so every run gives the same numbers.
