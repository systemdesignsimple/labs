# AI #4 lab: 100 pages, 1 question. How does AI find the one right line?

Topic: RAG, retrieve first, then generate.

## Question

When you ask one question about a 100-page document, how often does retrieval bring back the passage that holds the answer? Does the wording of the question matter? And how much less does the model have to read than the full 100 pages?

## How to run

```
node run.mjs
```

Needs Node.js 22. Standard library only: no npm install, no network, no files written. The seed is fixed (404), so every run prints the same numbers. It should finish in a second or two.

## What it does

1. **Builds a fake handbook.** It's an internal handbook for a made-up company: 10 sections, 100 pages of about 500 words each, roughly 50,000 words in all. The filler is policy-style sentences that keep reusing the same everyday words (badge, laptop, leave, review, visitor and so on), so many pages look alike.
2. **Plants 30 facts.** Each fact is one sentence on one known page, for example "Production database backups are kept for 35 days."
3. **Asks every fact twice (60 questions).**
   - **Same words:** the question reuses the answer's words ("How long are production database backups kept?").
   - **Paraphrased:** the same fact in different words ("How long do we hold on to copies of the main live data?").
   Because both versions ask about the same fact, the only difference between them is the wording. Results are reported as pairs.
4. **Chunks the document.** It cuts the text into pieces of about 300 words, always at a sentence boundary.
5. **Ranks the chunks for each question in two ways.**
   - **Keyword BM25:** the standard word-matching score that search engines use.
   - **Synonym TF-IDF:** each word is mapped to a shared id using a hand-written synonym list (bike = bicycle, reserve = book, and so on). Character trigrams are added, and the TF-IDF vectors are compared with cosine similarity. **This is not an embedding model** (see Limits).
6. **Measures the results.**
   - recall@1, @3 and @5 for each retriever and each wording: is the chunk with the answer in the top 1, 3 or 5?
   - Paired results at top 3 for each retriever: how many facts were found with both wordings, only with the same words, only with the paraphrase, or with neither.
   - Paraphrased recall@3, split into two sets (see below).
   - Tokens the model reads with top-3 retrieval, **for each retriever separately**, compared with reading the whole document. Tokens are estimated as characters / 4. The two retrievers can pick chunks of different lengths, so their averages can differ.

It prints tables, lists every miss (questions whose answer chunk was not in the top 3) along with the rank it actually got, and ends with a single `RESULT {...}` JSON line.

### The two paraphrase sets

- **tuning (facts 16 to 30):** the synonym list was written while looking at these paraphrases, so the synonym retriever does well on them by construction. They show what the method can do when its vocabulary fits.
- **later (facts 1 to 15):** these paraphrases were written after the synonym list was frozen, and no synonyms were added for them. They are a weaker but fairer check. The same person wrote both the list and the questions, so this set is not a truly independent test.

## What it shows

- Retrieval, not the model, decides what the model gets to see. If the right chunk is not in the top 3, the model never reads the answer.
- With the fact held fixed, keyword BM25 does well when the question repeats the document's words and worse when the same fact is paraphrased. The paired table shows this directly.
- A synonym list can recover paraphrases it was built for. The gap between the "tuning" and "later" sets shows how much of that depends on the list matching the questions.
- Top-3 retrieval cuts what the model reads from tens of thousands of tokens down to about a thousand. That is the core idea of RAG: retrieve a small slice, then generate an answer from it.

Quote the numbers the run prints, not these descriptions, and always name which retriever a number belongs to.

## Limits (read before quoting numbers)

- **This is a simulation.** It shows the shape of the effect, not production numbers. Real recall depends on the documents, the chunk size, the questions and the retriever.
- **No embedding model is tested.** The lab rules allow no packages and no network, so no neural embedding model can run here. The conclusions apply only to synonym-expanded TF-IDF. They say nothing about how well any real embedding model does. In the video, say "a retriever with a synonym list", not "an embedding model scored X%". A real embedding model learns related words from data and covers far more language, but it also makes its own kinds of mistakes, and none of that is measured here.
- **The synonym list is tailored.** It was written for this handbook's vocabulary and for the "tuning" paraphrases. The "later" set reduces this problem but does not remove it.
- The synonym list has gaps. Multi-word phrases like "time off", "get rid of" and "car park" aren't mapped, and some words have two meanings ("review" covers both code review and performance review; "request" covers both pull requests and help desk tickets). Those gaps are where it misses.
- The document is synthetic and repetitive. Real handbooks have tables, headings and messier text.
- Token counts use the rough rule of 4 characters per token, not a real tokenizer.
- Only retrieval is measured. No language model generates an answer, so the lab says nothing about whether a model would answer correctly from the retrieved text.
- 30 facts is a small sample. One miss moves a 30-question figure by about 3.3 percentage points and a 15-question set by about 6.7.
