# Recorded runs of ref_cas_lab.py

## Run 1 · 2026-11-06 · Mac, Python 3.14 (article draft run)

Raw stdout of this run was not kept; values as recorded in the draft.

| Case | ok | rejected | time |
| --- | ---: | ---: | ---: |
| 1,000 agents, own refs, parallel | 1000 | 0 | 0.06 s |
| 1,000 agents, own refs, serialized | 1000 | 0 | 11.63 s |
| 100 agents, all on main, parallel | 100 | 4950 | 2.28 s |

## Run 2 · 2026-11-06 · Mac, Python 3.14.7 (fact-check re-run of the same code)

| Case | ok | rejected | time |
| --- | ---: | ---: | ---: |
| 1,000 agents, own refs, parallel | 1000 | 0 | 0.42 s |
| 1,000 agents, own refs, serialized | 1000 | 0 | 12.15 s |
| 100 agents, all on main, parallel | 100 | 4950 | 2.29 s |

Counts match across runs. Times differ with scheduling; the parallel case is dominated by creating 1,000 tasks.

To add a run: `python3 -I ref_cas_lab.py > run-YYYY-MM-DD.txt` and append a section here.
