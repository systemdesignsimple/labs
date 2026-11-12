# AI 17 lab: same question 10 times, different answers. Which one passes?

Topic: evals and guardrails.

## Question

This is a simulation of eval and retry behavior, not a test of a model. We sample 10 replies to one refund question from a set of replies we wrote ourselves. How many of them are incorrect? How many incorrect ones does a retry-once guardrail block, and how many does it let through?

## How to run

```bash
node run.mjs
```

Needs Node.js 22. Standard library only: no npm packages, no network, no API key. It finishes in about a second. The last line it prints is a single `RESULT {...}` JSON line. It also writes `replies.json` in this folder. That file holds every attempt from the main 10 asks, from the hard case (if it ran) and from the 1,000-ask long run, each with its check results and both hidden labels.

## What it does

1. **The prompt.** Return a refund decision as JSON `{decision, amount, reason}`. The order is an $80 item plus $8 shipping, bought 20 days ago. The policy: full refund of the item price within 14 days, 50% from day 15 to day 30, nothing after day 30, shipping never refunded, no extras promised. The right answer is `partial`, `$40`.
2. **The simulated replies.** No model is called. `run.mjs` holds 13 reply categories that we wrote by hand to look like the kinds of reply models give to this kind of prompt. They are: correct JSON in three wordings and layouts, JSON in a code fence, a sentence before the JSON, the amount as a string, a missing field, wrong math (a full refund, or 50% including shipping), a promise the policy forbids, a reply with the right amount but a wrong reason ("you are a loyal customer"), and two that only occur in the hard case. Each ask picks one category with a seeded random number. Every category has a fixed weight (`logit`), and the "temperature" of 0.8 only reshapes that category distribution through a softmax: higher makes the rare categories more common. This is not how a real model samples tokens. It is a knob on our own made-up mix.
3. **The eval: 3 checks.**
   - Format: valid JSON, `decision` is one of full/partial/none, `amount` is a number, `reason` is not empty.
   - Policy math: the decision matches the policy, and the amount is a whole number of cents equal to the expected amount (so `40.004` fails, it is not a valid refund).
   - No forbidden promise: the reason does not offer a replacement, store credit, return shipping, discounts and the like.
4. **The guardrail.** Runs the same 3 checks before an answer would reach the user. A failing reply is blocked and the question is asked once more. If the retry also fails, the answer is blocked and would go to a human. Because the guardrail calls exactly the same check function as the eval, the two always agree. That agreement is guaranteed by the code, so it proves nothing on its own.
5. **Two hidden labels, set by hand for each category, never seen by the checks.**
   - `sound`: the reasoning is right. This label says nothing about format. A fenced JSON reply with the right reason is `sound`.
   - `correct`: the whole answer is right. That means it follows the requested JSON contract exactly, has the right decision and amount, makes no forbidden promise, and has sound reasoning. Only the three clean `correct_*` categories are correct. The fenced, prose and string-amount replies are sound but not correct.
   The lab measures the guardrail against `correct`, not against its own checks.
6. **Hard case.** If all 10 replies pass the eval first try, the lab reruns with a harder case (day 30 exactly, $79.99 item, so there is a boundary and a cent to round) and reports that too.
7. **Long run.** The same pipeline runs 1,000 times with another seed, to show the long-run rates behind the 10-ask sample.

## What it shows

- The 10 replies differ in wording, layout and sometimes amount, even though the question never changes (because we sample different authored categories).
- How many pass the eval first try, and which check each failure hit.
- The counts the question asks for: how many first answers are incorrect (`first_try_incorrect`), and of all incorrect attempts, how many the guardrail blocked (`incorrect_blocked`) and how many it accepted (`incorrect_accepted`). It also reports `correct_blocked` (false alarms).
- Retries, answers delivered and blocked, and the extra time the retries added.
- The limit: a reply with valid JSON, the right amount and no forbidden promise passes all three checks even when the reason is wrong. Those are the incorrect answers that get accepted. The checks test shape and rules, not reasoning. Catching that needs another kind of eval, such as human review of a sample or a check on the reason itself.

## Limits, read before quoting numbers

- **This is a simulation.** No real model is called. We chose the reply categories, their wording, their weights and their correct/sound labels in `run.mjs` (`VARIANTS`, `CORRECT_VARIANTS`). The numbers show the shape of the effect (variation, partial catch, retry cost, what slips through). They are not the pass rate or error rate of any real model, and the temperature here is not a model's sampling temperature.
- With only 10 asks, one reply more or less moves a rate by 10 points. That is why the 1,000-ask long run is printed next to it.
- The guardrail and the eval share one check function, so whatever the eval passes, the guardrail accepts. The meaningful comparison is between the checks and the hidden `correct` label.
- Model latency is simulated (700 to 1300 ms per call on a virtual clock, nothing actually waits). The time spent in the checks is measured for real, so `avg_eval_check_time` changes a little from run to run. It is tiny next to a model call. The real cost of a guardrail is the retry call.
- The retry here is a plain resample. Real systems often send the error back to the model, which can raise the retry success rate.
- The format check is strict on purpose (a code fence counts as a failure). Many real apps strip fences first. That would change the format count, not the lesson.
- The hidden labels are ours. In real life that judgement comes from people reviewing a sample.
