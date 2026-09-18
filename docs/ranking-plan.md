# Ranking plan, from the applications that got an interview

Written 2026-09-18 from three first-round interviews: Mitratech (Senior Product
Manager, Catalyst), WWT, and Bjak. Every figure below was measured against the
150 applications in the tracker on that date; nothing is recalled.

## What was found before anything could be planned

**The tracker had never recorded an outcome.** Zero rows in `outcomes` before
today. So the three interviews are the first signal the system has, against
146 applications whose result is unknown rather than known-negative. That is
not a sample; it is three points.

**Only 81 of 150 applications had ever been ranked.** 69 went in before the
ranker existed or were ranked out later, and every write path treats a
submitted row as history. Two of the three interview sources, Bjak twice,
had no rank, no fit score and no description read. `ingest/score-history.mjs`
now scores every application without touching its status, and is
re-runnable, which is how any future weight change gets measured against the
same outcomes.

**WWT is not in the tracker at all.** That application was made outside it,
as was Mitratech's, which sat as `queued` until today. The interview evidence
is incomplete until the WWT posting is added, and one of the three Bjak rows
carries the outcome pending Brian confirming which role it was.

## Where the interview applications sit, once scored

| Axis | Mitratech | Bjak (three rows) | Rest of 150, median (q1, q3) |
|---|---|---|---|
| rank_pct | 70 | 34, 37, 52 | 56 (38, 69) |
| fit_pct | **95** | 46, none, none | 70 (61, 80) |
| success_pct | 75 | 60, 60, 70 | 58 (46, 65) |
| pay term | start $170k, below the $180k floor, lane 3 | unpublished | median start $190k |
| days posted to applied | **2** | unknown | 20 (10, 46) |
| AI in the title | no | yes, yes, yes | 42% of the rest |

Two of the three Bjak descriptions are unreadable now, so their fit is
unknown, not low.

## What a weight change would and would not do

Every alternative blend was run over all 150 scored applications, and the
question asked was where the four interview rows land as a percentile of the
whole set. Higher means the ranker liked them more.

| Weights (fit / success / pay) | Mitratech | Bjak rows | Mean of the four |
|---|---|---|---|
| current 40 / 35 / 25 | 93 | 14, 27, 46 | 45 |
| pay down 45 / 45 / 10 | 99 | 15, 28, 46 | 47 |
| no pay 50 / 50 / 0 | 100 | 17, 29, 44 | 48 |
| **success-led 30 / 60 / 10** | 99 | **22, 42, 55** | **55** |
| fit-led 60 / 30 / 10 | 99 | 15, 27, 39 | 45 |

No reweighting moves Bjak out of the bottom half. The best blend lifts the
four from a mean percentile of 45 to 55. Whatever made Bjak respond is not
among the ranker's inputs, and reweighting inputs that do not carry the signal
cannot recover it. **The weights are therefore left as they are.** The
success-led direction is recorded as the one to try when there are enough
outcomes to tell a real lift from noise; ten is the floor for that, not three.

## What the three do share, and what that suggests

These are observations on three employers, stated as hypotheses.

1. **None is a marquee employer with a high published band.** Mitratech
   published $170k to $200k, a start below the floor; Bjak published no pay;
   WWT is not yet in the tracker. The applications
   with no response include Netflix, Cisco, Salesforce, Supabase, Linear,
   Midjourney, Kraken and Coinbase. The pay term currently rewards the
   opposite: a higher published start ranks higher. The what-if says removing
   it costs nothing on these three. The hypothesis is that applicant volume,
   which the tracker cannot see, runs opposite to published pay.

2. **Speed.** Mitratech was applied to two days after posting; the median
   application went in after twenty. Half of the queue is now fed by boards
   that surface postings within a day, so this is actionable without a code
   change: work the fresh group first.

3. **AI in the title, and "Technical Product Manager".** Three of the four
   rows carry an AI title, against 42 percent of the rest, and two say
   Technical Product Manager. The keyword matcher already scores AI terms;
   what it does not do is prefer a technical PM title over a generic one.

4. **Fit is the axis that separated Mitratech.** Its fit of 95 is the widest
   gap from the median of any axis, and its pay term was pulling it down.
   For priced, readable postings, fit is doing the work.

## What changes now

- `ingest/score-history.mjs` exists and has run. Every application has a
  score. Rerun with `--all --write` after any ranker change.
- Outcomes are being recorded. The two interviews are in `outcomes`; the
  third goes in when the WWT posting is supplied.
- `ingest/collapse-relistings.mjs` collapsed 15 Jobgether relistings onto the
  named employer they duplicate, left 3 generic titles alone as ambiguous, and
  reported the one application that went in through Jobgether for a role also
  in the queue under Upstart.

## What changes when there are ten outcomes

- Compute callback rate by rank quartile, fit quartile, pay lane, AI-title,
  and days-to-apply bucket. If success-led weights or a smaller pay term
  produce a real separation, adopt them then.
- Mark applications with no reply after 45 days as `no-response`, so the
  denominator is real rather than "unknown". That is a process step for
  Brian, not a rule the pipeline should write on his behalf: a silence is
  not a rejection until he decides it is.

## What Brian should do differently tomorrow, on this evidence

Apply within the first week of a posting, and do not let a lower published
band or a less famous employer push a strong-fit posting down the list. The
three that replied were all three of those things.
