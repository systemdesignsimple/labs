# ai-7 lab: where did the tokens go?

Episode ai #7: "One AI task cost as much as 1,000 chats. Where did it go?"

## Question

When an AI agent does one task in N model calls, how many tokens does it send in total, how much of that is re-sent history instead of new work, and how does that compare with one normal chat?

## How to run

```
node run.mjs
```

Node.js 22, no packages, no network, no API key. It runs in a few seconds and costs nothing. It only reads its own source file.

## What it does

1. **One normal chat (the baseline).** One request (system prompt + one question, as JSON) and one answer. It estimates input and output tokens separately.
2. **One agent task with N calls.** Every request carries a fixed part (system prompt, 10 tool schemas, the task). Calls 1 to N-1 each write a short message and a tool call (`read_file`, `grep`, `run_tests`, `edit_file`, `list_dir`); the tool result joins the history. Call N writes the final answer, so every generated tool result is sent at least once.
3. **Each full request is built and counted.** Request k is serialized as one JSON body (`system`, `tools`, `messages` with roles and content blocks) and its tokens are estimated as a whole, framing included. The lab records, per request, the full size and the new tokens in it (what was not in request k-1). It prints all 50 for the medium profile.
4. It runs N = 5, 10, 20, 30, 50 for three **synthetic workload profiles** (light, medium, heavy). Each step's content comes from its own seed and is generated at full length; the profiles keep 20%, 50% or 100% of each tool output. So light is an exact prefix of heavy: only size changes, not content.
5. It compares the agent with one chat three ways, never mixed:
   - **read multiple** = agent input tokens / chat input tokens,
   - **combined multiple** = agent input + output / chat input + output,
   - **cost multiple** = agent illustrative cost / chat illustrative cost (no cache; the cached cost is shown too).

   The conclusion uses the matching metric for each claim: "sends X times the input" comes from the read multiple, "costs Y chats" from the cost multiple.

The last line printed is `RESULT {...}` with the key numbers and one sentence built from them.

## What it shows

- The fixed part and every old tool result are sent again on every call. Call 30 re-sends calls 1 to 29.
- So total input grows faster than the number of calls, close to its **square** for long tasks. The `growth exponent` metric measures it (1 = straight line, 2 = square; the fixed part pulls it below 2 for short tasks).
- Most of the input is **history being re-sent**, not new work. The per-request table shows new tokens per call stay small while the request size keeps climbing.
- A prompt cache makes re-sent tokens much cheaper (here 10% of the input price), so cost drops a lot, **but the token count stays the same**.
- The read multiple, combined multiple and cost multiple are different numbers. Input tokens are cheap and output tokens are expensive, so the cost multiple is much smaller than the read multiple. Whether a task "costs 1,000 chats" depends on which measure you mean, the profile and N. The video should show the curve and the range, not one fixed number.

## Limits (be honest in the video)

- **This is a simulation, not a billed production run.** It shows the shape of the effect, not any product's real numbers.
- **Token counts are estimates, not a model tokenizer.** A simple word-piece rule (leading space joins the word, long words split every 4 letters, numbers in groups of 3, symbols in pairs) is used. The lab does not claim any accuracy against a real tokenizer; real counts differ by model. The claims are ratios, so the run repeats the key ratios with a second estimator (characters / 4) to show they hold under a different counting rule.
- **The workload is synthetic, not a measured coding session.** Prose, test logs, paths and directory listings are generated from fixed seeds; file reads and grep hits use this lab's own source code (the only file it may read) as code-shaped text. The light, medium and heavy profiles are arbitrary sizes chosen to show the range, not "typical" agent tasks.
- Real agents often have much larger system prompts and tool lists, and some tools return far more text. Others trim or summarize old history, or start fresh sub-tasks. Those change the numbers a lot in both directions.
- Prices are illustrative (USD 3 per 1M input, 15 per 1M output, cache reads 10%, cache writes 125%), the shape of a common public price list, not a quote for any product. Cache rules (minimum size, expiry time) are ignored.
- Reasoning or "thinking" tokens are not simulated.
- Same seeds, same numbers every run.
