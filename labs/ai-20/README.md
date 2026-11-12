# Lab AI #20: Can AI safely reuse an answer for a look-alike question?

Episode: "These 2 questions look alike. Can AI safely reuse the answer?" (topic: semantic caching)

## The question

If a cache reuses a stored AI answer whenever a new question is similar enough to an old one, how many model calls does it save, and how often does it hand someone the wrong answer?

**Scope: this lab studies a lexical cache simulation.** The lab rules allow only the Node.js standard library, so no neural embedding model (such as all-MiniLM-L6-v2) can run here. "Similar" in this lab means "shares words, word pieces, or a hand-listed synonym". The results show how a word-overlap cache behaves on these pairs. They do not show how a real embedding model scores them.

## How to run

```bash
node run.mjs
```

Needs Node.js 22. No packages, no network, no API keys. It finishes in a few seconds and prints a table, then one `RESULT {...}` line.

## What the lab does

1. **60 hand-labeled pairs.** In each pair, question A is already in the cache with its answer and question B is the new question.
   - 30 pairs are true paraphrases with the same answer ("How do I reset my password?" / "I forgot my password, what now?").
   - 30 pairs look alike but need a different answer ("Flights to Tokyo tomorrow" / "Flights to Tokyo today", "capital of Austria" / "capital of Australia", "enable" / "disable two-factor authentication").
2. **Turn each question into a lexical vector.** A bag of hashed words and character trigrams, plus a small hand-written synonym table. Word order is thrown away and stop words are dropped, including the direction words "to" and "from".
3. **Mark the order-only look-alikes.** The lab finds look-alike pairs whose two questions contain exactly the same words in a different order ("5 miles to kilometers" / "5 kilometers to miles", "Celsius to Fahrenheit" / "Fahrenheit to Celsius", "airport from my home" / "my home from the airport"). In a bag-of-words vector these get identical vectors **by construction**, so no threshold can separate them. Their wrong reuses are a limit of this lab's vector, not a finding about semantic caching, and the table counts them in their own column `(o)`.
4. **Cache lookup.** The cache holds the 60 A questions plus 10,000 synthetic filler rows. The filler rows are random unit vectors, not embedded questions. They exist only to give the lookup a 10,060-row scan to time. In 1024 dimensions they sit near zero similarity to every real question, so they should not compete as matches (the lab prints how many questions matched a filler row, so you can check). They do not represent how a real cache full of unrelated questions would behave.
5. **Threshold sweep from 0.70 to 0.98.** At each threshold the cache serves the stored answer when similarity is at or above the threshold. The lab counts:
   - **hits**: questions answered from the cache (model calls saved),
   - **wrong reuses**: hits where the served answer does not belong to the question, split into order-only pairs `(o)` and all other cases.
6. **Same sweep with guards** that careful setups add:
   - skip the cache for time-sensitive questions (today, tomorrow, tonight, now) and personal ones (my order, my home, near me),
   - a cheap check before reuse: numbers and named things (words with capitals, like Tokyo, iPhone, 2022) must match exactly.
7. **Timing.** Each lookup (build the lexical vector, then a plain linear scan of 10,060 rows) is timed on your machine. No model runs, so the model call is a **hypothetical 900 ms baseline** written into the code, used only to show what the comparison would look like. It is not a measurement and the lab makes no claim about real model latency.

## What it shows

Read the table top to bottom:

- At low thresholds the lexical cache answers many questions, and many of those answers are wrong. Look-alike questions share most of their words, so they score close to real paraphrases.
- At high thresholds wrong reuses drop, but so do hits. Some real paraphrases use different words and fall below the line.
- The order-only pairs stay wrong at every threshold, because their vectors are identical. Read the `other` column to see the wrong reuses that are not caused by this structural blind spot.
- The "dangerous ones" list shows look-alikes that score as high as, or higher than, real paraphrases. In this lexical setup similarity alone can't tell those apart, so no single threshold gives both many hits and zero wrong answers.
- The guards remove most of the dangerous cases, but not all: order-only pairs and pairs like "store open" vs "store close" have the same numbers and names, so the cheap check lets them through at lower thresholds.
- The measured lookup time shows how cheap a cache check is on this machine. How much that saves depends on what a real model call costs in your system, which this lab does not measure.

The takeaway, within this lexical simulation: similarity says two questions look alike, not that they have the same answer. Safe setups use a high threshold, keep time-sensitive and personal questions out of the cache, and run a cheap check before reusing an answer.

## Limits (please read)

- **This is a simulation, not a benchmark.** It shows the shape of the trade-off, not production numbers.
- **Lexical, not neural.** The planned neural embedding model can't run under the stdlib-only rules, so this lab does not measure one. A neural model will give different scores: it may rate paraphrases higher and may or may not separate near-misses like Austria/Australia, today/tomorrow, or reversed conversions. This lab did not test that, and its numbers should not be quoted as how embedding models behave.
- **Order is invisible to this vector.** Reversed conversions and reversed directions get identical vectors by construction. Neural models do see word order, so they may score these pairs differently. These cases are reported separately for that reason.
- **The synonym table was written by hand for these pairs**, so paraphrase scores here are partly our choice. The look-alike scores are not helped by it.
- **60 pairs written by us.** Real traffic has a different mix of repeats, paraphrases and near-misses, so real hit rates and error rates will differ.
- **The filler rows are synthetic scan workload** (random unit vectors), used only for timing. They are not realistic cache contents.
- **Model latency is a hypothetical baseline**, not measured. Only the cache lookup time is measured, and it depends on your machine and on a plain linear scan (real systems use a vector index).
- **The guards are simple rules** (keyword lists and a capital-letter check). They show the idea; real systems tune them to their own data or use a small model as the check.
- **Scoring is conservative.** If a new question matches any entry other than its own pair, it counts as wrong, even if that answer might happen to fit.

Fixed seed (20), fixed hashing, no randomness in the data, so every run gives the same table apart from the measured lookup time.
