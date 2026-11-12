# AI #10 lab: the quote wasn't there

Episode: "AI gave me a source. I clicked it. The quote wasn't there." Topic: hallucination, grounding and citations.

## Question

If an answer cites a source, how often does the quoted text actually appear in that source, and does a simple quote-must-match check catch the ones that don't?

Scope note: the original plan was to check quotes against saved public documents. This lab does not do that. It uses a **wholly synthetic corpus** (short texts we wrote ourselves), so it tests the matching logic of a quote check, not verification against real cited public sources.

## How to run

```
node run.mjs
```

Node.js 22, standard library only. No npm packages, no network, no child processes. It runs in well under a second.
It writes only inside this folder: `corpus/*.txt` (the source files) and `results.json` (every answer, its score, and the metrics).
The last line printed is one `RESULT {...}` JSON line.

`quote-check.mjs` is the token-level verifier from the article (spans, numbers and operators compared as written, unknown operator runs such as "5!" or "===" reported as could not check, numeric context checked outside the match). Run `node quote-check.mjs`; every regression line must end in `false`. It is not used by `run.mjs`, so the lab numbers come from the four-step normalizer described below.

## What it does

1. **Corpus (synthetic).** Ten short doc-style texts (HTTP caching, DNS TTL, TCP handshake, token bucket, database index, health checks, retries and backoff, idempotency keys, CDN, queue visibility timeout) are written as local text files on each run. They are written in our own words for this lab and summarize public concepts. They are not saved public documents and are not copied from any vendor's docs.
2. **60 cited answers.** Each answer cites one file and gives a quote.
   - **30 grounded:** the quote is copied word for word from the cited file. One in three gets harmless copy noise (curly apostrophe, a line break, a double space), like real copy and paste does.
   - **30 ungrounded,** built to copy three known failure shapes:
     - 10 **wrong document:** a real sentence, pointed at a different file.
     - 10 **merged:** the first half of one sentence joined to the second half of another sentence from the same file.
     - 10 **paraphrase:** 7 rewordings with 1 to 4 swapped words, and 3 where one number is changed (for example 300 becomes 600).
3. **Verifier.** For every answer it opens the cited file, normalizes both texts (Unicode NFKC, lowercase, punctuation to spaces, collapsed whitespace), and checks for an exact match. Then it computes a fuzzy score: the best token overlap between the quote and any same-length window of the source.
4. **Strict vs loose.** It reports what passes at exact only, and at fuzzy thresholds 0.95, 0.9, 0.8 and 0.7.
5. **Speed.** After one warm-up pass, it times each check (open file, normalize, exact, fuzzy) and reports the median in milliseconds. These are warmed repeat reads of tiny, freshly written local files.

## What it shows

- **A link that opens proves nothing.** Every cited file exists, for good and bad answers alike.
- **Grounded quotes verify.** Exact match after normalization should pass all of them. Without normalization, the noisy ones fail, so normalizing is part of the check, not an extra.
- **Wrong document and merged quotes fail the exact check.** These are the easy catches.
- **Paraphrases are the weak spot.** A loose fuzzy threshold lets light rewordings through, and that includes quotes where a number was changed. One wrong number in a 15 word sentence still scores about 0.93. The strict check catches them; the loose check does not. That is the tradeoff: loose checking forgives copy noise you already fixed with normalization, and in exchange it accepts changed meaning.
- **High-overlap constructed quotes.** The lab counts how many constructed paraphrases share at least 80% of their words with a window of the source. This is token overlap only. It says nothing about how many would fool a person reading quickly; that would need a human evaluation.
- **It is cheap here.** The check is a few lines of code and takes a fraction of a millisecond per answer for warmed local checks on this small synthetic corpus. Fetching real pages, PDFs or long documents would cost far more.

Main point: a citation is a claim, not a proof. Check that the quoted text is really in the source, and check it strictly.

## Limits (please read)

- **This is a simulation, not a measurement.** The bad quotes are constructed to match known patterns. The numbers show the shape of the effect. They are **not** a hallucination rate for any AI model or product, and the lab makes no claim about any one product.
- The share of bad quotes (half of all answers) is chosen by us, not observed.
- The corpus is synthetic: we wrote it, so it is not a test of checking quotes against real cited public sources.
- No human evaluation was done. Nothing here measures what a reader would notice or miss.
- Timing is for warmed repeat reads of tiny local files, not network fetches or large documents.
- The corpus is small, short and clean. Real pages have navigation text, tables, PDFs and dynamic content, which make matching harder.
- The fuzzy score is a bag of words in a sliding window. It ignores word order and meaning. Real systems may use better matching, but the core issue stays: anything loose enough to forgive wording changes can also forgive a changed number.
- An exact match proves the words are in the source. It does not prove the source is right, or that the answer uses the quote correctly.
- Timing depends on the machine and is not exactly repeatable; everything else is fixed by seed 42.
