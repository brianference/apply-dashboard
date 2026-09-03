# How a posting is ranked

Until 2026-08-26 the percentage on the dashboard came from `ingest/match.mjs`
`scoreMatch()`: title words, a seniority word, a domain word, a location word.
"Principal Product Manager, AI Platform" scored 100 whether or not the job
wanted ten years of ad tech. It had never read a job description and had never
read Brian's record, so it could not say anything about fit, and it should never
have been presented as if it could.

`ingest/fit-score.mjs` replaces it with three numbers, kept separate on purpose.
Averaging them into one hides which of the three is failing.

## 1. The requirements gate — pass or fail, never a score

Location (remote US-eligible or Arizona), role (product management), and the
salary floor. A posting that fails is not "ranked low", it is off the list:
`status='skipped'`, `blocked_reason='off-criteria'`, with the reason recorded.

Three rules the gate holds that a naive version would get wrong:

- **An unpublished salary is unknown, not low.** Most postings publish nothing.
  Only a *published* figure can fail.
- **A band is judged on where it starts, not where it ends.** `$125k-$201k`
  passed a top-of-range check on its $201k and is a $125k job. A published start
  below $160k fails however high the top goes. Brian set that floor at $120k,
  raised it on seeing Liberty Mutual's $125k-$201k survive, and settled at
  $160k.
- **A security product is ruled out even when the title hides it.** The role
  rule reads titles, and Delinea's "Senior Product Manager - Platform" says
  nothing. Its own description opens *"a pioneer in securing human and machine
  identities ... Identity Security Platform"*. `securitySignals()` reads the
  description: a decisive phrase rules a posting out on its own, a vague word
  needs four. Eight postings were caught this way, including Bugcrowd's "Staff
  Product Manager (AI & Data)" — invisible to any title-based rule.

## 2. `fit_pct` — what the job asks for, against what Brian has done

The **job description sets the denominator, Brian's record sets the numerator.**
That direction is the whole design. `CONCEPTS` in `fit-score.mjs` lists what a
product job can ask for; each entry carries `has` (does he have evidence) and
`strength` (how current and deep it is), both taken from
`apply/narrative.local.md`, dictated by him on 2026-08-22. Nothing about him is
inferred from the posting.

Strength matters. American Express MYCA Payments is a prior role and scores
`0.55`; the Claude skills library is what he does now and scores `1.0`.

A posting whose description could not be fetched gets `fit_pct = null`. So does
one that names fewer than three measurable concepts. **Never a guess** — an
invented fit number is worse than no number, because it looks earned and nobody
re-checks it.

## 3. `success_pct` — could he realistically win it

Seniority distance from Senior (his centre of mass), years demanded against the
two he has held the PM title, hard blockers such as a security clearance, and
whether the application can be submitted at all. That last one is the most
honest signal in the system: a posting behind an emailed code or a captcha is
not an application until a human finishes it.

## The headline

    gate failed        -> no rank at all, off the list; rank_pct and pay_tier cleared
    description unread -> success_pct * 0.6, marked as unread (pay is not mixed in)
    normal             -> fit_pct * 0.40 + success_pct * 0.35 + payTerm * 0.25

Brian, 2026-09-02: higher paying jobs that fit well and that he has a good
shot of getting should have a higher rank %. Until 2026-09-03 pay only picked
the sort lane. Measured over the live queue, the correlation between published
start and rank was -0.155 across all priced rows, and -0.125 over priced
non-leadership rows. Negative: higher pay tracked a lower score.

`payTerm` is the percentile of the posting's published START among the
published starts of the rows being scored, 0 to 100. Not a dollars-per-point
scale. A raw $170k cannot be averaged with a 45-94 fit score; the percentile
can. Same shape as `calibrate()` for resume overlap.

A row with no published band takes the median, 50. That last rule is the
whole design and it is not obvious. The first specification kept unpriced
rows on the old two-term blend. Simulated against the live queue it was
wrong: every priced row got diluted by its pay percentile while unpriced
rows kept their higher score, so the top twelve came out almost entirely
unpriced (PeopleGrove 77, Jerry.ai 74, Camunda 72). That penalises an
employer for publishing a band, which is backwards. Unknown is average here,
the same principle as unknown-is-not-low in the salary gate.

When no distribution is supplied, payTerm is 50 for every row. Missing
degrades to neutral, not to zero, because zero would silently punish every
posting.

**Known gap.** The `fit === null` branch is still `success * 0.6`. A row
whose description could not be read has no fit component, and adding pay to
only that branch would be a second change with its own behaviour.

Pay is also still a separate `pay_tier` decided on the published start only
(a top figure with no start is unknown, not confirmed). The lane is the
sort; the percentile is the number on the row:

    1  salary_min >= $180k     confirmed at or above the floor
    2  no published start      unknown — crawled, or not yet priced
    3  $160k <= salary_min < $180k   confirmed second lane
    null  salary_min < $160k   already fails the gate
The gate decides only whether the money is under his floor at all. It used to
reject any published TOP under $180k, which meant a band advertised as
$165k-$175k was dropped and the second lane could only ever hold ranges that
ALSO reached $180k+. Retired 2026-08-31: a published START under $160k still
fails, and a top published with no start still fails if it is under $160k, but
the $160-180k distinction is now the LANE's job, not the gate's.

An employer on `ingest/blocked-employers.json` fails the gate before anything
else is measured. `ingest/regate.mjs` applies a rule change to rows already in
the queue -- re-running the WHOLE gate, never the one rule that changed.

On the dashboard, Best match sorts by `pay_tier` ascending (1, then 2, then 3;
missing last), then `rank_pct` descending. The number shown is still `rank_pct`
when it exists. Where nothing has been ranked yet the old `match_pct` still
shows, greyed and italic, and hovering says "keyword score only — the job
description has not been read". A provisional score must never look like a
measured one.

## What five runs actually found

Each of these was a real defect, and each was found by running the thing rather
than reading it.

1. **`fitScore` could only return 100.** `earned` and `available` were
   incremented on the same branch, so fit was 100% unless an unrelated-industry
   word happened to appear. Amplitude measured exactly 100 — an impossible-looking
   value is what exposed it. *A score that cannot come out low is decoration.*
2. **Two of twenty-five descriptions were read.** The highest-`match_pct` rows
   were aggregator URLs that `boardRef()` cannot resolve, so the scorer was
   blind on precisely the rows it was asked to judge. `--readable` now ranks
   what can actually be read, and coverage went to 71 of 80.
3. **Eight-way ties.** With no description every posting collapsed to the same
   success score. Fixed by the two items above.
4. **Scoring the whole description pinned 17 of 51 postings at exactly 100.**
   "AI", "cross-functional", "SaaS" and "dashboards" appear in the marketing
   paragraph of nearly every product posting. Scoring the *requirements* section,
   and weighting by how often a concept recurs, moved the median to 77.
5. **Binary `has` treated a prior role like current work.** Adding `strength`
   produced the first real distribution: min 45, max 94, median 77, none at 100.
6. **Rows failing Brian's own rules were sitting queued and applyable** — Brex,
   Datadog, Databricks and Amplitude all on-site, Mozilla an engineering manager
   — with no `blocked_reason`, so the runner could still pick them. The `--write`
   pass now rules them out.

## Running it

    node ingest/fit-score.mjs --limit 80 --readable            # report only
    CF_D1_TOKEN=... node ingest/fit-score.mjs --limit 200 --readable --write

    node ingest/test-fit.mjs            # every rejection reason, on inputs built to trip it
    node ingest/test-pay-tier.mjs       # pay-first tiers; the retired sort must fail
    node ingest/test-pay-rank.mjs       # pay percentile in the headline; a weight typo must fail

`--write` updates `rank_pct`, `fit_pct`, `success_pct`, `jd_read` and
`rank_why`, `pay_tier`, and rules out anything failing the gate. Descriptions are cached
under `ingest/out/jd-cache/` so a re-run does not re-fetch.
