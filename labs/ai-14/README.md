# ai-14 lab: Move 1 button. Can AI still finish the task?

## Question

If we move one button, does an agent that finds targets by their labels still finish the task, while a bot
that replays recorded clicks fails? And how much of the difference comes from checking after each action,
as opposed to just finding the target by its label?

## How to run

```
node run.mjs
```

Node.js 22, standard library only. No npm packages, no network, no child processes, no files written.
Fixed seeds, so every run prints the same numbers. It finishes in well under a second.

## What it does

Everything runs in memory. There is no browser, no Chrome, no screenshot and no image OCR.

The script builds a small settings page as an in-memory model (400 x 700 px) with a 4-step task:

1. click **Settings** to open the panel
2. turn on the **Dark mode** toggle
3. click the **Name** field and type `Calm R`
4. press **Save**

The page model has click logic: a hit test on boxes, a popup that blocks clicks under it, a **Cancel**
button that wipes the form, and a log of where every click actually landed. The task counts as done only
if the page saved `dark = on` and `name = "Calm R"`. The bots never decide that; the page does.

- **50 moved runs.** In each one, Save or the toggle moves to a random free spot in the panel. In about
  30% of them a popup ("We updated our terms", button "Got it") opens over the moved button.
- **10 control runs** on the original layout, to show the bots work when nothing changes.

**Simulated label observations.** The looking bots do not see an image. An `observe()` function reads the
visible labels and boxes directly from the page model's state (hiding what the popup covers) and then
injects errors: 6% of labels are missed, 4% are placed 40 to 120 px away (this causes wrong clicks), and
the rest are off by up to 6 px. The bots get only text and a position, not element ids, but the
observation is derived from page state, not from pixels. It stands in for a vision model's reading of the
screen, with error rates we chose.

**Bot A (replay)** clicks the exact positions recorded on the original layout and types the name. It
never observes the page, so it always reports "done".

**Bot C (observe, act, no check)** for each step observes the page, clicks "Got it" if it sees a popup
(at most 2 per step, outcome not checked), finds the target by its label and clicks it (types the name for
step 3). It does not observe after acting, so it never verifies and never retries after an action. If the
label is not in the observation it observes once more, then gives up.

**Bot B (observe, act, check)** is the same code with the same seed and error rates as Bot C, plus checks:

1. after a "Got it" click it observes again and checks the popup is gone, and logs what it observed
2. after each step's action it observes again and checks the expected change (panel open, "Dark mode On",
   "Calm R", "Saved"); the check itself misjudges 3% of the time
3. if a check fails, it retries the step once, first looking to see if the step is already done

So Bot A vs Bot C shows the effect of finding targets by label, and Bot C vs Bot B shows the effect of
checking after each action. Each action and observation has a simulated time cost.

## What it shows

For each bot: success rate, silent failures (bot said done, page says no), noticed failures (bot gave up
and said so), wrong clicks, steps, observations, simulated time per task, and success on popup runs.

Click accounting: wrong clicks include popup-dismiss clicks. A dismiss click is wrong when it does not hit
"Got it" (it can land on another control). The script reports dismiss clicks and wrong dismiss clicks
separately, and how many of Bot B's wrong clicks (dismiss or task) its checks caught.

Bot B's checks are split two ways. "Failed checks after intended-target hits" counts every time the click
hit the right control but the check said the goal was not reached. Some of those are correct detections
(for example the toggle was already on and the click turned it off). "Actual false alarms" uses
evaluator-only ground truth (the page model, which the bot never reads) to count only the checks that
said "not done" when the goal really was reached.

The script then lists every Bot B run that did not end cleanly, with the last lines of the page log. The
last line is a single `RESULT {...}` JSON line.

The shape we expect: Bot A works on the control layout but fails most moved runs, silently. Bot C recovers
most moved runs but some fail silently after a wrong click. Bot B finishes more and fails silently less,
at the cost of more steps, observations and time.

## Limits

- This is a simulation. It shows the shape of the effect, not production numbers. Nothing here runs a
  browser, takes a screenshot or reads pixels; observations come from page state with injected errors.
  Real agents use vision models, and their error rates depend on the model, the screen and the app.
- The error rates (observation miss, misplace, jitter, check misjudge) and time costs are our assumptions,
  chosen to be plausible, not measured from any product.
- The bots find things by exact label. A real page with two "Save" buttons, icons with no text, or a label
  that changes wording would be harder.
- Only one button moves per run and the popup is a single kind. Real layout changes can be bigger.
- Bot A is the simplest possible replay bot. Recorders that use element selectors instead of positions
  would survive some of these moves; the point here is positions versus looking.
- Bot C and Bot B share a seed, but their random streams diverge after Bot B's first check, so per-run
  comparisons are not paired step by step; compare the totals.
