# Releases

Started at v14.0.0; earlier releases are in the git tags.

## v15.2.0 — Risk/compliance and product-success rules actually run (2026-09-02)

Brian: risk and compliance roles are boring. The posting that prompted it was
Jobgether's "Product Manager - Risk Compliance" sitting in the queue at 73%.
A rule that lives in CRITERIA.md and not in the gate is not a rule, so this
one lands in `domainSignals` with the healthcare / construction / clearance
machinery, with tests in both directions, and it is applied to rows already
queued.

### Title, not description

`ingest/domain-eligible.mjs` already searched title, company AND description.
That is right for healthcare ("Parsley Health"). It is wrong for compliance:
nearly every posting mentions it in legal boilerplate, and HIPAA on its own
already ruled out Vanta. The new domain reads the title for `\brisk\b`,
`\bcompliance\b`, `\bregulatory\b`, `\bgrc\b`, and "governance, risk".
Standalone "governance" is not in the pattern, so Webflow's "Staff Product
Manager, Governance" stays.

It is switchable. `TOGGLEABLE_DOMAINS` and the `DOMAIN_LABELS` badge in
`index.html` name it "Risk and compliance", the same way the others work.

`ingest/regate.mjs` did not apply new domain rules to queued rows. It blocked
employers and reopened retired salary skips. A third pass now re-runs
`domainSignals` on every queued row. Submitted rows are history: Coinbase
"Group Product Manager, Compliance Agent Experience" and Vanta "Senior
Product Manager, GRC Platform" are left alone, and the write refuses
`status = submitted` even if the caller forgets to filter.

### Product success is not product management

Teamworks "Senior Product Success Manager I (Nutrition, Pro)" was passing
`roleEligible` because IS_PRODUCT's `product ... manager` window matched it.
`product success` is now in NOT_PRODUCT, which is tested first. "Customer
Success Manager" stays out. "Senior Product Manager, Success Platform" stays
in -- a product manager who owns a success product is a product job.

### Verification

- `ingest/test-domain.mjs` rules out the three live titles as
  `risk-compliance`, keeps Webflow Governance, keeps a clean title whose
  description talks about regulatory requirements, keeps a clean product
  posting, and asserts submitted rows are not in the write list. Known-bad:
  a temporary copy with the title rule reverted is required to FAIL on those
  assertions.
- `ingest/test-location.mjs` rejects the Teamworks title and Customer Success
  Manager, and keeps "Senior Product Manager, Success Platform".
- `ingest/regate.mjs` dry-run reports the queued domain hits and writes
  nothing.

## v15.1.0 — Sign-in panel stays on a 320px phone (2026-09-02)

On a 320px phone the header wraps: the brand takes the first row and the
theme plus Sign in controls drop to a second row about 126px wide, sitting
on the left. The sign-in panel was `position: absolute; right: 0` against
`.tools`, so a 296px panel started around x=-158. Brian's screenshot showed
only the right half -- the Show toggle, the submit button, and a cut-off
"Forgot password" -- with the `.why` line clipped to "...ions and outcom...".

At 360px and above the tools stay on the brand's row and the panel already
fitted. The break is the wrap, which needs 344px.

### The panel is anchored to the header row

`header.site .top` is now `position: relative` and `header.site .tools` is
`position: static`. Nothing else was using `.tools` as a containing block:
the only other `position: absolute` in the file is `.pw-toggle`, which
hangs off `.pw`. `top: calc(100% + 8px)` now measures the whole header row,
so on a wrapped header the panel drops below the search field rather than
overlapping it. On desktop that shifts the panel down slightly; screenshots
in `screenshots/v15.1/` confirm it still reads as attached to Sign in.

While in the file, the unscoped `.brand img` inside `@media (max-width:
720px)` is now `header.site .brand img`. A bare class here is how `.panel`
once blanked the profile page. This rule lost to the more specific 80px
header logo rule, so the 48px size never applied where it was meant to,
and it was one cascade reorder away from shrinking the job-list masthead
mark, which uses the same class.

### Verification

- `tests/header-panel.mjs` drives the local build through
  `tests/serve-local.mjs`. At 320, 360, 390, 412 and 1280, signed out, it
  opens the panel and requires the panel, the email field, the password
  field, the Show toggle and the submit button to sit fully inside the
  viewport, with `scrollWidth <= innerWidth` so a sideways scroll cannot
  hide the same bug.
- Known-bad: a throwaway copy with the two positioning lines reverted is
  required to FAIL with a negative x. It failed at 360 (`x=-20.36`),
  390 (`x=-21.16`) and 412 (`x=-20.36`); 320 on that copy stayed
  non-negative because the newly-scoped 48px header logo stopped the
  wrap. Production at 320 with the 80px logo still measured `x=-158`.
  The real build is required to pass at all five widths.
- `tests/posted-filter.mjs` and `apply/test-counts.mjs` pass against the
  local build. `tests/tour.mjs` (its own worktree server),
  `tests/promo-strip.mjs` (production, its default) and
  `tests/check-coverage.mjs` also pass.
## v15.1.0 — Never lose a published salary (2026-09-02)

A posting that publishes a band must never end up on the list with no band.
Losing one is worse than showing nothing: the pay lane treats "no band" as
unknown, not low, and floats the row above priced postings it should sit
below.

Greenhouse returns its pay-transparency block double-escaped. `strip()` took
off the real tags and left the escaped ones, so `salaryFromText` saw $126,000
and $248,000 ninety-odd characters apart and returned null. Decode once and
the separator is still the literal entity `&mdash;`, which the extractor does
not treat as a dash. MongoDB job 8143805 is the measured case
(https://boards-api.greenhouse.io/v1/boards/mongodb/jobs/8143805?content=true).

Of 31 queued Greenhouse rows carrying no salary, a working decoder finds a
published band on 19. Only 4 genuinely publish nothing; 8 could not be
fetched because the probe guessed the board token. Of the 19, 13 clear the
$180k floor and 6 start under $160k, so those 6 must be ruled out by the
existing gate once their band is known. Brian's own 76% MongoDB row is one
of the 6.

`salaryFromText` itself is correct. Fed the real sentence with `-`, `–`, `—`
and ` to ` as separators it returned 126000/248000 every time. The extractor
was not changed.

### The decoder

`strip()` in `ingest/fit-score.mjs` now decodes named and numeric entities
and strips tags until the text stops changing, with a hard cap of 8 so a
pathological input cannot spin. `&amp;` is last in each pass, or `&amp;lt;`
becomes `<` a pass early and the loop thinks it is finished. mdash and ndash
become a hyphen so the range separator survives as something the extractor
already reads.

Closing block tags (`p`, `div`, `li`, `ul`, `ol`, `h1`-`h6`, `tr`, `td`,
`section`, `header`, `footer`, `article`) and `br` become a period before
the remaining tags are removed, so two headings cannot fuse into a phrase
a domain rule will match. Instacart "Senior Product Manager, Retailer
Platform" (Greenhouse 8014060) was ruled out as construction because
`<h2>About the Job</h2>` next to a "Site Theming" block became "Job Site".
Inline tags still collapse to a space, or a band published as
`<span>$126,000</span><span>-</span><span>$248,000</span>` would stop
being a range.

### Ashby structured pay

Ashby does not put pay in the description. It publishes it as structured
`compensation` and only when the board feed is requested with
`?includeCompensation=true`, which we never passed. Teamworks "Senior
Product Success Manager I (Nutrition, Pro)" is 5857 characters of
description with zero dollar figures, while
`compensation.summaryComponents[0]` carries Salary / 1 YEAR / USD /
90000-120500. Of 37 queued Ashby rows with no stored salary, 17 publish
structured pay that way.

`fetchJd` now requests that flag and caches the compensation object next
to the description. The reader takes the band from `summaryComponents`,
falling back to `compensationTiers[].components[]`, using the component
whose `compensationType` is Salary. Equity and bonus are ignored. Hourly,
weekly and monthly intervals are refused, not multiplied into an annual
figure: converting $85/hour with a 2080-hour year invents a number the
employer did not publish. Non-USD is refused the same way. Structured
numbers win over anything parsed out of the description.

`salary_source` is `ashby:compensation` for this path, not `posting:daily`
or `posting:recover`. A band read from a structured field and a band
scraped out of prose have different failure modes and must not look the
same afterwards.

The salary audit fails the run when an Ashby posting whose feed published
structured pay is about to go out with nothing stored. `salary-recover.mjs`
recovers those rows the same way it recovers a Greenhouse description
band, re-runs the gate, and leaves `submitted` rows alone.

### An audit that fails the run

`ingest/salary-audit.mjs` re-reads the cached descriptions after
`ingest/daily.mjs`. If any row still on the list has no salary and the cache
has a recoverable band, it prints those rows and exits non-zero. A rule that
only lives in a comment is how 19 rows lost their band without anyone
noticing. Wired into `.github/workflows/daily-jobs.yml`. It reads
`ingest/out/jd-cache/`, not the internet -- a CI refetch would fail for
network reasons and look like a decoder bug, or pass because a refetch
succeeded while ranking had used a stale file.

### Recover the rows already in the database

`ingest/salary-recover.mjs` walks every queued row with no stored band,
fetches through the existing `fetchJd` (so board-token resolution is the one
the pipeline already trusts), writes `salary_source = posting:recover`, and
stamps `salary_checked_at` alone on a description that genuinely publishes
nothing, so "checked, publishes nothing" stops looking identical to "never
checked". It then re-runs the full gate the way `ingest/regate.mjs` already
does, so a start under $160k clears `rank_pct` and `pay_tier` rather than
leaving a stale score. `--dry` is the default; `--write` applies.

### Verification

- `ingest/test-strip.mjs`: the real MongoDB pay block, a singly-escaped
  block, clean HTML, `&amp;lt;` decode order, a posting with no band, a
  deeply nested input that must terminate, adjacent headings that must not
  produce "Job Site", and inline spans that must still read as 126000/248000.
- `ingest/test-salary-audit.mjs`: fails when a band is recoverable and the
  stored salary is null, passes when the salary is stored. An audit that
  cannot fail is not an audit.
- `ingest/test-salary-ashby.mjs`: the real Teamworks compensation object
  with a silent description, equity-only, bonus-only, CAD, hourly, no
  compensation object, structured-wins-over-description, and the audit
  failing when that feed published a band and the row stores none.
- Known-bad: a temporary copy with the old `strip()` is required to FAIL
  those assertions. Restoring the decoder is required to pass. A temporary
  copy whose Ashby reader always returns null is required to FAIL the
  structured-pay assertions.
- The rest of the rule suite still passes: location, fit, pay tier, employer
  block, sync, domain, off-focus, resolve-by-board, apply order, the resume
  self-check, and `tests/check-coverage.mjs`.

## v15.0.0 — Posted date on the list (2026-09-02)

The list had no posting date. `updated_at` is the last crawl, and the pipeline
rewrites every row twice a day, so the "Newest" sort ordered by which row the
crawler happened to touch last. It has never once ordered by how new the job is.

Of the live non-skipped rows, 323 carry a `posted` value (a calendar day or a
full ISO timestamp) and 160 do not. The nulls sit on the older capitalised-source
rows. Every current lowercase ingest source writes one.

### A Posted column

Desktop gets a column between Pay and the action, showing "today", "Nd ago", or
an em-dash when the board publishes no date. Age is whole days against local
midnight so a posting from earlier today is "today", never "-0d", and a future
start date clamps to "today" rather than a negative number. On a phone the
column is hidden and the same string sits inside `.who` as `.mago` -- a sibling
inside `.meta` becomes a seventh grid item on desktop because `.meta` is
`display: contents`, which already shoved the action column off the row once.

The column is filterable and sortable. No-date rows sink in both sort
directions. Newest now sorts on `posted`, with no-date last, then `rank_pct`.

### Posted within

A toolbar select next to sort: any time (default), past day, 3 days, 5 days, or
a week. It ANDs with the chips, the search box and the column filters. It is
not written to localStorage -- a window that survives a reload hides most of
the list with no visible cause. A row with no date does not survive a window:
unknown is not recent. When a window is on, a note under the toolbar says how
many rows it removed and how that splits between older postings and boards that
publish no date. Those counts come from the same filtered set the rows are
drawn from.

The four stat tiles still count the whole live list. They answer what is on the
list, not what is on screen.

### Verification

- `tests/posted-filter.mjs` drives the local build through `tests/serve-local.mjs`
  (static files from `.deploy`, `/api/*` proxied to production). Cell shape,
  each window, monotonic counts including the strict `rows(7) < rows(any)` that
  fails if the select is wired to nothing, the hidden-count note adding up, and
  the 375/1280 mago swap.
- Known-bad: a temporary copy with the window filter skipped is required to
  FAIL; restoring it is required to pass.
- `apply/test-counts.mjs` still passes against the local build with the extra
  column present.
- Every rule suite ran green: location, fit, pay tier, employer block, sync,
  domain, off-focus, resolve-by-board, apply order, and the resume self-check.
  `tests/tour.mjs`, `tests/tour-overflow.mjs`, `tests/promo-strip.mjs` and
  `tests/portfolio-addresses.mjs` also pass against the local build.
- `tests/check-coverage.mjs` was failing before this release on a gap that had
  nothing to do with it: `ingest/test-employer-block.mjs` existed on disk and
  FEATURES.md never named it, so the employer-block rule had no recorded owner.
  FEATURES.md names it now and the coverage check is green.
- Looked at, not inferred: `screenshots/v15/` carries the desktop table in both
  themes, the 3-day window engaged, and the phone rows where the age sits at the
  START of `.who` so a long company name cannot ellipsis it away.

### One red result, and it was not this release

`tests/browser-signup.mjs` timed out clicking `.chip-btn` after fourteen
assertions had already passed, reporting `<body> intercepts pointer events`. It
is not in CI, so nothing had run it since the spotlight tour shipped, and the
convenient reading was that the new column had broken the header.

It had not. A probe against a real throwaway account on production found
`#tour-root` open with its stage at `position: fixed; z-index: 80;
pointer-events: none` -- the tour, doing exactly its job for a brand new
account, which is precisely who it is for. The hit test falls through a
`pointer-events: none` stage and lands on the body. `git diff da35d7f..HEAD`
touches no file under `web/` or `functions/`, and `.chip-btn` exists only in
`web/shared/site-nav.js`, `site-nav.css` and `tour.js`.

The test now presses Escape before driving the account menu, which is the
tour's own documented way out and is asserted in `tests/tour.mjs`. All 24
assertions pass against production, including the rate limiter biting at 3 of 7.

## v14.0.0 — Pay decides the order (2026-08-31)

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

The page hid them too. `meetsFloor()` decided on the band's TOP while the lane
decides on its START, so a $160k-$170k posting was filtered off the default list
and the Full-time tile counted a row the list refused to draw -- caught by
`apply/test-counts.mjs` in CI, at tile 270 against 269 rows. It reads the start
now, and the `Under $180k` chip has its own predicate instead of being the
inverse of what the list contains.

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
