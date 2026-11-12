# Lab ai-8: I asked my AI agent to tidy my files. Would it delete them?

## Question

When an AI agent is asked to tidy a folder, how many files does it actually delete or damage
under full access, versus inside a sandbox with limited permissions and a confirm step?

## How to run

```
node run.mjs
```

Node.js 22, standard library only. No npm packages, no network, no child processes.
Nothing on your real disk is created, read or deleted: the "disk" is an in-memory Map.
It finishes in well under a second and prints the same numbers every time (fixed seed).

## What it does

1. Builds a pretend folder `Tidy/` with 200 dummy files: temp files, `_old` versions,
   `copy` files, drafts, `(1)` duplicates, 20 ordinary files and 10 files marked important
   (passport scan, tax return, lease, budget, and so on). Next to it sits a pretend
   `Downloads/` folder with 40 files the agent has no business touching.
2. A scripted agent stands in for a real model. Told "tidy this folder", it replays one fixed
   plan of 7 actions, some of them careless:
   - `delete *.tmp`, `delete *_old*`, `delete * copy*`, `delete draft_*`
     (these patterns also catch important files like `passport_scan_old.jpg` and `draft_will.docx`)
   - merge `* (1).*` duplicates onto the original name (an older `budget (1).xlsx` overwrites the real budget)
   - move `*.txt` into `Archive/` (harmless)
   - `delete ../Downloads/*.zip` (outside the folder it was asked about)
3. The same plan runs under three setups:
   - **Full access:** the agent writes and deletes directly in the simulated original folder
     (an in-memory Map standing in for your real folder).
   - **Sandbox:** the agent works on a copy of the simulated original folder, delete and overwrite become "move old version to
     trash", and any path outside `Tidy/` is blocked.
   - **Sandbox + confirm:** as above, plus every destructive action stops and shows the list of
     files it will remove. The simulated reviewer unticks files they know are important and
     approves the rest.
   - Extra row **3b, rubber stamp:** the confirm step where the reviewer clicks yes without reading.
4. For each setup it counts files removed, files overwritten, important files lost for good,
   files recoverable, outside files touched, actions blocked, and actions that needed a confirm.
   A removed file counts as recoverable only if a check of the final state finds the same file ID
   with its original content in the trash or at its original path in the simulated original
   folder. It is never assumed from the setup name.

## What it shows

- With full access the careless patterns go through: several important files are gone for good,
  the budget is silently replaced by an older version, and the zips in `Downloads/` are deleted.
- In the sandbox the very same actions still run, but every removed file is recoverable
  (verified by ID and content in the trash and in the untouched original folder) and the
  outside action is blocked.
- With the confirm step, the destructive actions pause, important files are left alone, and the
  real junk is still cleaned, so safety does not mean doing nothing.
- Even when the reviewer rubber-stamps every confirm, nothing is lost for good, because the
  sandbox is still underneath. The confirm step and the sandbox protect against different mistakes.

The exact counts are whatever `run.mjs` prints; read them from the RESULT line.

## Limits (be honest about these)

- This is a scripted permission model, not a test of real permissions. Every setup runs on
  in-memory Maps. No operating-system file permission, container or sandbox boundary is
  tested; the "sandbox" here is a few lines of code that copy a Map and refuse paths outside `Tidy/`.

- The agent is scripted, not a live model. The lab measures what the permission layer does with
  a risky plan, not how often a real AI makes such a plan.
- The files, names and plan were chosen by us to include realistic careless patterns. Different
  folders and plans give different counts. This is the shape of the effect, not a production number.
- The "careful" reviewer knows exactly which files are important. Real people skim long confirm
  lists and miss things, which is why the rubber-stamp row is included.
- The sandbox is modelled as an ideal one (perfect copy, perfect boundary, trash never emptied).
  Real sandboxes can be misconfigured, and a trash that is emptied is no longer a safety net.
- Overwrite damage is counted only when the replacing file has different content.
