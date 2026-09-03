# Job search criteria — Brian Ference

Source: stated directly by Brian on 2026-08-22, quoting his own working session with the
Grok job-hunt agent. This file exists because the criteria lived only in a cloud sandbox
and could not be recovered from this machine or from GitHub. Anything added later must
cite where it came from.

## Employment type, in priority order

1. **Full-time.** The main hunt.
2. **Contract-to-hire, or straight contract.** Explicitly fine — "I really need a job
   right now so even contract to hire or contract is good."
3. **C2C** sits in the same bucket as contract.
4. **Second lane, lower priority:** high-promise **part-time or consulting**, and only
   if **fully remote**.

## The bar

| | |
|---|---|
| Title | AI Product Manager first; PM titles generally |
| Seniority | Senior, Staff, Principal (Senior is the centre of mass) |
| Location | US remote. Also Scottsdale / Phoenix within 25 miles |
| Compensation floor | **$180k+** |
| Freshness | posted in the last 5 days for the hunt window; hide by default if first published over 30 days ago AND the employer has not refreshed in 30 days |

## Tiers

- **Tier 1** — AI-native: a real AI PM role (AI / ML / agent / LLM in the role itself).
- **Tier 2** — generic PM he would still take.

## Company shape

B2B SaaS, developer tools, AI labs, infrastructure.

Companies he returns to: Webflow, GitLab, Engine, Anthropic, Campminder, Figma, Coinbase,
Cribl, New Relic, Instacart.

## Skips

- Healthcare
- Construction
- Architecture
- Hardware -- physical hardware, not a software product that happens to run on
  bare metal or mention silicon in a URL
- Risk and compliance roles, decided on the title -- a posting that mentions
  compliance in its legal boilerplate is not a compliance job
- Product success -- customer success under a product-shaped title, not product
  management
- Program / PMO roles, and tutoring roles — a year stale, no longer relevant
- On-site roles rank behind remote (Trucker Path is AI-native but on-site Phoenix, so it
  sits behind remote rather than being excluded outright)
- Anything under the $180k floor (ASU at $103–125k was rejected on this basis)

## Scoring

Every role gets a **match % confidence against the resume and the bar above**, plus a
tier. Reference points from the Greenhouse pass Brian ran (116 active apps, 45 tier 1):

| score | role |
|---|---|
| 88% | GitLab — Principal PM, AI Custom Models |
| 86% | Cribl AI (Staff/Principal) |
| 86% | Guild — Data and AI (remote) |
| 86% | New Relic — AI Observability |
| 86% | SentinelOne — Purple AI |
| 86% | Wizard — Agentic AI |
| 83–84% | Campminder AI Platform, Smartsheet Applied AI, Upwork AI Frontiers, Anthropic Claude Code (Platform), Boulevard AI Receptionist |

## Known gaps between these criteria and the live pipeline

- **The `jobs` table has no salary column at all**, so the $180k floor cannot be recorded,
  filtered, or enforced. It cannot currently be checked against any row in D1.
- **No tier field**, so tier 1 vs tier 2 is not represented either.
- The live queue's `match_pct` tops out at 84% and its provenance is unknown — it was
  produced by the sandbox HuntRank agent and the rubric was never written down. It is not
  known to be the same rubric that produced the 88% / 86% Greenhouse scores above.
- LinkedIn and MyGreenhouse were sources in Brian's own workflow but are not sources in
  the D1 pipeline.

---

## Standing filters, enforced in code (2026-08-25)

These are not scoring weights. A posting that fails any of them never reaches
the list, because ranking a bad job well still puts it in front of Brian.
`ingest/location-eligible.mjs` exports both checks; `ingest/sweep.local.mjs`
runs them BEFORE the D1 write. 65 cases, both directions, in
`ingest/test-location.local.mjs`.

| Rule | Accepted | Rejected |
|---|---|---|
| Location | remote (US-eligible), or Arizona | anywhere on site outside Arizona |
| Country | United States | Canada, India (Bangalore/Bengaluru), Netherlands, Germany (Berlin), and ~60 more |
| Role | product management | engineering management, program/project management, product marketing, product success, design |
| Domain | product, infra, developer tools | healthcare, construction, hardware, clearance, risk/compliance (title) |
| Salary | $180k floor, $160–180k second tier | under $160k |
| Duplicates | one application per job | any second attempt, matched on normalised company + title |

### What made the location rule hard

"Remote" and a city name appear together constantly and mean opposite things:

- `New York, San Francisco or Remote` — remote is an **option**. Eligible.
- `Remote (San Francisco, CA)` — remote **from** the Bay Area. Not eligible.
- `Remote only, San Francisco` — Wellfound's way of scoping remote to a city.
  Not eligible.

A bracket straight after "remote" is a restriction; a city listed beside it is a
choice. Rejecting on *any* bracket was worse than the original bug — it threw
out a dozen good jobs whose brackets held descriptive noise (`Remote -
remoteType=Remote`, `Remote (primary) - optional SF / Seattle / NYC`, `Remote
(unrestricted)`, `TELECOMMUTE`). A bracket only fences if it names a real place
**and** the text does not say optional, alternate, anchor or hub.

A missing location is missing **data**, not a failed rule: those rows are kept
and flagged for a human look rather than deleted.

### Duplicates

An exact `dedupe_key` or URL match is not enough. The same job is listed under
different keys when a title gains or loses a suffix (`(Remote Eligible)`,
`- US`, punctuation), so the guard compares normalised company **and** title.

The reverse failure matters just as much: Cisco's "Product Manager" and "Product
Manager - Partner Experience" are different jobs, and a guard that collapsed
them would quietly stop Brian applying to roles he wants. Both directions are
pinned in `apply/test-dupe.local.mjs`.

### The regular pass

`node ingest/sweep.local.mjs` sweeps eight queries across every source, applies
both rules, and loads each query before the next one runs — `ingest/upsert.mjs`
overwrites `ingest/out/upsert.sql` on every call, so running several queries and
loading once silently discarded all but the last.

---

## Standing filters added 2026-09-02

Brian: risk and compliance roles are boring, and a rule that lives in this
file and not in the gate is not a rule. Both of the additions below run in
`requirementsGate` and in `ingest/test-domain.mjs` / `ingest/test-location.mjs`,
which the daily pipeline runs before it writes anything.

### Risk and compliance, title only

`ingest/domain-eligible.mjs` already searched title, company AND description
for healthcare. That is right for "Parsley Health". It is wrong for
compliance: nearly every posting mentions it in legal boilerplate, and HIPAA
on its own ruled out Vanta.

The new `risk-compliance` domain reads the TITLE for `\brisk\b`,
`\bcompliance\b`, `\bregulatory\b`, `\bgrc\b`, and "governance, risk".
Standalone "governance" is not in the pattern. Webflow's "Staff Product
Manager, Governance" is data governance and stays. A posting whose title is
clean and whose description says "we comply with all applicable regulatory
requirements" stays.

It is switchable the way healthcare, construction and clearance are. A row
switched back on carries a "Risk and compliance" badge.

Submitted rows are history. Coinbase "Group Product Manager, Compliance
Agent Experience" and Vanta "Senior Product Manager, GRC Platform" were
already applied to and are not rewritten.

### Product success is not product management

`roleEligible` returned `{ok:true, why:"product"}` for Teamworks "Senior
Product Success Manager I (Nutrition, Pro)" because IS_PRODUCT's
`product ... manager` window matched it. NOT_PRODUCT already carried
"customer success" and is tested first, so adding "product success" is
enough. "Senior Product Manager, Success Platform" does not contain that
phrase and stays -- a product manager who owns a customer-success product
is a product job.

### Hardware is a description, not a title

Brian, 2026-09-02, on vCluster Labs "Staff Product Manager (vMetal)" at 59%:
i don't want hardware. The title says nothing. This is a DESCRIPTION-decided
domain like healthcare, not a title-decided one like risk-compliance.

Treating `silicon` or `bare metal` as decisive on a single mention was wrong
four times out of five. TLDR's only "silicon" sat inside an inc.com URL.
Camunda listed one "bare-metal" as a deployment target beside Kubernetes.
Jobgether named silicon as a partner ecosystem. Vultr sells bare metal as
one of four cloud product lines. Only vCluster was genuine.

URLs are stripped before any domain pattern is matched, because a link slug
can decide a rule and that is true of every pattern, not only hardware.
Decisive phrases have to mean a hardware product. A weak term needs 6 hits
-- that threshold dropped vCluster (11) and kept Vultr (4) and GitLab (3).

It is switchable the way healthcare is. A row switched back on carries a
"Hardware" badge.

### Stale postings, 30 days, unless the employer refreshed them

Brian, 2026-09-02: filter out any job over 30 days old unless it has been
reposted. Measured against the live queue that day: 337 queued rows, 141
posted within 30 days, 72 older than 30 days, 116 with no `posted` value.

A cut on first-published alone throws away live jobs. Of those 72 older
rows, 12 had been refreshed within 30 days -- Pinterest "Product Manager II,
Content Compliance" first published 103 days ago and refreshed one day ago,
GitLab "Principal Product Manager, AI Custom Models" 97 days old refreshed
yesterday, Cohere "Product Manager, Platform Experience" 174 days old
refreshed yesterday. Those stay. 20 had a refresh older than 30 days and
should hide. 40 could not be judged because we stored no refresh date.

Unknown refresh keeps the row. Dropping a posting because our own ingest
lacks a field is the mistake that lost 36 published salaries, and it is
not a feature. A row with no `posted` date cannot be judged and stays.

This is a lens over the list, not a gate that clears `rank_pct`. Hidden by
default; the Over 30 days chip brings them back. Threshold is
`STALE_AFTER_DAYS` (30); exactly 30 days is not over 30.

`posted` is first published. `refreshed_at` is the employer's last update
(greenhouse `updated_at`, ashby `updatedAt` falling back to `publishedAt`,
lever `updatedAt` as epoch milliseconds). They are not the same question.

### A rule change has to re-run over rows already queued

`ingest/regate.mjs` blocked employers, blocked title-first domains, and
reopened retired salary skips. It did not re-run the whole gate over every
queued row. Teamworks "Senior Product Success Manager I" sat in the queue
after `roleEligible` started rejecting product-success titles, because
nothing re-ran the role rule against rows that were already there.

The queued pass reads the cached description through `fetchJd` and runs
`requirementsGate`. A submitted row is history and is never rewritten. A
row whose description cannot be read is unknown, not disqualifying -- 114
queued rows currently have no cached JD, and ruling those out would empty
a third of the list. Title-only rules still fire when the description is
missing, which is how Teamworks is caught either way.

---

## Two defects found and fixed by a queue audit, 2026-09-03

### The normalised-company-and-title dedupe guard only ran at submit time

The "Duplicates" section above describes comparing normalised company and
title -- that comparison existed, but only in `apply/batch.mjs`, seconds
before a submission. `ingest/sync-to-d1.mjs`, which decides what gets
WRITTEN to the queue in the first place, only checked an exact `dedupe_key`
or an exact normalised URL. Two still-queued, still-applyable rows for the
same posting could sit side by side for as long as neither had been
submitted yet, and an audit of the live queue found exactly that: Hopper's
"Principal Product Manager- Conversational AI" (Ashby) and "... Conversational
AI" with a comma instead of a hyphen (jobspresso) never collided on key or
URL, so both were written.

`normalizeForDedupe`/`sameJob` now live in `ingest/match.mjs`, shared by both
call sites, so the ingest-time guard and the submit-time guard cannot drift
apart again. `ingest/dedupe-queue.mjs` is the retroactive counterpart --
`node ingest/dedupe-queue.mjs --write` finds duplicate groups already sitting
in D1 (URL or normalised title, regardless of source) and skips every row in
a group except the one to keep, preferring an already-submitted row over a
higher-ranked queued one. Report-only without `--write`, same as `regate.mjs`.

It stays deliberately narrow: two titles that merely share most of their
words -- Bjak's "Product Manager - AI Stockbroking" and "... AI Stockbroking
App" -- are NOT grouped. That is the Cisco case above, run the other
direction: collapsing two different roles because their titles overlap is
the same mistake as failing to catch two identical roles because their
titles don't match exactly.

This does not reach rows written directly to D1 by the unidentified process
described under "Standing filters" below (capitalised source tags,
minute-truncated `updated_at`) before they are ingested -- there is no
ingest step to guard. `dedupe-queue.mjs` is the backstop for exactly that
case, since it compares whatever is already in D1 regardless of who wrote
it. Running it against the 2026-09-03 snapshot found five duplicate groups:
Hopper, Kin/"Kin Insurance" (identical Ashby URL, two different writers) and
Stripe among still-queued rows, plus Webflow and Twilio each carrying TWO
rows marked `submitted` for what reads as the same posting -- worth Brian's
own eyes, since a double-submission is not something a queue-side fix can
undo.

### A stale, unstripped duplicate of the clearance check in successScore

`domain-eligible.mjs`'s `CLEARANCE` check reads the description AFTER
benefits and legal boilerplate are stripped, and is the version wired into
`requirementsGate` -- the actual gate. `fit-score.mjs`'s `HARD_BLOCKERS` used
to carry its own separate `clearance` entry, checked inside `successScore`
against the RAW, unstripped description. The comment already sitting in
`domain-eligible.mjs` when this was found ("A security clearance was in
HARD_BLOCKERS but only cost 40 points off the success score") describes the
migration that was supposed to retire it; the entry itself was never
removed. The result: Elastic's own posting, whose only "clearance"-shaped
text is the "Employee Polygraph Protection Act" notice every US employer's
footer carries, passed the real gate (correctly) but still had 40 points
silently docked from its success score and "blocker: security clearance"
written into `rank_why`, with `blocked_reason` sitting null the whole time
-- ranked at 0, live in the queue, and self-contradictory on its face.
`HARD_BLOCKERS` no longer carries a `clearance` entry; the gate is now the
only place clearance is decided.
