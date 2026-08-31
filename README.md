# apply-dashboard

A job-hunt pipeline that finds product roles, filters them against rules that
are actually enforced, ranks them against a real resume, applies to the ones a
browser can finish on its own, and refuses to lose the record of what it sent.

Live: **https://apply-dashboard.pages.dev**

The dashboard is the visible part. Most of the work is the part that decides
what never reaches it.

---

## What it does

**Finds.** Eight sources, including the public job-board APIs of 152 company
boards on Greenhouse, Lever and Ashby. Every token in `ingest/companies.json`
was probed and kept only if its board answered with real postings.

**Filters, before ranking anything.** A rank is not a filter. Scoring an
ineligible posting well and showing it anyway is how a San Francisco role
reaches the top of a remote-only list. The gate is pass or fail:

- **Location** — remote (US-eligible) or Arizona. "Remote" and a city name
  appear together constantly and mean opposite things: `New York, San Francisco
  or Remote` is a choice, `Remote (San Francisco, CA)` is a restriction.
- **Hybrid** — only if the office is in Arizona. `Hybrid / FullTime / San
  Francisco / Remote` is hybrid in San Francisco, whatever else the string says.
- **Role** — product management. Not program, not engineering management, not
  design, not marketing, and not security products *even when the title hides
  it*: with the description in hand, "Senior Product Manager - Platform" at an
  identity-security company is caught by what the posting says about itself.
- **Salary** — a published range that STARTS below $160k fails, however high its
  top goes. A band is an offer conversation that opens at its bottom, and the
  top is the number a company almost never pays; `$125k-$201k` is a $125k job.
  An *unpublished* salary is unknown, not low, and most postings publish
  nothing.

**Never applies twice.** Deduplication runs on the primary key, on a normalised
URL (tracking parameters stripped, board identifiers kept), and within the
incoming batch, because two sources routinely carry the same job. A real
duplicate application once happened because an aggregator listing and the
company's own listing had different keys and the same URL.

**Ranks against the actual resume.** Three numbers, kept separate because they
answer different questions and averaging them hides which is failing:

| | what it means |
|---|---|
| `fit_pct` | what the job asks for, against what the resume and record show |
| `resume_pct` | "matches your resume better than N% of the queue" |
| `success_pct` | seniority distance, years demanded, hard blockers, whether the form can even be submitted |

The resume half measures *distinctive* requirements only — inverse document
frequency across 337 cached job descriptions — so "product", "team" and
"customer" cannot carry a score. See [RANKING.md](RANKING.md), including the
five defects that five runs found.

**Applies.** A Playwright runner fills and submits real forms across Ashby,
Greenhouse, Lever, Workday, Workable, SmartRecruiters, iCIMS and others,
screenshotting every step. It stops rather than guess: an unanswerable required
field, a captcha, or an emailed one-time code ends the run with the reason
recorded, and the posting waits for a human instead of being marked done.

**Refuses to lose what it sent.** See below.

---

## The database defends itself

Application history was destroyed once. A writer using `INSERT OR REPLACE` — a
delete plus an insert — took `status` and `submitted_at` with it. Ten triggers
now enforce the rules in the database, so they hold for **every** writer, not
just this repository:

- un-submitting, clearing `submitted_at`, deleting or **replacing** a submitted
  row are all refused. The replace case needs a trigger on the `INSERT` side:
  SQLite does not fire `DELETE` triggers for `REPLACE` unless
  `recursive_triggers` is on, which cannot be set on another writer's
  connection.
- an insert-only `applied_log` mirrors every submission, so the record survives
  even when the row does not.
- anything not stamped `source_pipeline='apply-daily'` is quarantined to
  `pending-review` and stays off the list until the daily run has put it through
  the same rules as everything else.
- hostile input is rejected outright: non-https URLs, `javascript:` and `data:`
  URLs, script tags in a title or company, over-long fields, percentages outside
  0–100 and absurd salaries. Every row here is text a stranger typed into their
  own applicant tracking system.

`ingest/ensure-guards.mjs` re-asserts all of them and then **attacks** them,
because a guard that existed once is not a guard — one of these silently
disappeared between two test runs and an un-submit went through the gap.

---

## Every count equals the rows it claims

The FULL-TIME tile once read 510 over a list of 237, and toggling All against
Full-time changed nothing visible. The rows and the tiles had been written from
separate predicates, so the two numbers were answering different questions under
the same label.

There is now one `onTheList()` in `index.html`, used by the rows and by every
count on the page. `apply/test-counts.mjs` drives the live site and compares
each count against the rows actually rendered under that filter, and CI runs it
after every write. It fails on the build from before the fix — tile 510, rows
242 — which is the only evidence that it checks anything.

---

## Running it

```bash
node ingest/daily.mjs --dry                     # find, filter, rank: no writes
CF_D1_TOKEN=... node ingest/daily.mjs --write   # what CI runs, twice a day
CF_D1_TOKEN=... node ingest/ensure-guards.mjs   # repair and attack the guards

node ingest/fit-score.mjs --limit 80 --readable # ranking report
node ingest/resume-match.mjs --self-check       # prove the resume match discriminates
node ingest/test-location.mjs                   # location, role, hybrid and product-ops rules
node ingest/test-fit.mjs                        # the fit score, including the security gate
node ingest/test-pay-tier.mjs                   # pay-first tiers and the sort they produce
node ingest/test-employer-block.mjs             # blocked employers and the reopen reversal
node ingest/regate.mjs                          # apply a rule change to rows already queued
node ingest/test-sync.mjs                       # every dedupe and rejection reason
```

Deployment is Cloudflare Pages **direct upload** — `git push` does not deploy:

```bash
./build-deploy.sh --deploy
```

Deploy the built `.deploy/` tree, never the repository root. Pages serves the
shared header from `/shared/site-nav.js`, but the source lives at
`web/shared/site-nav.js`, so deploying `.` makes that URL fall through to
`index.html`; the browser refuses it for having a `text/html` MIME type, the
header module never runs, and anything waiting on it silently never renders.
`build-deploy.sh` flattens `web/*` to the root of `.deploy/` and checks that the
header module landed. This README documented `wrangler pages deploy .` until
2026-08-28 and that command has never been the one that works.

---

## Tech

No framework and no build step. The dashboard is one 1,700-line `index.html`
served straight from Cloudflare Pages; every API is a Pages Function on the
edge; data is D1 (SQLite) with the integrity rules as triggers. The ingest and
apply layers are 37 plain ESM modules on Node 22 with no dependencies beyond
Playwright. GitHub Actions runs the pipeline twice a day and a scheduled Claude
routine audits what landed. The rule suites gate the run: a change that breaks
a case stops the pipeline before it writes anything.

## Privacy

The repository is public; the data is not. Identity, answer bank, resume text,
tokens, D1 backups and ranking output are all gitignored, and the queue is
snapshotted to a **private** repository four times a day — the postings are
public, but which ones were applied to, and when, are not. The dashboard reads
the owner's name and email from browser-local settings rather than shipping them
in page source.
