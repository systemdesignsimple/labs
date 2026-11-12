# Lab AI #5: AI can't see a clock. So how did it tell me the time?

Topic: AI agents and tool calls.

## Question

How does a tool call get the current time into a model's answer, and what does the extra step cost?

This lab demonstrates the **mechanics** of a tool call, using a scripted model whose behaviour is assumed. It does **not** measure how real models behave without a clock tool. That experiment needs a real model behind an API, and this lab's rules forbid network access and npm packages, so it cannot be run here. Every refusal, guess, tool use and timezone slip below happens because the script was written to produce it.

## How to run

```
node run.mjs
```

Node.js 22, no npm packages, no network, no files written. Finishes in well under a second.
The last line is `RESULT {...}` with the metrics, a one-sentence conclusion and the setup.

## What it does

The same prompt, "What time is it right now in Tokyo?", goes to the same scripted model in two modes, 20 runs each.

- **Mode A, no tools.** Nothing in the model's input says what "now" is. By assumption, the scripted model either refuses ("I can't know the current time") or guesses a time on a fixed past date (2025-06-01). That date is an illustrative choice, written in as a constant.
- **Mode B, one tool.** The app offers `get_current_time(timezone)`. The model writes a tool-call request, the app's code reads the clock and sends the result back, and the model writes the final reply from that result.

For every run the lab records whether a tool call happened, how many minutes the answer is off from the virtual clock, and, for tool-using runs, the simulated tool time and simulated follow-up model call time. It prints one full mode B trace (request, arguments, tool result, reply) for the on-screen terminal, plus one mode A run for contrast. All millisecond values are labelled `sim`.

## What it shows

- **Where the time comes from.** In `run.mjs` the model function only sees messages. Only the app's `get_current_time` touches the clock. That is the whole idea of a tool call: the model asks, the app's code does it, the answer goes back as text.
- **No source, no right answer.** In mode A nothing gives the scripted model the current time, so its reply cannot match the clock except by luck. How wrong the guesses are depends only on the assumed guess date.
- **The cost of the tool path.** Each tool-using run records its own added cost directly: tool time plus the follow-up model call that turns the tool result into a reply. The lab reports the median of those, and the two parts separately. It does not subtract medians from separate runs.
- **Misses are reported, not hidden.** A run where the scripted model skips the tool, or reads the UTC field and calls it Tokyo time, is printed as a "mode B miss". These show the kinds of failure a real app has to check for. Their rates are assumptions.

## Limits (please read)

- **This is a scripted model, not a real one.** Its behaviour is a small seeded function. The refusal rate (45%), tool-skip rate (5%) and timezone-slip rate (5%) are assumptions I chose, not measurements of any product. Real models differ by model, prompt and system prompt.
- **The guess date is an assumption.** The scripted model guesses on 2025-06-01 because the code says so. This lab makes no claim about what date a real model assumes when it has no clock, or whether a training cutoff has anything to do with it.
- **The clock is virtual.** It starts at 2026-11-05 23:00 Tokyo time and moves forward by the simulated latencies, so every run prints the same numbers. In a real app, `get_current_time` would read the machine clock.
- **All latency is simulated.** 400 to 1000 ms for the first model call, 300 to 800 ms for the follow-up, 1 to 5 ms for the tool. Nothing is timed. The added-cost numbers show the shape (one extra model round trip, while the tool itself is cheap), not what any provider will give you.
- So the simulation shows the shape of the effect, not production numbers.
