# Lab ai-21: You sent 1 message. Why does AI say "too many requests"?

Topic: rate limits and token budgets.

## Question

How can one message I send use up a rate limit that allows many requests per minute?

## How to run

```
node run.mjs
```

Node.js 22, standard library only. No packages, no network, no child processes, no files written.
It uses a simulated clock, so it finishes in well under a second and gives the same output every time.

## What it measures

Approximate token charges, not exact tokenizer counts. The lab rules allow the Node standard library only,
so there is no provider tokenizer. Every "tokens" number comes from one fixed rule (1 token per started
4 letters, 1 per 3 digits, 1 per symbol, plus a small overhead per message), and the metric names say `approx`.
The question (does one message spend a lot of a per-minute budget?) depends on how the charge grows with
context, which the rule captures, not on the exact count.

## What the lab does

`run.mjs` builds a rate limiter with two token buckets, like the two limit types AI APIs publish:

- **RPM**: requests per minute. Each model request takes 1.
- **TPM**: tokens per minute. Each request takes its input tokens plus its output tokens.

Both buckets refill smoothly over the minute. A request passes only if both buckets have enough.
If either is short, the request gets a `429 too many requests`, and the log says which bucket ran out.

The limits are set in `CONFIG` at the top of `run.mjs` (6 RPM, 10,000 TPM). They are made up for the lab
so the effect is easy to see. They are not any provider's real limits.

It sends three kinds of "one message", each on its own fresh limiter:

1. **Short question** in a new chat. Sent 3 times, with a 5 second pause after each reply.
2. **The same question at the end of a long chat.** The app resends all 45 earlier turns as input every time,
   so it is still one request, but a very large token charge. Sent 3 times the same way.
3. **The same question to an agent.** Behind the scenes the agent plans 10 model calls, with tool calls between
   them, and every call resends the growing context (system prompt, tool definitions, earlier tool results).
   If a call still fails, the agent stops there, so it may make fewer calls than planned.

The agent numbers are counted from the log of each run, not copied from the config:

- **planned calls**: `CONFIG.agentModelCalls`, what the agent meant to do
- **attempted requests**: every request that reached the limiter, 200s and 429s, retries included
- **successful calls**: calls that got a 200
- **retries**: attempts after a 429 (backoff run only)

Each line of the log shows the simulated time, the request, input and output tokens, the status (200 or 429),
the reason for a 429 (`requests`, `tokens` or both), and what is left in each bucket.

The whole thing runs twice:

- **Run 1, no retry:** a 429 becomes an error the user sees.
- **Run 2, retry with exponential backoff and full jitter:** wait a random time between 0 and
  `min(30s, 1s × 2^attempt)`, then try again, up to 8 times.

The last line is `RESULT {...}` with the metrics, a one-sentence conclusion built from the numbers, and the setup.

## What it shows

- The short question passes every time and uses very little of either bucket.
- The long-chat message costs many times more tokens than the short question, even though it is one request.
  Sending it again soon after gets a 429 on **tokens** while most of the **requests** budget is still free.
- One agent message turns into many requests. With these settings it should run out of a bucket partway
  through (the log says whether it was requests or tokens), on its own, with no other traffic.
- With backoff, those errors turn into waiting. The run reports waiting three ways, because they differ:
  total waiting across all messages, the longest wait for one user message (an agent message can hit several
  recovery periods, so its waits are added up), and the longest recovery of a single model call.
  The last one is not a limit on how long a user waits.

## Limits (please read)

- This is a simulation. It shows the shape of the mechanism, not real numbers. Real providers set their own
  limits per account, per model and per tier, and may count, refill and report them differently
  (for example fixed windows, reserving `max_tokens` up front, or separate input and output token limits).
- Token charges are approximate by design (see "What it measures"). A real provider tokenizer needs a package
  or the network, which the lab rules do not allow. Real counts will differ, and so will the exact send or call
  where a 429 fires.
- Chat text is generated from a fixed word list with a fixed seed. It is filler, sized to look like a real chat.
- Rejected requests do not spend any budget here. Some real systems do count them.
- Model latency is a simple formula, not a measurement.
- The exact moment a 429 fires depends on the numbers in `CONFIG`. Change them and the timing changes;
  the pattern (long context spends tokens, agents spend requests, backoff turns errors into waits) is the point.


## Second lab: rate limiter designs (2026-11-09, used by the ai-21 launch-style Short)

`node simulate-rate-limiter.mjs` compares a fixed window, a sliding log and token buckets (burst 10 and 3) under a
60 per minute limit, a normal chat app (231 calls in 10 minutes, 3 to 6 calls per message) and four servers with own
vs shared counters. Saved output: `rate-limiter-run-output.txt`, `rate-limiter-results.json` (separate from this
lab's `results.json`). Key numbers: burst 3 blocked 81 of 231 calls from a user under the limit, burst 10 blocked 0;
four servers counting alone let 240 through a 60 limit, one shared counter 60. Simulation of one client, requests
only (real APIs also limit tokens per minute); independently reviewed 2026-11-09.
