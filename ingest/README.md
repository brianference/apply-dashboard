# ingest

Job-source layer for apply-dashboard. Node 22, plain ESM `.mjs`, no build step.
Reads public JSON/RSS feeds, scores them, and writes SQL. It never opens D1 and
never reads `.env`.

## Run

From the repo root:

```
node ingest/sources/greenhouse.mjs --query "product manager" --limit 50
node ingest/sources/lever.mjs --query "product manager"
node ingest/sources/ashby.mjs --query "product manager"
node ingest/sources/remoteok.mjs --query "product manager"
node ingest/sources/himalayas.mjs --query "product manager"
node ingest/sources/weworkremotely.mjs --query "product manager"
node ingest/sources/jobspresso.mjs --query "product manager"
node ingest/sources/indeed.mjs --query "product manager"
```

Indeed prints `no working Indeed source — see SOURCES-VERIFIED.md` and exits 1.

Collect, score, and emit SQL (does not execute it):

```
node ingest/upsert.mjs --from-sources --query "product manager"
```

Writes `ingest/out/jobs.json` and `ingest/out/upsert.sql`.

Check posting URLs in real Chromium (Playwright at
`C:\Users\brian\RedAnvil\node_modules\playwright`):

```
node ingest/link-check.mjs --help
node ingest/link-check.mjs
node ingest/link-check.mjs --input ingest/out/jobs.json --limit 20
```

Classifier self-check prints PASS/FAIL for seven known-correct hosts.

Tests:

```
node --test ingest/test/*.test.mjs
```

## Source interface

Each file in `ingest/sources/` exports:

```
export const meta = { id, name, homepage, kind, license }
export async function fetchJobs({ limit, query })
```

`fetchJobs` returns `{ company, title, url, source, work_type, posted }[]`.
Source modules do not touch a database.

ATS boards (Greenhouse, Lever, Ashby) iterate tokens in `companies.json`.
Every token in that file returned HTTP 200 with at least one posting in this
session. Evidence: `SOURCES-VERIFIED.md`.

## match_pct formula

Integer points, then clamp to 0..100. Same inputs always produce the same score.
Implementation: `ingest/match.mjs`.

Role (one bucket), from title:

- +40  `product manager` or `product owner`
- +30  contains `product` and (manager|lead|director|owner)
- +15  contains `product`
- +10  technical/program manager / TPM

Seniority (one bucket), from title:

- +20 principal
- +18 staff
- +15 senior / sr
- +12 lead
- +8  director

Domain (stackable), from title + work_type:

- +15 ai / ml / genai / llm / agentic / agent
- +10 platform
- +10 growth

Location (one bucket), from title + work_type:

- +15 remote AND US
- +8  remote only
- +5  US only

US matches `united states`, `usa`, `u.s.`, `americas`, or the word `us`.

Examples (from `ingest/test/match.test.mjs`):

- `Senior Product Manager, Growth` + `Remote United States` = 80
- `Principal Product Manager, AI Platform` + `Remote US` = 100
- `Product Manager` + `New York, NY` = 40

## Lane rules

- `ptc2c` when title or work_type matches contract, contractor, C2C, 1099,
  part-time, hourly, freelance, fractional, or consultant
- `ft` otherwise

`upsert.mjs` also sets `status` to `queued` and leaves `submitted_at` NULL.
Dedupe key is `lower(company) + "|" + lower(title)`. First row wins.
SQL values are escaped by doubling single quotes; the tool does not run the SQL.

## Link-check states

- `dead` — HTTP 404/410, suspended/parked host, or the page says the posting is closed/expired
- `wall` — HTTP 401/403, a security-verification interstitial, or a sign-in wall
- `live` — the posting rendered and an apply control is present

A recaptcha script tag is not a wall.

On 2026-08-23 the Gauge posting at `jobs.gusto.com` returned HTTP 410
"This job posting is no longer available" (screenshot in
`ingest/evidence/debug-pages/jobs_gusto_com.png`). The 2026-08-22 golden
table listed that host as a 403 wall. The classifier follows what the page
shows now: 410 is `dead`. The other six golden hosts match the table.
