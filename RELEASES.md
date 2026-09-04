# Releases

Started at v14.0.0; earlier releases are in the git tags.

## v23.0.0 - Seven postings stored twice, and a board that was never 403 (2026-09-04)

### The duplicates

`decide()` in sync-to-d1.mjs stops NEW duplicates on three signals. Nothing
ever cleaned up the rows that entered before those guards, so seven postings
were sitting in the database twice, and one pair had reached SUBMITTED twice --
the duplicate application the whole rule exists to prevent.

Three of the shapes still get past `sameJob` today. A second board appends the
employer to the title ("Staff Product Manager - Enterprise AI - Twilio"). A
title picks up a double space. And one employer is written two ways, "Kin" and
"Kin Insurance", which is named in sync-to-d1's own comment as the motivating
case and is still not caught, because the company strings differ.

Grouping is by NORMALISED URL, which is the one signal that stays unambiguous
when the company name does not, and a tracking parameter does not make it a
different job. The kept row is the submitted one, then the one carrying a band
and a date, so collapsing never throws away the only copy of something.

Where BOTH rows of a pair are submitted, it reports and changes nothing. Two
real applications happened, and choosing which one to erase is not a decision
code should make. Rows are marked, never deleted, so an outcome or an
experiment arm pointing at one still resolves.

`sameJob` also strips a trailing employer name now, so the appended shape is
caught before a second row is ever written. It refuses to strip a title down to
nothing, which would make every posting at one employer identical, and it
leaves an employer name that sits in the MIDDLE of a title alone.

### WeWorkRemotely was never unreadable

Ten queued rows pointed at weworkremotely.com and not one had ever had a
description read. The posting page answers 403 to anything that is not a
browser, so the reader gave up. Its category RSS feeds answer 200 and carry the
whole description, around 10KB an item. The text was always available; the
reader was looking in the wrong place.

Six of the ten are in the feeds, and recovering one of them turned up a
published $165,000-$180,000 band that had been invisible. The other four have
aged out, and a feed is a rolling window with no archive, so an aged-out
posting comes back UNREADABLE rather than closed. Calling it closed would
retire a job that is still open.

### Himalayas is a real dead end

Thirty rows, five approaches, none of them work. The page is 403. The feed's
`company=` filter does not filter -- it returns a totalCount of 1757 for one
employer and ignores `limit`, capping at 20. A keyword query returns a
totalCount of 105124. The RSS feed is a 20-item rolling window holding none of
them. Recorded as closed rather than left looking like a defect.

### An audit with no repair behind it

The refresh audit failed the run on a Kong posting with no `refreshed_at`,
reporting it as "still on the board and fillable". `ingest/date-backfill.mjs`
fills exactly that, existed as a CLI, and NOTHING ran it -- not the daily job,
not daily.mjs. So the audit was failing the run on work that was never
scheduled, and would have kept failing on every new dated-board row. It runs
before both audits now.

### Two things the reviewers caught

I wrote a NEW reason word, `duplicate`, when index.html already had
`duplicate-posting` in its RULED_OUT list and its label map. Five collapsed rows
stayed on the list showing the raw slug, and `apply/test-counts.mjs` failed on
exactly that. The reason a writer stores has to be one the reader knows, so a
case now reads index.html and requires both.

The dry-run switch on the new backfill step was written `dry && '' || '--write'`.
An empty string is FALSY in a GitHub expression, so that yields `--write` on a
DRY run: the step would have written to the database exactly when told not to.
Every conditional in the workflow is non-empty on both branches now.

53 suites pass, up from 51.

## v22.0.0 - The nine gaps, and a footer nobody could reach (2026-09-04)

FEATURES.md carried nine rows marked **Gap**: verified by hand, verified by
screenshot, or not verified at all. There are none left. 51 suites pass, up
from 44.

### Two of them were hiding a defect

/login/ had no footer. It mounts inside `mountSiteNav()` and the sign-in page
never called that, so the four legal documents were unreachable from the page a
new person is most likely to land on. It mounts the footer alone now -- a
sign-in control at the top of the sign-in page is noise.

The local server sent no Content-Security-Policy while production did. The
avatar check that a `blob:` image is REFUSED passed against production and
failed locally, which is a local run certifying something production does not
do. It reads `_headers` and applies the same rules.

### What each gap turned into

The salary sweep's write loop had no test, which is uncomfortable for the one
loop that decides whether a measurement is SAVED. It once let the first rejected
UPDATE escape and abandoned every remaining write: nine rows held an empty
string in `match_pct`, SQLite compares text as greater than any integer, a range
trigger rejected them, and the run reported 205 bands found, wrote seven, and
exited zero. Its cases are mostly about writes FAILING, because a loop that only
gets successful answers proves nothing about that.

Origin-checked writes were verified with curl. Curling a few endpoints says
nothing about the route added next week, so every write handler on disk must now
be authorised by a mechanism the test can see: the origin check, directly or
through `refuseWrite`, or a hashed single-use token from an emailed link, which
arrives with no usable Origin. Mechanisms rather than a list of exempt
filenames, because such lists grow holes.

The theme is measured on PAINTED colour. Flipping `data-theme` and asserting
that `data-theme` flipped proves nothing about what a person sees, so the
context emulates a dark operating system and the assertions are on luminance.

The legal pages render client-side, so a word count over the raw HTML reads
about five words and would pass a page that renders nothing. Every count is
taken from `innerText` in a real browser, with a floor per page.

Slash focuses the search box, which no screenshot could ever have shown. Filter
chips are judged on the ROWS they produce rather than on `aria-pressed`, because
a chip that only recolours itself is the failure worth catching.

The avatar test loads a `blob:` URL and requires it to still fail, so the reason
the resize returns `data:` cannot quietly go away.

### A test nobody ran

`functions/test-origin.mjs` was named in FEATURES.md, passed the coverage check
that every test is named, and never ran. Discovery walked ingest, apply and
tests, and the daily lane filtered to `--only ingest/`, so a file in functions/
was invisible to both. Discovery covers functions/ now, `--only` takes a list,
and a filter matching NOTHING fails rather than reporting a clean run of zero
tests. 51 suites pass.

### Two of my own checks could not fail

One assertion was written as a JS regex literal with a doubled backslash, so it
matched a literal backslash-b rather than a word boundary. It passed against a
repair that set `status`. Another counted `= ?` across a whole statement, which
counts the WHERE clause, so a correct one-column update looked like two. Both
were found by breaking the code on purpose rather than by reading them.

## v21.0.0 - American Express, and a pay band the parser was refusing (2026-09-03)

Brian asked for American Express as a source. Their board is Oracle Recruiting
Cloud, which is a ninth source module rather than another token in
`companies.json`, because Oracle addresses a board by host plus site instead of
a single slug.

313 requisitions match "product manager" on their site, and three survive the
standing rules: Phoenix, Arizona product roles. New York hybrid drops on
location, London and Bengaluru drop on being outside the US, and business
development drops on the title. Oracle's keyword search is a loose OR that
returns a Financial Systems Analyst for that query, so the shared query filter
is doing real work here rather than passing everything through.

### Three things this board does that no other one does

A pulled requisition answers HTTP 200 with an EMPTY items array. Every other
board in this repo 404s. A tier that only read the status would call a dead
posting readable, find no text, fall through, and leave the row queued forever,
so the empty list is what marks it closed.

The published pay band is not in the description. It sits in a requisition flex
field, and a prose scan over the job text finds nothing at all. The first live
run returned `salary: null` on a Director posting whose band was right there in
the payload, which is exactly the loss the never-lose-published-salary rule
exists to prevent.

That band reads `$144250 - $256250`, with no thousands separator, and the shared
salary parser required a comma or a k. It now accepts an ungrouped five or six
digit figure behind a dollar sign. The protections the narrow rule was carrying
had to survive: the filter-widget range ending in 999 is still refused, so is a
pair under the sanity floor, and a longer run of digits is not chopped down into
something salary-shaped.

### A posting-end date is in the future by definition

`validThrough` was being run through the posted-date clamp, which pulls any
future date back to now. An end date is in the future or it is not an end date,
so "open until the 6th" was being stored as "expired today". Nothing reads the
field yet, which is the only reason this never showed up. Fixed on the Workday
tier too, which had the same line.

35 cases cover the source. Four temp copies are required to fail: a narrowed
salary parser, a closed signal reduced to a status check, a re-clamped end date,
and a refresh date Oracle never reported. The suite's own guard caught that the
new test was missing from FEATURES.md before any of this shipped.

Requisition 26011057, which Brian asked about earlier, is not on the CX_1 site.
The detail finder returns zero items for that id.

## v20.0.0 — The resume imports itself (2026-09-03)

Brian: the import-from-resume work is good, but do not force them to hit import
on each section. Auto-import it and let them edit.

### It fills itself in on a first visit

A profile with nothing stored now opens with the resume already parsed, laid out
and editable. `mergeSections(null, parsed)` returns the parse, so this is a
wiring change rather than new logic, and the result is persisted immediately --
an auto-fill that lives only in the DOM disappears on the next load and reads as
data loss.

### And never over work that already exists

The friction goes; the safety property does not. The auto-fill runs ONLY when
nothing is stored. The moment sections exist, the parse stops being applied and
becomes something to add from, because a parser that runs over saved work is the
one failure this feature had to avoid.

Three cases hold that line, and each fails on its own input:
  - a first visit starts from the parse rather than an empty form
  - a later visit keeps a hand-edited title instead of re-importing over it,
    and the parse by itself still carries the resume title, so the merge is
    demonstrably what kept the edit
  - a section somebody deliberately emptied stays empty rather than being
    refilled, because an empty stored section is still stored

Pointing the merge at `null` in a temporary copy -- which is what an auto-import
that ignores saved state would do -- fails the edit-protection case and exits 1.

## v19.0.0 — A LinkedIn-shaped profile, parsed from the resume that exists (2026-09-03)

/profile/ was a flat form and `profile.resume_text` was stored and read by
nothing. It parses into sections now -- summary, experience, projects, skills,
education, certifications -- each editable, reorderable by drag AND by keyboard
buttons, with a per-section visibility toggle so the public portfolio can differ
from the private profile.

/portfolio/ renders the visible sections, carries JSON-LD Person, and prints as
one clean column, which is the virtual resume. A hidden section is ABSENT from
the HTML rather than display:none, because hidden on a public page has to mean
not published. Email and phone are stripped from every new field.

### The spec was wrong and the tests passed anyway

The spec said the role line was "Title | Location" with a company line above it,
and that dates always carry a month. The fixture encoded that and every
assertion passed. Against the real resume, five of six roles came out with an
achievement paragraph as their company, the company sat in the location field,
and the sixth role did not exist at all because "2016 to Present" has no month.

Three corrections, each measured against the document rather than reasoned
about. The pipe carries the COMPANY, and this resume states no location
anywhere, so location is null rather than invented. Dates may omit the month;
"undefined 2016" is worse than a missing month because it looks like data. The
company-line lookback is gone -- with no company line to find it claimed the
preceding paragraph and used that index as the end of the previous role,
dropping eight long lines of achievement text while nothing failed, because text
that is never assigned leaves nothing to assert against.

Against the real resume now: six roles, correct companies, correct dates, 18
paragraphs, and zero source lines unaccounted for. A new case accounts for every
WORK EXPERIENCE line instead of spot-checking the fields that happen to be
named.

## v18.0.0 — Read the boards nobody could read, and stop trusting text about code (2026-09-03)

Measured on production as this shipped: 261 queued rows, 178 of them with a
description read, up from 170 of 315. Of the 83 still unread, 27 are on boards
whose terms forbid automated reads, so the honest ceiling here is 56 rows on
hosts that answer nothing usable.

### A tiered description reader

145 rows had never had a description read, and that one gap caused the two
numbers next to it: no resume score and no published band. Every one of the 43
distinct hosts was surveyed first, one request each, before any code was
written.

Tiers, in order: the three board APIs unchanged, Workday CXS with the locale
segment optional, the Himalayas feed, JSON-LD JobPosting, then readable page
text. `datePosted` and `baseSalary` come from the same fetch, USD and YEAR only,
so no extra request closes two more gaps.

Blocked hosts are never fetched, and the test asserts the fetch was not
ATTEMPTED rather than that the result was null. Returning nothing and never
being asked are different things.

### 33 postings the reader already knew were gone

`--unread` on closed-check asks the READER rather than fetching the page again,
because the reader is what knows a board id has been dropped. It found 33 rows
returning board-404 -- lever and greenhouse ids the boards no longer list --
that had been sitting on the list looking like a reader which could not cope.

### Three bugs found by not trusting a number

The coverage number moved between identical runs: 111, then 119. The new tiers
keyed their cache on a board reference they do not have, so they cached nothing
and re-fetched every run, keeping whatever that minute's rate limits allowed.
The cache held ZERO himalayas files out of 197.

Fixing that exposed a second layer. The caching wrapper only ran when a caller
passed `cacheDir`, and no caller did: `fetchJd` spreads its options through and
`daily.mjs` calls `readJd(url)` bare. Three full re-scores wrote no cache files
while the caching code was correct and tested. It has a default now, and a case
asserts a second read with no `cacheDir` makes zero fetches.

Clearing the cache to force a fresh read also wiped the corpus `resumeMatch`
calibrates against, and every row lost its resume score. That was mine, and the
next run restored it.

### Two assertions that could not fail

A test appended cases after `process.exitCode` was already set, so four new
checks printed and could never fail the suite. The verdict is last in that file
now, and falsifying a case exits 1.

An assertion required `salary-sweep.mjs` to CONTAIN the literal call
`boardTextHasBand(boardText)`. The reader consolidation renamed the variable:
the assertion failed while the behaviour was intact and better. A text match
cannot tell a rename from a removal, which is the same lesson as the
ReferenceError that reached CI. The decision lives in a pure
`withStructuredBand()` now and is asserted on behaviour.

## v17.0.0 — Pay is in the score, and the list is narrower on purpose (2026-09-03)

Everything Brian asked for across one working day, all of it driven by looking
at the live page rather than at the code.

Measured on production as this shipped: 315 queued rows, 135 carrying a
published band, and the correlation between published start and rank moving from
**-0.155 to +0.082** across priced rows and from **-0.125 to +0.346** over the
priced rows he actually sees, with leadership behind its pill.

### Pay is in the score

`rank = fit*0.40 + success*0.35 + payPercentile*0.25`, against the old
`fit*0.55 + success*0.45`. The pay term is the percentile of the published START
among the starts of every queued row, not dollars: a raw $170k cannot be
averaged with a 45-94 fit score, which is the same reason resume overlap is
calibrated.

A row with no published band takes the MEDIAN, 50. The first version of this
spec had unpriced rows keep the old two-term blend, and simulating it against
the live queue before proposing it is what caught the problem: every priced row
got diluted while unpriced ones kept their higher score, so the top twelve came
out almost entirely unpriced. That penalises an employer for publishing a band.

The percentile is taken against every queued row, not against the batch being
scored. Both call sites built it from the batch, and the batch is capped
(`--max-rank 200` in CI, `--limit` on the CLI), so the same posting could read
one percentile on one run and another on the next because the batch around it
changed. A score that moves when nothing about the job moved is the class of
bug this repo keeps finding. `ingest/test-pay-rank.mjs` asserts it against the
SOURCE of both call sites, because using the wrong population is a wiring
mistake that no unit test of a pure function can see.

The top of the list is a genuine mix now: Reddit at $217k, PeopleGrove unpriced,
Tremendous at $240k, Owner at $280k, Affirm Bank at $230k.

### Marketing products are ruled out, not de-ranked

Marketing was a 25-point off-focus penalty, and the comment in `fit-score.mjs`
named "Staff Product Manager, Marketing Pro" as the case that must NOT be
excluded, reasoning that a product manager working on a marketing product is
still a product manager. The evidence beat the reasoning: the penalty left that
posting at 41 percent and at the TOP of his $165k-this-week view.

It is a domain exclusion now, decided on the TITLE like risk-compliance, because
nearly every description names marketing somewhere. `OFF_FOCUS` is empty and
kept rather than deleted, since de-ranking and exclusion answer different
questions. The old test cases were rewritten rather than removed: each title is
ruled out AND no longer penalised, because a row that was both would be
double-counted the day somebody switches the domain back on.

### Role and Company are two columns

They were one `1fr` cell labelled "Role / Company". The flexible column carries
no grip, so there was no way to widen it. Role keeps the `1fr` so the table
still fills the width; Company has a real width and a grip, so narrowing Company
widens Role. `tests/column-split.mjs` requires the header and the rows to share
one grid, because a mismatch shifts every column sideways and throws nothing.

### Director level is behind a pill

32 rows moved off the default list. Principal, Staff, Group and Senior Product
Manager all stay, because Principal is a senior individual contributor rather
than a manager of managers. The first version of that pattern went through a
shell heredoc which turned every `\b` into a literal backspace: it read
correctly in an editor, matched almost nothing, and the pill counted 3 rows
where 32 were expected. The test writes its own copy of the pattern rather than
importing the page's, and floors the count.

### A quick filter, and a way back out

`$165k+ this week` sets three things in one click: the pay lens, the seven-day
window and a PURE rank sort. Best match orders by pay lane first, so under it
the top row of that set reads 74 while the set holds an 82. `Clear all filters`
names the count it will clear and is disabled at zero.

### The column popup is reachable on a phone

Its search field was focused unconditionally, which is what raises the on-screen
keyboard over it. `left` was clamped against the right edge only. Nothing kept
it inside the viewport vertically. All three are fixed, and Escape discards, so
a selection made in a popup whose Apply cannot be clicked was simply lost.

### One command runs the whole suite

`node tests/run-all.mjs` DISCOVERS test files and FAILS on any it cannot
classify. Six suites were added in a day, each wired into CI by hand, and a test
nobody runs is worse than no test because the green tick claims coverage that
never executed. Its first real use caught a scheduled cloud routine adding
`ingest/test-dedupe-queue.mjs` without wiring it in.

### The pay blend, in detail

Brian, 2026-09-02: higher paying jobs that fit well and that he has a good
shot of getting should have a higher rank %. He approved the change on
2026-09-03.

Until this release pay only picked the sort lane. The headline was
`fit * 0.55 + success * 0.45`. Measured over the live queue, the
correlation between published start and rank was -0.155 across all priced
rows, and -0.125 over priced non-leadership rows. Negative: higher pay
tracked a lower score.

### The blend

Priced or unpriced alike:

    fit * 0.40 + success * 0.35 + payTerm * 0.25

`payTerm` is the percentile of the posting's published START among the
published starts of the rows being scored, 0 to 100. Not a dollars-per-point
scale. The repo already does this for resume overlap via `calibrate()`,
because a raw figure that runs 0-30 cannot be averaged against a 45-94
concept score.

A row with no published band takes the median, 50. The first specification
kept unpriced rows on the old two-term blend. Simulated against the live
queue it was wrong: every priced row got diluted by its pay percentile
while unpriced rows kept their higher score, so the top twelve came out
almost entirely unpriced (PeopleGrove 77, Jerry.ai 74, Camunda 72). That
penalises an employer for publishing a band, which is backwards. Unknown
is average here, the same principle as unknown-is-not-low in the salary
gate.

When no distribution is supplied, payTerm is 50 for every row. Missing
degrades to neutral, not to zero, because zero would silently punish every
posting.

The `fit === null` branch is unchanged at `success * 0.6`. A row whose
description could not be read has no fit component, and adding pay to only
that branch would be a second change with its own behaviour. Noted as a
known gap in RANKING.md.

`rank_why` names the pay component in the same voice as the resume line
("pay: starts at $170k, higher than 18% of priced postings"). The
percentage on the page carries `rank_why` in its hover title, and a score
that moved 17 points with no visible reason is the thing this repo keeps
being caught by.

The distribution is built once per run from the rows about to be scored
and threaded through `ingest/daily.mjs`, the `ingest/fit-score.mjs` CLI,
`ingest/salary-recover.mjs`, and `ingest/regate.mjs`.

Simulated against the live queue using the stored fit_pct and success_pct
(a real re-score recomputes those from the descriptions, so exact values
may move a point or two):

    correlation(published start, rank), all priced rows:        -0.155 -> +0.118
    correlation, priced non-leadership rows:                    -0.125 -> +0.167
    rows whose score changes:                                   139 of 316 (49 up, 90 down)

    Tremendous  Senior Product Manager - Growth   $240k   63 -> 70
    Owner       Principal PM, AI Restaurant       $280k   61 -> 69
    Instacart   Senior PM, Caper Recommendations  $221k   65 -> 69
    Affirm      Staff PM, Affirm Bank             $230k   63 -> 68
    Vanilla     Senior Product Manager            $170k   82 -> 65
    Mitratech   Sr. Product Manager AI            $160k   73 -> 55
    15Five      Director, Product                 $160k   68 -> 50

This release does not write those scores. The dry run reports; `--write`
is a separate step.

### Verification

- `ingest/test-pay-rank.mjs`: percentile 0 / ~100 / ~50, ties not
  double-counted, empty or missing distribution is 50 not 0, hand-worked
  blend `fit 80, success 60, pay 90` is 76, weights sum to 1.0, unpriced
  and a median band share payTerm 50, unread still returns
  `success * 0.6` and ignores pay, and two rows that today's blend ranks
  the wrong way around reverse under the new one.
- Known-bad: a temporary copy with one weight changed is required to FAIL
  the arithmetic and the weights-sum assertion. The real build is required
  to pass.

## v16.0.0 — Every rule reaches the rows already in the table (2026-09-02)

Five branches shipped together, so they are one release. The thread running
through all of them is that a rule written in code is not a rule until it has
been applied to the rows already in the database and proved against a case that
makes it fail.

Measured against the live queue as this shipped: 317 queued rows, 137 carrying a
published band where 88 did before, and lane 1 grown from 67 to 88 confirmed
$180k or above. Four rows Brian named by hand are off the list, each for a
reason recorded on the row.

### Hide a posting over 30 days old unless the employer refreshed it

Brian: filter out any job over 30 days old unless it has been reposted.
A literal 30-day cut on first-published throws away live jobs. Pinterest
"Product Manager II, Content Compliance" was first published 103 days ago
and refreshed one day ago. GitLab "Principal Product Manager, AI Custom
Models" is 97 days old, refreshed yesterday. Cohere "Product Manager,
Platform Experience" is 174 days old, refreshed yesterday. Those stay.

Measured against the live queue today: 337 queued, 141 posted within 30
days, 72 older, 116 with no `posted` value. Of the 72 older rows, 12 were
refreshed within 30 days (the survivors this rule exists for), 20 have a
refresh older than 30 days, and 40 could not be judged because we stored
no refresh date. Binance has a Lever posting whose `createdAt` is
2021-04-09 (1972 days) plus three more over 500 days -- genuine evergreen
requisitions, and they should go.

### Store the employer's refresh date

`refreshed_at` sits next to `posted`. `posted` is first published and is
not overwritten with the refresh date: a posting 103 days old and
refreshed yesterday is a live job that has been open a long time, and
collapsing that into one number hides it.

Greenhouse writes `updated_at` (and no longer falls `posted` back to
`updated_at` when `first_published` is missing). Ashby writes `updatedAt`,
falling back to `publishedAt`. Lever writes `updatedAt` from epoch
milliseconds. A source that does not publish a refresh date writes
nothing. Null is unknown, not "refreshed long ago".

The same `ensurePayColumns` guard adds the column. `/api/jobs` selects it,
with a middle fallback so a database that has salary/rank but not
`refreshed_at` does not drop those extra columns.

### The rule is a lens, not a gate

A posting is stale when its age is over 30 days AND its refresh is over 30
days. Unknown refresh keeps the row -- dropping a row because our own
ingest lacks a field is the mistake that lost 36 published salaries today.
No `posted` date cannot be judged and stays. Exactly 30 days is not over
30. The threshold is one named constant, `STALE_AFTER_DAYS`.

Hidden by default. The Over 30 days chip shows what was hidden, with a
count taken from the same array the rows are drawn from.

Lens chips (`under`, `stale`) have to be excluded from the lane-bucket
check. `kind === "under"` used to fall through to `kind !== bucketOf(j)`,
and "under" is never "ft", so the Under $180k chip showed an empty list.
The same hole would have eaten Over 30 days. Both lenses skip that check.

The Posted column title carries the refresh date. A row kept only because
the employer refreshed it says so on hover, so "103d ago" is not read as
dead.

### An audit that fails the run

`ingest/refresh-audit.mjs` fails the daily run if any queued or
pending-review greenhouse, ashby or lever URL (resolved by `boardRef`,
never the source label) has no `refreshed_at`. Wired into
`.github/workflows/daily-jobs.yml` next to the salary audit.

### Backfill missing posted dates first

`ingest/date-backfill.mjs` fills `posted` and `refreshed_at` where the URL
is a board we can read. `--dry` is the default. `--write` is not run from
this change. In-memory board cache only -- it does not write an index.

### Verification

- `ingest/test-stale.mjs`: 31d/2d kept (Pinterest), 31d/40d hidden, unknown
  refresh kept, 10d kept, no posted kept, exactly 30 days kept.
- `ingest/test-board-dates.mjs`: posted and refreshed_at stay different
  fields on greenhouse, ashby and lever payloads.
- `ingest/test-refresh-audit.mjs`: fails on a greenhouse URL with no
  refresh date, passes when the date is stored, ignores LinkedIn.
- `ingest/test-date-backfill.mjs`: builtin-labelled greenhouse URL is a
  candidate; will not overwrite posted.
- `tests/stale-filter.mjs`: fixture jobs through `tests/serve-local.mjs`.
  Default list keeps the Pinterest case and hides the un-refreshed ones.
  Chip count equals the rows it reveals. Hover title names the refresh.
- Known-bad: a temporary copy whose stale rule ignores refresh is required
  to FAIL the Pinterest keep. The real build is required to pass.

### Hardware out, and new rules reach rows already queued

Brian, on vCluster Labs "Staff Product Manager (vMetal)" at 59%: i don't
want hardware. The title says nothing. A rule that only runs on tomorrow's
ingest also would have left it sitting there, the same way Teamworks
"Senior Product Success Manager I" stayed in the queue after the product-
success role rule landed.

### Hardware is a description, with a measured threshold

`ingest/domain-eligible.mjs` already searched title, company AND
description for healthcare. Hardware is the same kind of decision. Treating
`silicon` or `bare metal` as decisive on a single mention was wrong four
times out of five: TLDR (silicon inside an inc.com URL), Camunda (one
bare-metal deployment target beside Kubernetes), Jobgether (silicon as a
partner ecosystem), Vultr (bare metal as one of four cloud product lines).
Only vCluster was genuine.

URLs are stripped before any pattern in that file is matched, because a
link slug can decide a rule and that is true of every domain, not only
hardware. Decisive phrases have to mean a hardware product. A weak term
needs 6 hits -- vCluster had 11, Vultr 4, GitLab 3.

It is switchable. `TOGGLEABLE_DOMAINS` and the `DOMAIN_LABELS` badge in
`index.html` name it "Hardware".

### The missing pass: re-run the whole gate over every queued row

`ingest/regate.mjs` blocked employers, blocked title-first domains, and
reopened retired salary skips. It did not re-run the WHOLE gate over every
queued row. That is why Teamworks was still in the list. A fourth pass now
reads the cached description through `fetchJd`, runs `requirementsGate`,
and writes the rule-out with the same statement shape as the other passes:
status skipped, rank_pct and pay_tier cleared, submitted rows refused in
the WHERE.

A row whose description cannot be read is unknown, not disqualifying. 114
queued rows currently have no cached JD. Ruling those out would empty a
third of the list. Title-only rules still fire when the file is missing.

Dry-run reports. `--write` is not run from this change.

### Verification

- `ingest/test-domain.mjs` rules vCluster out as hardware, keeps Camunda's
  single bare-metal, keeps Vultr's four weak mentions, keeps a posting
  whose only "silicon" is inside a real inc.com URL, and keeps the
  existing healthcare, construction and clearance cases. Known-bad: a
  temporary copy with the hardware domain or the URL strip removed is
  required to FAIL on those assertions.
- `ingest/test-employer-block.mjs` skips queued Teamworks, leaves a
  submitted Teamworks row alone, leaves a clean posting with an unreadable
  description alone, and asserts the write refuses `status = submitted`.
  Known-bad: a temporary copy that skips on a missing JD, or that writes
  submitted rows, is required to FAIL.

### Risk, compliance and product-success roles are ruled out

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

### The sign-in panel stays on a 320px phone

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
### Never lose a published salary

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
