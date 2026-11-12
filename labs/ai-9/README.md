# ai-9 lab: I hid a fake password in a file. Did the AI leak it?

## The question

If a file with a hidden fake password goes into an AI prompt, how often does the password come back out, and does a simple redaction step before sending stop it?

**This lab does not answer the "how often" part for a real model.** It runs a local simulation with a scripted stand-in and copy rates we chose. It shows where a secret ends up once it is in a prompt, and what redaction changes. How often a real model copies a secret into its answer is still an open question here and would need tests against a real model.

## How to run

```
node run.mjs
```

Node.js 22, standard library only. No npm packages, no network, no child processes, and no files are read or written. It finishes in well under a second, and the last line is a single `RESULT {...}` JSON line.

## What it does

1. Builds a small project folder in memory: `README.md`, `config.env` and `notes.md`.
2. Plants two fake canaries:
   - a fake password with a unique marker, `CANARY-7Q2X-FAKE`, written twice in `config.env` (on the `DB_PASSWORD` line and inside `DATABASE_URL`)
   - an intentionally incomplete phone-shaped canary, `+1-555-0142`, in free text in `notes.md` (it has no area code, so it is not a complete NANP number; NANPA reserves 555-0100 to 555-0199, used with an area code, for fictional use)
3. Builds a simulated request with the whole folder for 4 everyday requests, 10 runs each (40 runs):
   - "Summarize this project."
   - "Help me debug the config."
   - "Write a setup guide."
   - "List what I need to run this."
4. After every run it searches three places, and counts the **password and the phone separately**:
   - the **simulated outgoing prompt** (the exact JSON that would be sent; nothing is actually sent)
   - a **simulated provider request log**, which stores what it received, as many API gateways and debug logs do
   - the **scripted answer** from the stand-in
5. Repeats all 40 runs with a **redaction step** that runs locally before the simulated send. It swaps secrets and personal data for stable placeholders (`<SECRET_1>`, `<PHONE_1>`). The real values stay in the local process.
6. Runs a **required-facts check** on every answer. The required facts (app name, Node.js and Postgres versions, start command, the port fix, migrations) are read from the **true project folder**, not from the answer templates. The stand-in also reads every project fact from the files in the prompt, so the check can fail.
7. Tests the check itself with two controls (with redaction on):
   - **changed facts**: a different app name, versions, start command and port. Answers should still pass.
   - **left-out files**: only `config.env` is sent. Answers should fail, because the facts are missing.

All setups use the same random draws per run, so they differ only in what is sent.

## What it shows

- **Without redaction** the password is in 100% of simulated outgoing prompts and 100% of simulated log lines, and the phone is too. That is not a matter of chance: the whole file was in the prompt, so in a real setup the provider would receive it.
- **In the scripted answers** the password count depends on the request, but only because we **assumed** different copy rates per request (`copy` in `run.mjs`). The table prints password and phone counts per request. These numbers show the shape of the effect under our assumptions, not how a real model behaves.
- **With redaction** the password and the phone are in 0 simulated prompts, 0 log lines and 0 answers.
- **Required facts** stay present after redaction because the facts the answers need are not secrets. The controls show the check follows the input: it passes when the facts change, and fails when the files that hold them are left out.
- The honest lesson: a clean-looking reply does not mean nothing leaked. In this simulation the password was already in the outgoing prompt and the log, whatever the reply said.

## Limits (please read)

- **This is a simulation.** The "model" is a scripted template, not a language model. How often it copies values (`copy`) and quotes the phone line (`notes`) are assumptions we chose, not numbers measured from a real model. The prompt and log numbers do not depend on these assumptions; the answer numbers do.
- **Nothing is transmitted.** "Sent" means "the string the simulation builds as the request". The log is also simulated. Real providers differ in what they log, for how long, and who can read it. Check your provider's data policy.
- **The redactor replaces the captured value by position.** An earlier version used `whole.replace(value, ...)`, which replaces the first matching substring, so `TOKEN=TOKEN` became `<SECRET_1>=TOKEN` and kept the value. `run.mjs` now checks that case on every run and stops with an error if it regresses (it prints nothing when it passes, so the saved output is unchanged). The lab redacts each file's text before it is serialized into the JSON request; running the same patterns over serialized JSON is unsafe (escaped `\n` breaks `\b` anchors and `\S+` runs past string ends).
- **The redaction is a few regex patterns.** It catches the canaries we planted because we know their shape. Real secrets come in many shapes (API keys, tokens in code, names and addresses in free text), and a regex will miss some. Use a proper secret scanner, keep secrets out of files you share, and rotate any secret that was ever sent.
- **The required-facts check is narrow.** It checks that specific facts appear in a scripted answer. It is not a quality score, and it says nothing about whether a real model's answers stay good after redaction.
- Every value in this lab is fake. Nothing here is a real password, phone number or system.
