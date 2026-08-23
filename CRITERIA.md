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
