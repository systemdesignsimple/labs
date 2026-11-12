# AI #19 lab: "Hello" went to a small AI. A maths problem went to a big one. Who decided?

## Question

If a gateway uses a simple rule to send easy messages to a small model and hard ones to a big model,
how often does its choice disagree with a hand-written "easy or hard" label, and what does that do to
the bill under an **illustrative cost model** (assumed prices and token counts, not measured ones)?

## How to run

```
node run.mjs
```

Node.js 22, standard library only. No network, no npm packages, no files written. Runs in about a second.
The last line printed is `RESULT {...}` with the metrics as JSON.

## What it does

1. **60 everyday prompts**, hand-labelled: 42 easy (greetings, short facts, rewording) and 18 hard
   (multi-step maths, code, debugging, logic, design). About 70% easy, a share chosen for the lab.
2. **A tiny gateway** (`route()` in `run.mjs`) scores each prompt with cheap signals only:
   - longer than 280 characters: +1
   - a maths expression (`2x - 5`, `3 + 7`) or words like *solve*, *calculate*, *probability*: +2
   - a code fence or words like *debug*, *refactor*, *SQL*, *regex*, *stack trace*: +2
   - reasoning words like *prove*, *step by step*, *explain why*, *compare*, *design*, *plan*: +2
   - score 2 or more goes to the big model, otherwise the small one.
3. **Compares each choice with the label.** This is label agreement, not answer quality: no model is
   called, so the lab never checks whether either model would answer correctly. Disagreements are
   easy prompts sent to the big model and hard prompts sent to the small model.
4. **Applies an illustrative cost and latency model** and compares it with "always use the big model".
   Prices are two assumed tiers (small 0.15/0.60, big 3.00/15.00 USD per million input/output tokens),
   not a dated price sheet from any vendor. Input tokens are estimated as characters / 4; output tokens
   are assumed (60 for easy, 500 for hard). Latency is first-token delay plus an assumed tokens per second.
5. **Models a hypothetical escalation step** with expected values. For each prompt that is labelled hard
   but routed small, it assumes the small model fails 60% of the time and a checker notices 80% of those
   failures and re-asks the big model. This uses the ground-truth label to decide which prompts can fail,
   assumes easy prompts on the small model never fail, assumes the big model always succeeds, and leaves
   out the checker's own cost and latency. No checker is built.
6. **Times the routing decision** itself over 120,000 decisions. This is the only measured number.

## What it shows

- On this prompt set, most choices agree with the labels. Because most prompts are labelled easy and
  the assumed big-model price is much higher, the modelled bill drops a lot compared with sending
  everything to the big model. The size of that drop comes from the assumed prices and token counts.
- The decision itself takes microseconds on this machine, small next to any reply that takes hundreds
  of milliseconds.
- The rule disagrees with the labels on some honest edge cases:
  - "What is 2 + 2?" is labelled easy, but the maths symbol sends it to the big model.
  - A long, simple thank-you note that happens to say "step by step" goes to the big model.
  - A short riddle (bat and ball), a short logic puzzle and a letter-counting question are labelled hard
    but look easy to the rule, so they go to the small model.
- The "wrong answers" numbers are hypothetical expected errors that follow directly from the assumed
  60% failure rate. The escalation numbers follow directly from the assumed 80% detection rate. They
  illustrate why real gateways add a fallback; they do not demonstrate that a fallback works.

## Limits (read before quoting numbers)

- **This is a simulation.** It shows the shape of the effect, not production numbers. Conclusions hold
  only for this dataset and these assumptions.
- **Costs are an illustrative model, not bills.** Prices are assumed tiers, not attributed or dated list
  prices. Token counts are estimated (characters / 4) and assumed (output lengths), not counted with a
  tokenizer or taken from API usage. Change `PRICES` and `OUTPUT_TOKENS` at the top of `run.mjs` to try
  other values.
- **Latency is modelled**, not measured from any API.
- **Accuracy means agreement with labels.** The same person wrote the prompts, the labels and the rule,
  so agreement is optimistic. Real traffic has more variety and fuzzier "easy versus hard" lines. Real
  gateways often use a small classifier model, user tier, or the cost of being wrong, not just keywords.
- **Expected errors and escalation are assumptions, not observations.** No model or checker is called.
  Escalation peeks at the true label, assumes the big model always succeeds and ignores checker cost
  and latency, so it is the best case for escalation.
- **Routing time is the only measured number** and it depends on the machine; it will vary slightly
  between runs. Everything else is deterministic and repeats exactly, so no random seed is needed.
