# AI #15 lab: I interrupted the AI mid-sentence. Why did it keep talking?

## Question

When you start talking over a voice assistant, how long does it keep talking, and what actually makes it stop?

## How to run

```
node run.mjs
```

Node.js 22, standard library only, no network, no child processes. It runs on a simulated clock and finishes in a few seconds. Seeds are fixed, so every run prints the same numbers. It writes one file, `timeline.json`, in this folder.

## What it does

The assistant speaks an 8 second reply. The microphone hears room noise, plus one of three sounds starting at a random moment between 1.5 s and 6.5 s into the reply:

- **speech**: a synthetic "wait, stop" clip (a soft "w" lead-in, a vowel, a hiss, a vowel)
- **cough**: a sharp, short noise burst that dies away in about 300 ms
- **clatter**: a quieter 400 ms burst of background noise

The mic is cut into 20 ms frames. Each frame's energy is compared with the noise floor measured in the first 500 ms. The detector fires when 3 frames in a row (60 ms) are above the threshold.

Three setups, each run 20 times per sound, all on the same mic signals:

| Setup | What it does |
|---|---|
| A | No barge-in handling. The full reply is made up front and plays to the end. |
| B | Streaming playback in 100 ms chunks. When the detector fires (12 dB threshold), the queue is cleared. The chunk already sent to the speaker still plays out. A stop that lands exactly on a chunk boundary cancels before the next chunk starts, so it adds no extra chunk. |
| C | Same as B with a lower (6 dB) and a higher (18 dB) threshold. |

## What it measures

- **talk-over**: ms the assistant keeps sounding after the user starts talking (mean and p90)
- **detection delay**: ms from the user's first sound to the detector firing. This only counts valid detections, meaning speech runs where the detector fired at or after the user started. The table shows how many runs that is (`n=…/20`). If there are none, the delay shows `n/a` and the RESULT line leaves the delay metric out, because an empty sample is not "0 ms".
- **missed speech**: runs where the detector never noticed the user
- **early triggers**: speech runs where the detector fired before the user said anything (on room noise). Talk-over is then zero, but that is a premature stop, not a handled interruption, so it is counted separately
- **false stops**: share of cough and clatter runs where the assistant stopped even though nobody spoke

It prints a table, a text timeline strip for one run (one character = 50 ms), writes `timeline.json` with the same run's times for the video, and ends with one `RESULT {...}` line.

## What it shows

Without barge-in handling, the assistant talks over you for as long as its reply has left, often seconds. With streaming playback and a detector, talk-over drops to roughly the detector's delay plus whatever is left of the chunk already at the speaker. The threshold is a trade-off: a low one reacts sooner but also stops on coughs and clatter, a high one ignores more noise but reacts later. Deciding when it is your turn means balancing speed against false alarms.

## Limits (please read)

- This is a simulation. It shows the shape of the effect, not production numbers. The numbers are not figures for any real assistant or product.
- The lab rules forbid recordings and child processes, so the plan's `say` voice and recorded clip are replaced by synthetic sounds built in code. They have speech-like energy shapes, not real words.
- The detector is a crude energy threshold. Real systems use trained voice activity models and turn detection models that tell speech from noise far better, and often also look at words and pauses.
- Echo is assumed to be fully cancelled, so the assistant's own voice never reaches the detector. In real rooms, leftover echo is a major reason for false stops.
- Network delay, model generation time and speaker hardware buffers are left out. They add to talk-over in real use.
- 20 runs per case is small; percentages move in steps of 5.
