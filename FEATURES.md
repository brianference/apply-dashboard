# Features and their test coverage

A running list of what this product does and what actually proves each part
works. It exists so a gap is visible rather than assumed: a row with no test
named against it has not been checked, and saying so is the point.

Update this in the same commit as the feature. `node tests/check-coverage.mjs`
fails when a test named here does not exist on disk, so the table cannot quietly
drift away from reality.

**Automated** names a file that runs and exits non-zero on failure.
**Seen** means a rendered screenshot of the deployed page was opened and looked
at, which is the only thing that catches layout. Both matter; neither replaces
the other. Three defects in this repo passed every assertion and were caught
only by the screenshot: a page that rendered blank under a working header, a
dead gap in the mobile invitation, and a portfolio showing another person's
projects.

## Job pipeline

| Feature | Automated | Seen | Notes |
|---|---|---|---|
| Read employers' boards twice a day | `ingest/test-sync.mjs` | n/a | 269 companies in `ingest/companies.json`, plus eight source modules in `ingest/sources/` |
| Rank a posting against the resume | `ingest/test-fit.mjs` | n/a | Inverse document frequency over the cached descriptions |
| Read a description from Workday, Himalayas, JSON-LD or the page, not only three board APIs | `ingest/test-jd-read.mjs` | n/a | 145 of 315 queued rows had never been read because `fetchJd` stopped at greenhouse/ashby/lever. LinkedIn is blocked-by-policy (never fetched). Lever 404 is posting-closed, not a retry. JSON-LD is a real Jobspresso payload, including array, @graph, and a malformed block beside a good one. Workday matcher covers all 11 live URLs with and without a locale segment. USD YEAR salary is taken; EUR and HOUR are refused. A future datePosted clamps. Board API still wins over JSON-LD. Known-bad: a temp copy of each tier is required to fail |
| Location and role eligibility | `ingest/test-location.mjs` | n/a | Remote or Arizona, product roles only. Product success is customer success, not product management; a PM who owns a success product still passes |
| Pay floor rules a posting out | — | — | **Gap.** `ingest/salary-sweep.mjs` has no test of the write loop. The extractor and floor cases live in `ingest/test-fit.mjs` |
| Double-escaped Greenhouse HTML still yields the published band | `ingest/test-strip.mjs` | n/a | Real MongoDB 8143805 pay block through `strip()` then `salaryFromText`. Singly-escaped and clean HTML too, so the fix cannot be a special case. Block headings cannot fuse into "Job Site"; inline spans still collapse into one range. Known-bad: the old decoder against a temp copy is required to fail |
| A published band cannot be left unpriced | `ingest/test-salary-audit.mjs` | n/a | Fails the twice-daily run when the cached JD has a recoverable band and the row does not. Passes when the salary is stored. An unread cache is not a fail |
| Ashby structured compensation is a published band | `ingest/test-salary-ashby.mjs` | n/a | Teamworks payload: description silent, `summaryComponents` carries 90000-120500. Equity/bonus-only, non-USD, and hourly are refused. Structured wins over a different number in the description. The audit fails when that feed published a band and the row stores none |
| Pay-first ranking | `ingest/test-pay-tier.mjs` | n/a | Confirmed $180k+ first, then unpublished, then $160-180k. A $180k start at rank 59 beats an unpriced 83. A failed gate clears `rank_pct` and `pay_tier`. Known-bad block runs the retired rank-only sort and requires it to fail |
| Pay in the rank percentage | `ingest/test-pay-rank.mjs` | n/a | Percentile of published start is 25% of the headline. Unpriced takes the median, 50. A missing distribution is 50, not 0. Unread descriptions stay `success * 0.6` and ignore pay. Known-bad: a temp copy with one weight changed is required to fail |
| Off-focus domain penalty | `ingest/test-off-focus.mjs` | n/a | Marketing costs 25 points; product marketing is excluded outright as a different family |
| Healthcare, construction, clearance, risk-compliance and hardware excluded | `ingest/test-domain.mjs` | yes | Healthcare, construction and hardware are read from the DESCRIPTION. Risk-compliance is title-only, because searching the description would treat legal boilerplate as the job. URLs are stripped before any pattern is matched -- TLDR's only "silicon" sat inside an inc.com URL. Hardware fixtures: vCluster (ruled out), Camunda one bare-metal deployment target (kept), Vultr four weak cloud-SKU mentions (kept), silicon only in a URL (kept). Submitted compliance rows are not rewritten |
| Advanced search puts them back | — | yes | **Gap.** Switches are covered by a browser check that is not yet in the repo |
| Reading a description from a non-board host | `ingest/test-jd-read.mjs` | n/a | Tiers: board APIs, Workday CXS with the locale optional, the Himalayas feed, JSON-LD JobPosting, then page text. Blocked hosts are never FETCHED, asserted on the call not the result. Every tier caches by URL hash, with a default directory, or the coverage number moves between runs |
| Re-verifying a closed posting | `ingest/test-closed-check.mjs` | n/a | A bare HTTP 200 is LIVE, not gone: an uncommitted script had written "HTTP 200 -- the posting is gone" on 27 rows and retired 10 real ones. A 403 or a network error is unknown, never gone, and a wrongly-retired row is worse than a wrongly-kept one |
| Live duplicates already in the queue | `ingest/test-dedupe-queue.mjs` | n/a | The normalised company+title comparison CRITERIA.md describes only ran seconds before a submission, so duplicate pairs sat queued and applyable. `sameJob()` is shared by the ingest guard and the retroactive sweep so the two cannot drift apart |
| Blocked employers, second-lane reopen, and the queued full-gate pass | `ingest/test-employer-block.mjs` | n/a | A blocked employer is skipped before anything is measured, a `submitted` row is left alone because it is history, and re-checking a reject with a subset of the rules that rejected it must not reverse it. The queued pass re-runs the whole gate over every queued row so a rule added today reaches rows that are already there (Teamworks product-success). An unreadable description is unknown, not a skip |
| A cached board index expires | `ingest/test-index-freshness.mjs` | n/a | `gh-index.json` was written once and reused for seven days, so every Greenhouse posting published in between resolved to no board and arrived with no description, no salary and no domain rules. A future or unreadable mtime is refused rather than trusted |
| Employer refresh date stored next to first-published | `ingest/test-board-dates.mjs` | n/a | `posted` is first published. `refreshed_at` is last updated. Greenhouse does not fall posted back to `updated_at`. Ashby `updatedAt` falls back to `publishedAt`. Lever converts epoch ms. Empty is null, not a guess |
| Missing posted/refresh dates backfilled from the board URL | `ingest/test-date-backfill.mjs` | n/a | Resolves by URL (`boardRef`), never the source label. Will not overwrite an existing `posted` with a refresh date. `--dry` default |
| A greenhouse/ashby/lever row cannot ship without `refreshed_at` | `ingest/test-refresh-audit.mjs` | n/a | Fails the twice-daily run when a dated-board URL on the list has no refresh date. A LinkedIn URL with no date is not a fail. Empty string is missing |
| Apply queue ordering | `apply/test-order.mjs` | n/a | Carries a known-bad block that runs the retired comparator and asserts it fails |
| Stat tiles match their rows | `apply/test-counts.mjs` | yes | Runs against production in CI |
| Resolve an aggregator link to the employer's form | `ingest/test-resolve-by-board.mjs` | n/a | |

## Accounts

| Feature | Automated | Seen | Notes |
|---|---|---|---|
| Register through the API | `tests/third-party-signup.mjs` | n/a | Checks the ROW, not the status code: registration answers 200 either way so it cannot leak which addresses exist |
| Register through the real form | `tests/browser-signup.mjs` | yes | 24 checks, drives the browser |
| Password minimum of 15 characters | `tests/browser-signup.mjs` | yes | Refused before anything is sent, and no row is written |
| A duplicate address cannot be detected | `tests/browser-signup.mjs` | n/a | Byte-identical message, no second row |
| Activation link signs them in | both signup tests | yes | |
| Sign-in refused before activation | `tests/third-party-signup.mjs` | n/a | |
| Password reset by email | `tests/third-party-signup.mjs` | partial | The link is exercised; inbox delivery is confirmed in Brevo's log, not here |
| Registration rate limit | `tests/browser-signup.mjs` | n/a | 5 per hour per IP; a burst of 7 is checked to create fewer than 7 |
| The header identity is the caller's own | `tests/browser-signup.mjs` | yes | Added after `/api/auth/me` was found reading `WHERE id = 1` and handing every stranger the owner's name and photo |
| Sign-in panel stays inside the viewport | `tests/header-panel.mjs` | yes | At 320px the header wraps and a panel anchored to `.tools` hung off the left edge. Known-bad: reverting the two positioning lines fails with a negative x at 360/390/412 |
| Origin-checked writes | — | n/a | **Gap.** Verified by hand with curl; no test file |

## The list

| Feature | Automated | Seen | Notes |
|---|---|---|---|
| Signed-out preview of the job list | `tests/third-party-signup.mjs` | yes | |
| Signup invitation above the full-time table | `tests/promo-strip.mjs` | yes | Both widths, including the mobile gap that assertions missed |
| Marking a job is private to the account | both signup tests | n/a | The shared row is re-read afterwards and must still say `queued` |
| Header search and the `/` shortcut | — | yes | **Gap.** Verified by screenshot only |
| Filter chips | — | yes | **Gap.** No test |
| Posted column (age in days) | `tests/posted-filter.mjs` | — | "today", "Nd ago", or an em-dash. No-date rows sink in both sort directions. Newest sorts on `posted`, not crawl time |
| Role and Company as two resizable columns | `tests/column-split.mjs` | - | Asserts the header and rows share one grid (a mismatch shifts every column sideways and throws nothing), that the company is not in both cells, and that dragging the grip actually widens it |
| Marketing products ruled out, not de-ranked | `ingest/test-off-focus.mjs`, `ingest/test-domain.mjs` | n/a | Was a 25-point penalty, which left Marketing Pro at 41% and top of the $165k-this-week view. Decided on the title; marketing in a description rules nothing out; Marketplace and Supermarket must not match |
| Quick filter: $165k+, posted within a week, ranked | `tests/quick-filter.mjs` | - | Checks all three separately, and requires the TOP row to hold the highest score in the set. Best match orders by pay lane first, so under it the top row reads 74 while the set holds an 82 |
| The whole suite in one command | `tests/run-all.mjs` | - | Discovers test files rather than listing them, and FAILS on any test file it does not classify. Six suites were added in one day and each had to be wired into CI by hand; a test nobody runs is worse than no test |
| The column-filter popup on a phone in desktop mode | `tests/column-menu.mjs` | - | Clamped on both axes, height capped so Apply and the checkboxes stay on screen, and no autofocus on a coarse pointer -- the focus is what raised the keyboard over it |
| Leadership roles hidden behind a pill | `tests/leadership-filter.mjs` | - | Director, Head of Product, VP and CPO off the default list. The test writes its own pattern rather than importing the page's, and floors the pill count, because a regex whose escapes were eaten matches nothing while every count still agrees with its own empty row set |
| Clear all filters, and the Over $180k chip | `tests/clear-filters.mjs`, `apply/test-counts.mjs` | — | The button counts what it will clear and is disabled at zero. The test asserts the column filter actually engaged before checking it was cleared, and every numbered chip must equal the rows it reveals |
| Posted-within toolbar filter | `tests/posted-filter.mjs` | — | Not persisted. Unknown dates do not survive a window. The hidden-count note must add up. Local drive via `tests/serve-local.mjs` |
| Stale lens (over 30 days, unless refreshed) | `ingest/test-stale.mjs` | n/a | 31d posted + 2d refresh is kept (Pinterest). 31d + 40d refresh is hidden. Unknown refresh is kept -- ingest missing a field must not hide the row. No posted date is kept. Exactly 30 days is kept (`>` not `>=`) |
| Over 30 days chip | `tests/stale-filter.mjs` | — | Hidden by default. Chip count equals the rows it reveals, counted from the same array. Posted title includes the refresh date when the row is kept because the employer touched it. Local drive via `tests/serve-local.mjs` |

## Onboarding

| Feature | Automated | Seen | Notes |
|---|---|---|---|
| First-run spotlight tour | `tests/tour.mjs` | yes | Five steps at 1280 and 390; the overlap check was confirmed to FAIL when the popover is forced onto the cutout |
| Runs once per account | `tests/tour.mjs` | yes | `profile.tour_seen_at`, marked on finish or skip, never on open |
| Replay from the account menu | `tests/tour.mjs` | yes | Does not re-mark seen |
| `POST /api/tour/seen` is guarded | — | n/a | 401 without a session and 403 on a bad origin, both checked by hand against production |
| Step screenshots | `tests/tour-shots.mjs` | yes | Regenerates every step at both widths |
| The tour's buttons never scroll away | `tests/tour-overflow.mjs` | yes | Forces the body to overflow and checks the action row is still inside the popover and clickable. Confirmed to FAIL on the CSS that shipped in v13 |

## Profile and portfolio

| Feature | Automated | Seen | Notes |
|---|---|---|---|
| Private profile, own row only | `tests/browser-signup.mjs` | yes | |
| Photo upload, resized in the browser | — | yes | **Gap.** No test; the CSP `blob:` failure was found by hand |
| Custom portfolio address | `tests/portfolio-addresses.mjs` | yes | Shape, reserved words and collision are enforced server-side |
| `/portfolio/<handle>` serves the page | `tests/portfolio-addresses.mjs` | yes | Both with and without a trailing slash |
| A portfolio shows only its own account | `tests/portfolio-addresses.mjs` | yes | Name, resume text AND the project list |
| Contact details never reach a public page | `ingest/test-profile-parse.mjs`, `tests/portfolio-profile.mjs` | yes | Email and phone are stripped from about, role paragraphs and JSON-LD. Known-bad: a temp copy that puts `email` on Person is required to fail |
| Resume parse of the real grammar (prose, no bullets, Mon YYYY to Present) | `ingest/test-profile-parse.mjs` | n/a | Role count, title, location, start, and `end` null for a current role. A bullet resume still parses. Unknown headings survive as `extra`. Known-bad: bullet-only splitter, `YYYY - YYYY` dates, dropping extra, storing Present |
| A saved profile edit survives a re-parse | `ingest/test-profile-parse.mjs` | n/a | Parse, edit a title, re-parse, merge: the edit is still there. Known-bad: a merge that returns the parse is required to fail |
| Reorder writes the stored order, not just the DOM | `ingest/test-profile-parse.mjs`, `tests/portfolio-profile.mjs` | n/a | `moveItem` returns a new array; the editor PUT body has the swapped titles. Known-bad: a no-op splice is required to fail |
| A section hidden on the profile is absent from the portfolio HTML | `ingest/test-profile-parse.mjs`, `tests/portfolio-profile.mjs` | n/a | Not `display:none` -- the key is omitted from the public JSON and the heading is not in the HTML. The visible case still renders, so hiding is not "never draw". Known-bad: always sending experience is required to fail |
| Print stylesheet: the page is the virtual resume | `tests/portfolio-profile.mjs` | n/a | `emulateMedia({ media: 'print' })`: nav `display:none`, body background white even in dark theme. Known-bad: a temp copy of the CSS without `@media print` is required to fail |
| JSON-LD Person with alumniOf and worksFor | `ingest/test-profile-parse.mjs`, `tests/portfolio-profile.mjs` | n/a | One `application/ld+json` object, `@type` as a string, no email or telephone keys |
| The owner's projects still render | `tests/portfolio-addresses.mjs` | yes | A fix that hid them from everyone would pass every other check |

## Pages

| Feature | Automated | Seen | Notes |
|---|---|---|---|
| About, Terms, Privacy, Contact | — | yes | **Gap.** Word and section counts were measured once by hand |
| Footer on every page | — | yes | **Gap.** |
| Light default, dark on toggle | — | yes | **Gap.** No automated theme check |

## Known gaps, gathered

The rows marked **Gap** above, in one place, so they can be worked through:

1. The pay floor has no test, and it is the rule that decides what is shown.
2. The advanced-search switches are verified by a browser run and a screenshot, but that check is not yet a file in `tests/`.
3. Header search, filter chips, theme toggle and the legal pages are verified by
   screenshot only.
4. Origin-checked writes and photo upload are verified by hand.

## Running them

```bash
CF_D1_TOKEN=<token> node tests/third-party-signup.mjs
CF_D1_TOKEN=<token> node tests/browser-signup.mjs
node tests/promo-strip.mjs
node ingest/test-profile-parse.mjs
node tests/portfolio-profile.mjs
node tests/portfolio-addresses.mjs
node tests/check-coverage.mjs
node tests/tour.mjs
node tests/tour-overflow.mjs --site http://127.0.0.1:8798
node tests/serve-local.mjs
node tests/posted-filter.mjs http://127.0.0.1:<port>
node tests/stale-filter.mjs
node apply/test-counts.mjs http://127.0.0.1:<port>
node tests/header-panel.mjs http://127.0.0.1:<port>
node ingest/test-strip.mjs
node ingest/test-salary-audit.mjs
node ingest/test-salary-ashby.mjs
node ingest/test-domain.mjs
node ingest/test-stale.mjs
node ingest/test-board-dates.mjs
node ingest/test-refresh-audit.mjs
node ingest/test-date-backfill.mjs
node ingest/test-jd-read.mjs
```

The browser tests need Playwright, which this repo does not depend on. It is
linked in from a sibling checkout rather than installed here, so `node_modules`
may contain junctions: never `rm -rf` it without checking, or the delete follows
the link and takes the real install with it.

The two signup tests create a throwaway account and delete it again. They clear
their own registration attempts first, because the limiter would otherwise
refuse them silently and every later step would fail for a reason that has
nothing to do with the product.
