# ai-18 lab: 1,000 people ask AI at once. Who gets an answer first?

Episode: AI #18, "Serving an LLM: batching and the KV cache".

## The question

1,000 people send a prompt at the same moment. On a tiny toy model whose step times we measure
ourselves, how much sooner does the median person get their first word when the server keeps a
KV cache and uses continuous batching, compared with answering one person at a time with no cache?
The lab also splits that gain into two parts: the cache alone, and batching alone (cache on in both).

## Plan change (read this first)

The episode plan asked for measurements on a real open model (GPT-2 small or distilgpt2) and an
optional server-like profile. To keep the lab free of packages and downloads, the plan is
revised to what the rules permit:

- **Model:** a tiny decoder-only transformer written in plain JavaScript with the same structure
  (token and position embeddings, attention with a KV cache, feed-forward block, layer norm, tied
  output layer). The weights are random with a fixed seed, so the tokens it "writes" are nonsense,
  but the arithmetic per token is real and so are the timings. Hidden size 128, 4 heads, 2 layers,
  feed-forward 512, vocabulary 1,024.
- **No assumed server profile.** The earlier draft added an invented "server-like" cost curve.
  It has been removed. Every cost the queue uses is a measurement from this run.
- The result is evidence about this toy model on one CPU core only. It is not evidence about
  real models or GPU servers.

## How to run

```bash
node run.mjs
```

Node.js 22, standard library only. No npm packages, no network, no child processes. One thread.
It writes `chart.svg` and `ttft.csv` into this folder, and its last line is a single
`RESULT {...}` JSON line.

**Time budget.** Before measuring, the script times one small pass, estimates how long a full
measurement pass will take on this machine, and picks 1 to 5 measured repetitions to fit a 40 second
measurement budget. Between passes it checks the clock and stops adding repetitions once the budget
is used (always keeping one warm-up and at least one measured pass). The queue replay and the
report take well under a second. The `runtime` metric records the total; check it is under 60 s on
your machine.

## What it measures (Part A)

All timings are medians over the measured passes. Pass 0 is a warm-up for every path and is
not counted.

1. **KV cache on vs off, one answer.** A 48-token answer to a 16-token prompt.
   - Cache on: process the prompt once, then each new token is one row that reads stored keys and values.
   - Cache off: each new token recomputes keys and values for the whole prompt and answer so far.
   Both paths get the same warm-up and the same number of repetitions, and they swap which one runs
   first on every pass. The lab reports median, min and max for each. It **rejects the run** if any
   cache-on or cache-off run produced different tokens.
2. **Uncached step** at context lengths 8, 16, 32, 64, 96, 128 (one full forward pass, batch 1).
   This is the cost of one token when nothing is cached, and also the cost of prefilling one prompt.
3. **Prefill step** for 1, 4 and 16 prompts at once, each 8, 16 or 32 tokens long. Prefill is measured
   on its own because it is different work from decoding: many rows per person, attention over the
   prompt, and next-token logits only for each prompt's last row.
4. **Decode step with the cache** for 1, 4 and 16 rows at cached context 8, 32, 64 and 127.

## The queue (Part B)

1,000 requests arrive at t = 0 (seed 18). Prompts are 8 to 32 tokens, answers 16 to 96 tokens. Four
policies:

- **One at a time, no KV cache.** Every token of every answer is a full recompute (uses step 2).
- **One at a time, KV cache.** Prefill, then one decode row per token (steps 3 and 4 at batch 1).
- **Static batches of 16, KV cache.** Prefill 16 prompts together, then decode all 16 until the
  longest answer is done. Answers that finished early still take a row every step (padding).
- **Continuous batching, 16 slots, KV cache.** When a slot frees up, the next person in line is
  admitted with a prefill step, then joins the shared decode steps.

How costs are used:

- A prefill step costs the sum of each admitted prompt's share of a measured B-prompt prefill at its
  length. A decode step costs the sum of each row's share of a measured B-row decode step at its
  own context length. So longer contexts cost more, as they do in real attention.
- Costs between grid points are interpolated linearly. Every request in the queue falls inside
  the measured ranges (batch 1 to 16, prompt 8 to 32, context 8 to 128). The script throws, and the
  run is rejected, if any cost would need extrapolation.

For each policy the lab reports time to first word (median, p95, last person), the time until
everyone is done, and tokens per second. `chart.svg` plots each person's first-word time for all
four policies. `ttft.csv` has the same data per person.

## What it shows

- With the cache off, every token re-reads the whole history, so a longer answer gets slower per
  token. The cache removes that repeated work. The ratio reported is whatever this run measured,
  and the conclusion is worded from it (faster or slower).
- Batching changes who waits. One at a time makes person 1,000 wait for every answer ahead of them.
  Batching starts many people at once, so most people get their first word much earlier, even when
  total throughput barely changes.
- On one CPU core, a 16-row decode step can cost much more than a 1-row step, because the CPU is
  mostly limited by arithmetic. The `decode_throughput_gain_b16_vs_b1_ctx64` metric shows how much it
  actually helped here. On GPUs, small decode batches are usually limited by memory bandwidth,
  so batching can raise throughput far more. This lab does **not** measure that and makes no
  claim about it.

## Limits (please read)

- This is a simulation built on a toy model. It shows the shape of the effect, not production
  numbers. A real server runs a model thousands of times larger, on GPUs, with optimized kernels.
- Timings come from single-threaded JavaScript on this CPU. They vary between runs and a lot between
  machines; the min and max in the output show the spread. The workload, the seed and the queue
  logic are fixed, so compare the ratios. Machine, Node version and seed are printed in `setup`.
- A mixed prefill (prompts of different lengths) is modelled as the sum of per-prompt shares
  measured with equal-length prompts. Real servers pad or pack prompts differently.
- Prefill and decode run as separate steps, as in simple servers. Chunked prefill, priorities,
  preemption, KV cache memory limits and arrivals spread over time are not modelled.
- The full run has not been checked against the 60 second limit on every machine. The script sizes
  its own work and reports `runtime` and `measurement_budget_cut`; confirm both on the target
  Node.js 22 machine before using the numbers.
