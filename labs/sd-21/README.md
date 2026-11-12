# sd-21 lab: SQL or NoSQL is the wrong question

## Question

If the data and the engine stay the same and only the data shape changes (normalized tables vs one document per user), which workloads get faster, which get slower, and by how much?

## How to run

```
node run.mjs
```

- Needs Node.js 22.13 or newer (built-in `node:sqlite`). On Node 22.5 to 22.12 run `node --experimental-sqlite run.mjs`.
- Standard library only. No npm install, no network, no child processes.
- Progress goes to stderr. A small table and the final `RESULT {...}` line go to stdout.
- Raw timing samples and all check results are saved to `results.json` in this folder.
- Exit code: 0 = conclusion reported, 1 = a correctness check failed (no timing comparison is reported), 2 = the time budget ran out before any size finished.

### Time limit

The script works to one global deadline: 45 seconds for all work, with 3 of those kept back for writing `results.json` and printing. Before each unit of work (loading a size, one measured pair, the final checks) it estimates the cost from what it has already measured and starts the unit only if twice the estimate fits in the time left. Bigger sizes are only tried if the smaller size finished, and their cost is estimated by scaling up the smaller one.

This is a careful guard, not a hard guarantee. A SQLite call that has started cannot be stopped, so a machine that is suddenly much slower than the estimate can still overrun. On a normal laptop the run should end well inside 60 seconds. If a size or workload does not fit, it is skipped and the RESULT line says so.

## Setup

One SQLite database in memory (`node:sqlite`) holds the same synthetic shop data twice:

| Shape | Tables | What a user looks like |
| --- | --- | --- |
| Normalized | `users`, `products`, `orders` (joined by IDs, index on `orders.user_id`) | 1 user row, N order rows, each pointing to a product row |
| Document | `user_docs` | 1 JSON text per user with the orders inside and a copy of each product name |

- Fixed seed (21), so the data is identical on every run.
- 10,000 and 100,000 users (100,000 is the upper limit), 1 to 9 order lines each (about 5 on average), 1,000 products.
- Product popularity follows 1/rank, so product #1 shows up in about 13% of all order lines.

Both shapes use the same engine, process and memory, so vendor, network and driver differences are out. Only the shape changes.

## Plan changes (read this if you saw the first plan)

The first plan said "a local SQLite file" and "1,000 repetitions per workload". The lab does something different, and the timings mean something different because of it:

- **In memory, not a file.** The database lives in RAM (`:memory:`). There is no disk, page cache or fsync in the numbers. That removes noise from the disk, but it also removes the disk cost that a real database pays, especially on writes. The rename numbers in particular are lower than they would be on disk.
- **Adaptive sampling, not 1,000 repetitions.** Each workload takes as many samples as fit in its time share (about 4 seconds per workload per size, up to 300 / 200 / 200 pairs for profile / report / rename). Fast workloads get hundreds of samples. Slow ones at 100,000 users may get only a handful.
- **Few samples means weak tails.** `p95Ms` is only filled in when there are at least 20 samples, otherwise it is `null`. The verdict for a workload needs at least 3 samples per shape, and the middle halves of the two sample sets (25th to 75th percentile) must not overlap. Otherwise the workload is called inconclusive.

## How it measures

- **Interleaved pairs.** Each measured pair runs both shapes once, and the order flips every pair (normalized first, then document first, and so on). Both shapes always get the same number of samples.
- **Matched profile samples.** Each profile sample loads the same 20 users in both shapes, so per-user order counts cannot favour one side. The reported time is per profile (batch time divided by 20). Batching keeps each sample well above timer resolution.
- **Equal-length renames.** The rename switches between `Renamed 0001` and `Product 0001`, which have the same length as the original name, so document sizes do not grow over the run.
- **Full precision.** Ratios and winners are computed from unrounded times. Only the printed values are rounded.
- **Timer resolution.** The script measures the smallest step of `performance.now()` and sets a floor at 100 times that. If both shapes are below the floor, the verdict is inconclusive. If only the faster one is below it, the speed-up is reported as "at least N x".
- No untimed warm-up runs for the report and rename (they are expensive). A short profile warm-up is included and budgeted. Medians keep the first, cold sample from moving the result much.

## The three workloads

1. **Load one profile.** Get one user with all their orders and product names. Normalized: one query with two joins, put together in JS. Document: read one row and `JSON.parse` it.
2. **Ad-hoc revenue report.** Total revenue per product across all users. Normalized: `GROUP BY` over `orders` joined to `products`. Document: `json_each` over every document, inside SQLite.
3. **Rename one product.** Rename the most popular product. Normalized: update 1 row. Document: find every document that holds a copy of the name (this looks inside every document, as there is no index on product), rewrite each one that matches and save it, all in one transaction.

`results.json` holds, for each workload and shape, every timing sample (per operation, full precision, in measurement order) plus median, quartiles, min, max and p95 when there are enough samples.

Record counts are **logical estimates**, not measured SQLite row accesses: for example "1 user row + each order row + its product row" for a normalized profile, or "every document" for the document report. For the rename, documents scanned (all of them) and documents rewritten (only those holding the product) are reported separately.

## Checks (they gate the conclusion)

- **Profile:** every sampled profile (20 users per sample, all samples) must be identical in both shapes.
- **Report:** in every sample, each product must have the same name and revenue in both shapes, and both must list the same number of products.
- **Rename:** every normalized rename must change exactly 1 row; every document rename must rewrite exactly the documents that contain the product (known from data generation); afterwards the product row and every embedded copy must hold the final name (`staleDocumentCopies` must be 0).

If any check fails, the RESULT conclusion says validation failed, reports no timing comparison, and the script exits with code 1. A size whose checks could not run inside the time budget is not used for the conclusion.

## What it shows

- The document shape should win the profile load: one read, no join. With small data in memory the gap is a fraction of a millisecond, and we say so.
- The normalized shape should win the report, because the document shape has to parse every document to answer a question it was not built for.
- The normalized shape should win the rename by a wide margin: 1 row against tens of thousands of rewritten documents and megabytes of JSON.
- So neither shape is faster in general. Each wins the access pattern it was shaped for. Pick the shape from how you read and write the data, then pick a database that serves that shape well.

The `conclusion` in the RESULT line is built from the measured numbers and the checks, so it reports what this run actually found (including "inconclusive"), even if that differs from what we expected above.

## Limits (read before quoting numbers)

- **This is a simulation of data modelling trade-offs, not a product benchmark.** It shows the shape of the effect, not production numbers. It does not compare PostgreSQL, MySQL, MongoDB, DynamoDB or any other product. Real document databases have their own storage formats, indexes and partial-update operators, and real SQL databases have caches, disks and network trips that this lab leaves out.
- It runs in memory, in one process, on one machine. Timings are for that machine only. Expect different absolute numbers on every machine, but the same direction.
- "Bytes written" is logical content: the JSON text of each rewritten document, or the rewritten product row (8 bytes per integer plus the name). It is not disk pages, WAL or index writes.
- At 100,000 users the report and rename may get only a few samples. Check the sample counts in the RESULT metrics and `results.json` before quoting a ratio.
- The rename picks the most popular product on purpose, to show the cost of copying data. A rarely bought product would touch far fewer documents.
- The document shape here has no secondary index on product, so finding copies means a scan. A real document store could add one, which speeds up the search but not the rewrites.
- Normalized data can be made faster for the profile load (for example with a cache or a view), and documents can store product IDs only. Those are design choices that move the trade-off. They do not remove it.
