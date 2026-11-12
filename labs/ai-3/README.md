# Lab ai-3: My chat got long. The AI forgot my name. Why?

## Question

With a fixed context window, at which turn does a name said in message 1 stop being
visible to the model? And does a small pinned memory keep it?

## How to run

```
node run.mjs
```

Node.js 22, standard library only. No npm packages, no network. It should finish in a
second or two. It writes one file in this folder, `trace.csv`, with the log for every turn.
The last line printed is `RESULT {...}` with the metrics.

## What it does

1. Plays a scripted chat of 200 turns (one turn = one user message plus one reply).
   In message 1 the user says "My name is Calm R". All later messages are filler about
   building a study planner app, made from a fixed seed, so every run is the same.
   No filler message contains the name.
2. Counts approximate tokens in every message, plus 4 units of overhead per message for
   role markers. Every "token" number in this lab, including the 4k, 8k and 32k budgets,
   is an approximate token unit from a heuristic splitter, not a count from a real model
   vocabulary (see Limits).
3. Before each reply, builds what the model would see under three strategies:
   - **A, truncate:** keep the newest messages that fit the budget, drop the oldest.
   - **B, pinned memory:** same, but a short line `Memory: user name: Calm R.` always
     sits at the top. It is written once, when the user says the name.
   - **C, rolling summary:** same, but 200 units are reserved every turn for a summary
     note. The note is updated incrementally: each turn it sees only its own previous
     content plus the messages evicted since the last turn, never the full history.
     Facts such as the name go first, then earlier topics while there is room. The
     actual note is at most 200 units, and 0 before anything has been evicted.
4. Logs, for every turn, the total tokens, the oldest turn still in the window, how many
   messages were dropped, and whether the text "Calm R" is anywhere in the window.
5. Repeats this at 4k, 8k and 32k token budgets.

## What it shows

- With truncation (A), the name drops out at one exact turn. That turn is about
  budget divided by average turn size, and the output prints both so you can compare.
- A bigger window moves that turn later. It does not stop it.
- A pinned line (B) or a rolling summary (C) keeps the name in the window on every turn.
  B costs a small fixed number of units per turn. C reserves a fixed 200 units per turn;
  its actual note varies from 0 up to at most 200, and the output prints the real range.

## Limits (please read)

- **This is a simulation of the truncation mechanism, not a measurement of any chat
  product.** Real assistants may use much larger windows, smarter summaries, retrieval,
  or their own memory features. The numbers show the shape of the effect, not
  production numbers.
- **Visible is not the same as remembered.** We check whether the name is inside the
  window. A name in the window makes recall possible but does not guarantee it, and
  models can miss facts deep in long windows. We do not run a model.
- **The tokenizer is an approximation, so all budgets are approximate token units.** The
  plan asked for a real open tokenizer. The lab rules allow no packages and no network,
  and only two files, so there is no way to ship a real vocabulary. The plan is revised to
  this: budgets and metrics are approximate token units, and they are labelled that way
  in the output and in RESULT.
  `run.mjs` splits text the way GPT-style tokenizers do (words with their leading space,
  numbers, punctuation) and splits words longer than 7 letters into chunks of about 4
  letters. That gives roughly 1.2 to 1.3 tokens per English word, close to real
  tokenizers, but exact counts will differ. The forgetting turn is set by the ratio of
  budget to message size, so the shape holds even if each count is a little off.
- **The summary is rule based.** Strategy C finds "my name is ..." with a pattern and
  always keeps it. A real summary written by a model might drop the name, and a
  rolling summary can lose a fact on any rewrite. So C shows what a good summary buys
  you, not that every summary is good. Once the note is full, new topics are skipped.
- Filler text is random words in sentence form. It has realistic length, not realistic
  meaning.
- We do not reserve room for the reply. Real systems usually do, which would make the
  name drop out a little earlier.

## Files

- `run.mjs` : the lab.
- `trace.csv` : created by the run. Columns: budget, turn, strategy, total tokens and
  memory tokens (both approximate units), oldest turn in window, messages in window, messages dropped,
  name visible (1 or 0).
