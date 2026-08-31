# Releases

## v11.0.0 — Pay decides the order (2026-08-31)

Ranking never looked at pay. `scoreOne()` blended description fit with
win-likelihood, and the salary rule was a gate that a posting with no published
band passed as "unknown". The list that came out put an unpriced 83% match at
the top and a confirmed $280k-$300k posting at 59%, which is the opposite of
what a floor is for.

Pay is the primary sort key now.

### A pay lane on every row

`payTier()` reads the published START of a band and never the top: a $300k
ceiling with no floor stated is still unknown. Lane 1 is a confirmed $180k or
above, lane 2 is unpublished, lane 3 is a confirmed $160-180k. A start under
$160k fails the gate and gets no lane. Best match sorts by lane, then by score,
with a divider naming each group.

As deployed: 62 postings in lane 1, 211 in lane 2, 35 in lane 3. The rendered
page shows 60 / 176 / 33 -- the difference is rows carrying `posting-closed`,
which `onTheList()` hides.

### The $160-180k lane is reachable

The gate used to reject any posting whose published TOP was under $180k, so a
band advertised as $165k-$175k was dropped and the second lane could only ever
hold ranges that also reached $180k+. A published start under $160k still fails,
and a top published with no start still fails when it is under $160k. Everything
between is a lane, not a reject.

Rows skipped under the retired rule were re-examined by `ingest/regate.mjs`,
which re-runs the WHOLE gate with the cached description rather than the one
rule that changed. Reversing a rejection by re-checking a subset of the rules
that made it silently reverses whatever the subset cannot see. One row came
back; one stayed out because its start is $124k.

### Employers can be blocked by name

`ingest/blocked-employers.json` is read by the gate before anything is measured,
and it is committed so the twice-daily pipeline enforces it too. A block that
lives only in the database is undone by the next ingest. Coinbase is the first
entry. Its 8 open rows are skipped with rank and lane cleared; the one row
already submitted keeps its history untouched.

### "Unpriced" is provable

A salary miss used to write nothing, so a row that had been crawled and
published no band looked identical to one nothing had ever fetched. 223 rows
were in that state. `salary_checked_at` records a successful fetch whether or
not a band was found.

### The sweep stopped throwing bands away

`postingText()` returned the board API's text and never looked at the page,
which is where many employers put the number. Measured over the same 810 rows:
board-API-first found 195 bands, page-first 230, and reading the page when the
board text has no band finds 271.

### A failed gate clears the score

A band written after ranking used to leave the old `rank_pct` sitting on a row
the gate would now reject. 58 rows were like that, one still showing 83% on a
posting paying $135-155k. `rankWrite()` nulls `rank_pct` and `pay_tier` in the
same statement, and every rank write is parameterised instead of concatenated.

### Defects found while reviewing this change

`daily.mjs` called `rankWrite(s)` with the bare `scoreOne()` result, which
carries no job, so every write in the twice-daily pipeline threw
`TypeError: Cannot read properties of undefined (reading 'dedupe_key')` into a
catch that only incremented a counter. It would have ranked nothing and reported
a clean run.

`fit-score.mjs` reached the schema migration through
`await import('./salary-sweep.mjs')` from inside its own top-level CLI block.
salary-sweep imports fit-score, so the await never settled: the first `--write`
run printed "Detected unsettled top-level await" and wrote nothing. The
migration moved to `ingest/pay-columns.mjs`, which imports neither.

An adversarial review of the diff found seven more: the sweep wrote a band
without moving the row's lane, a below-floor rule-out left the old rank behind,
`fetchSucceeded` was a denylist so `page-502` and `page-429` stamped a check
that never happened, row counters incremented on an UPDATE that changed nothing,
`--write` without a token exited 0, the migration could not read the Workers
result shape, and un-tiered rows rendered under the previous lane's heading.

Every one has a regression test that fails when the fix is reverted.

### Verification

- `ingest/test-pay-tier.mjs`: 105 assertions, `ingest/test-employer-block.mjs`: 39,
  0 failures, including a block that requires the retired rank-only sort to FAIL
- all ten ingest and apply suites green, both new suites wired into CI
- production screenshotted at 375 and 1280 in both themes, 0 console errors
- restore point `backups/jobs-20260831T163557Z.{json,sql}`, verified by
  restoring it, not merely by writing it
