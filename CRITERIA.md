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
| Freshness | posted in the last 5 days |

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
| Domain | product, infra, developer tools | healthcare, construction, clearance, risk/compliance (title) |
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
