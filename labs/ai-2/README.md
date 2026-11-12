# AI #2 lab: streaming, time to first text vs total time

## Question

If the same answer takes the same total time to make, how much sooner does the user see the
first words when the app streams it instead of waiting for the whole reply?

## How to run

```
node run.mjs
```

Needs Node.js 22. Standard library only, nothing to install. Takes about 5 seconds.
It writes one file, `timeline.json`, in this folder.

## What it does

- A stand-in text generator makes a fixed 120-word answer, one word (token) at a time.
  Each token waits 33 ms plus or minus 8 ms (seeded), so the full answer takes about 4 seconds.
- Two "endpoints" use the same generator and return an in-process byte stream (a web
  `ReadableStream`). This replaces the HTTP chunked transport in the original plan: no HTTP
  server or socket is involved.
  - **buffered**: collects every token, then sends the whole reply as one JSON body at the end.
  - **stream**: sends each token the moment it is made, framed as Server-Sent Events (`data: ...`).
- A client calls each endpoint 20 times. Trial *i* uses the same token delays in both modes,
  and all 40 calls run at the same time on one event loop, so both modes share the same conditions.
- For each call it records client text-availability times, that is, when the client has
  decoded and parsed the text (not when characters are drawn on a screen):
  - **time to first text**: request start to the first parsed word
  - **total time**: request start to the last parsed word
- It prints the median and p95 for each mode, and saves the word-by-word arrival times of
  trial 0 in both modes to `timeline.json`, so the video can draw both runs filling in.
- The last line is `RESULT {...}` with the metrics, a one-sentence conclusion and the setup.
- The conclusion is built only from the measured numbers, using fixed tolerances:
  - total times count as "about the same" only if the medians are within 5% of the buffered total;
  - streaming counts as "starting sooner" only if its median first text beats buffered by more
    than 100 ms and by more than half of the buffered first-text time.
  If the numbers fail either check, the sentence says what was measured instead (for example
  "similar first text" or "total time differed by more than 5%").

## What it should show

- Total time is about the same in both modes, around 4 seconds. Streaming may be a few
  milliseconds slower because each small chunk has a little overhead.
- Time to first text is very different. Streaming shows the first word after about one token
  delay (tens of milliseconds). Buffered shows nothing until the whole answer is done, about 4 s.
- The honest point: streaming does not make the answer finish sooner. It only makes it start sooner.

## Limits

- This is a simulation. It shows the shape of the effect, not production numbers. On screen it is
  labelled as a simulated generator on localhost, not a real AI product.
- Everything runs in one Node process. There is no real network, so network latency, TLS,
  proxies and buffering by servers or CDNs are not measured. Those add time to both modes,
  and a proxy that buffers can quietly turn a stream back into one big reply.
- A real model also spends time before its first token (reading the prompt, queueing).
  This lab sets that to zero, so real first-text times are longer than the numbers here.
- Token delays are fixed and evenly spread. Real models vary more, and one token is not one word.
- It measures when the client has the text, not when a person sees it. Real apps add
  rendering time (layout, paint, a typing effect) on top.
- There is no HTTP. In-process byte streams stand in for an HTTP body, so chunked encoding,
  socket buffering and Nagle-style batching are not part of the numbers.
- Fixed seeds repeat the requested token delays, not the measured times. Real timers fire a
  little late depending on what else the machine is doing, so numbers change slightly
  between runs. Timer precision is around 1 ms, so small differences in total time are noise.
- All 40 calls run at once on one event loop, so they share the same scheduling hiccups.
  The p95 therefore describes the spread across these concurrent simulated calls, not the
  tail latency of independent real requests.
