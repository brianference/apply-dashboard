# Sources verified

Measured in this session by `node ingest/probe-endpoints.mjs` at **2026-08-23T00:00:50.653Z**, plus a follow-up Lever GET for `wealthfront` (HTTP 200, 22 postings). Every number below came from those responses.

User-Agent: `apply-dashboard-ingest/0.1 (+https://apply-dashboard.pages.dev)`. Timeout 20s.

## Greenhouse Job Board API

Documented endpoint: `GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs` ([Greenhouse Job Board API](https://developers.greenhouse.io/job-board.html)).

Board display names were read from `GET https://boards-api.greenhouse.io/v1/boards/{token}` in the same session (JSON `name` field). Trailing spaces in those names were trimmed in `companies.json`.

| token | url | HTTP | content-type | row count | result |
|---|---|---|---|---|---|
| gitlab | `https://boards-api.greenhouse.io/v1/boards/gitlab/jobs` | 200 | application/json | 204 | ok |
| stripe | `https://boards-api.greenhouse.io/v1/boards/stripe/jobs` | 200 | application/json | 575 | ok |
| anthropic | `https://boards-api.greenhouse.io/v1/boards/anthropic/jobs` | 200 | application/json | 517 | ok |
| instacart | `https://boards-api.greenhouse.io/v1/boards/instacart/jobs` | 200 | application/json | 118 | ok |
| sfox | `https://boards-api.greenhouse.io/v1/boards/sfox/jobs` | 200 | application/json | 1 | ok |
| mindgrub | `https://boards-api.greenhouse.io/v1/boards/mindgrub/jobs` | 200 | application/json | 2 | ok |
| coinbase | `https://boards-api.greenhouse.io/v1/boards/coinbase/jobs` | 200 | application/json | 173 | ok |
| fivetran | `https://boards-api.greenhouse.io/v1/boards/fivetran/jobs` | 200 | application/json | 242 | ok |
| samsara | `https://boards-api.greenhouse.io/v1/boards/samsara/jobs` | 200 | application/json | 266 | ok |
| databricks | `https://boards-api.greenhouse.io/v1/boards/databricks/jobs` | 200 | application/json | 821 | ok |
| reddit | `https://boards-api.greenhouse.io/v1/boards/reddit/jobs` | 200 | application/json | 151 | ok |
| pinterest | `https://boards-api.greenhouse.io/v1/boards/pinterest/jobs` | 200 | application/json | 224 | ok |
| airbnb | `https://boards-api.greenhouse.io/v1/boards/airbnb/jobs` | 200 | application/json | 189 | ok |
| discord | `https://boards-api.greenhouse.io/v1/boards/discord/jobs` | 200 | application/json | 51 | ok |
| figma | `https://boards-api.greenhouse.io/v1/boards/figma/jobs` | 200 | application/json | 161 | ok |
| vercel | `https://boards-api.greenhouse.io/v1/boards/vercel/jobs` | 200 | application/json | 83 | ok |
| dropbox | `https://boards-api.greenhouse.io/v1/boards/dropbox/jobs` | 200 | application/json | 41 | ok |
| robinhood | `https://boards-api.greenhouse.io/v1/boards/robinhood/jobs` | 200 | application/json | 130 | ok |
| airtable | `https://boards-api.greenhouse.io/v1/boards/airtable/jobs` | 200 | application/json | 16 | ok |
| asana | `https://boards-api.greenhouse.io/v1/boards/asana/jobs` | 200 | application/json | 126 | ok |
| mongodb | `https://boards-api.greenhouse.io/v1/boards/mongodb/jobs` | 200 | application/json | 404 | ok |
| duolingo | `https://boards-api.greenhouse.io/v1/boards/duolingo/jobs` | 200 | application/json | 69 | ok |
| gusto | `https://boards-api.greenhouse.io/v1/boards/gusto/jobs` | 200 | application/json | 91 | ok |
| brex | `https://boards-api.greenhouse.io/v1/boards/brex/jobs` | 200 | application/json | 294 | ok |
| intercom | `https://boards-api.greenhouse.io/v1/boards/intercom/jobs` | 200 | application/json | 116 | ok |
| datadog | `https://boards-api.greenhouse.io/v1/boards/datadog/jobs` | 200 | application/json | 448 | ok |
| wikimedia | `https://boards-api.greenhouse.io/v1/boards/wikimedia/jobs` | 200 | application/json | 18 | ok |
| coursera | `https://boards-api.greenhouse.io/v1/boards/coursera/jobs` | 200 | application/json | 21 | ok |
| chime | `https://boards-api.greenhouse.io/v1/boards/chime/jobs` | 200 | application/json | 59 | ok |
| amplitude | `https://boards-api.greenhouse.io/v1/boards/amplitude/jobs` | 200 | application/json | 32 | ok |
| mixpanel | `https://boards-api.greenhouse.io/v1/boards/mixpanel/jobs` | 200 | application/json | 96 | ok |
| braze | `https://boards-api.greenhouse.io/v1/boards/braze/jobs` | 200 | application/json | 278 | ok |
| webflow | `https://boards-api.greenhouse.io/v1/boards/webflow/jobs` | 200 | application/json | 28 | ok |
| cloudflare | `https://boards-api.greenhouse.io/v1/boards/cloudflare/jobs` | 200 | application/json | 308 | ok |
| mercury | `https://boards-api.greenhouse.io/v1/boards/mercury/jobs` | 200 | application/json | 56 | ok |
| elastic | `https://boards-api.greenhouse.io/v1/boards/elastic/jobs` | 200 | application/json | 249 | ok |
| twilio | `https://boards-api.greenhouse.io/v1/boards/twilio/jobs` | 200 | application/json | 146 | ok |
| iterable | `https://boards-api.greenhouse.io/v1/boards/iterable/jobs` | 200 | application/json | 24 | ok |
| customerio | `https://boards-api.greenhouse.io/v1/boards/customerio/jobs` | 200 | application/json | 28 | ok |
| remote | `https://boards-api.greenhouse.io/v1/boards/remote/jobs` | 200 | application/json | 2 | ok |
| mozilla | `https://boards-api.greenhouse.io/v1/boards/mozilla/jobs` | 200 | application/json | 82 | ok |
| lyft | `https://boards-api.greenhouse.io/v1/boards/lyft/jobs` | 200 | application/json | 162 | ok |
| block | `https://boards-api.greenhouse.io/v1/boards/block/jobs` | 200 | application/json | 190 | ok |
| affirm | `https://boards-api.greenhouse.io/v1/boards/affirm/jobs` | 200 | application/json | 207 | ok |
| wise | `https://boards-api.greenhouse.io/v1/boards/wise/jobs` | 200 | application/json | 19 | ok |
| sofi | `https://boards-api.greenhouse.io/v1/boards/sofi/jobs` | 200 | application/json | 61 | ok |
| n26 | `https://boards-api.greenhouse.io/v1/boards/n26/jobs` | 200 | application/json | 76 | ok |
| remotecom | `https://boards-api.greenhouse.io/v1/boards/remotecom/jobs` | 200 | application/json | 226 | ok |
| flexport | `https://boards-api.greenhouse.io/v1/boards/flexport/jobs` | 200 | application/json | 164 | ok |
| faire | `https://boards-api.greenhouse.io/v1/boards/faire/jobs` | 200 | application/json | 62 | ok |

Only tokens with HTTP 200 and row count > 0 were seeded into `companies.json`.

## Lever Postings API

Documented endpoint: `GET https://api.lever.co/v0/postings/{site}?mode=json` ([lever/postings-api](https://github.com/lever/postings-api)).

| token | url | HTTP | content-type | row count | result |
|---|---|---|---|---|---|
| airslate | `https://api.lever.co/v0/postings/airslate?mode=json` | 200 | application/json; charset=utf-8 | 14 | ok |
| leverdemo | `https://api.lever.co/v0/postings/leverdemo?mode=json` | 200 | application/json; charset=utf-8 | 383 | ok |
| spotify | `https://api.lever.co/v0/postings/spotify?mode=json` | 200 | application/json; charset=utf-8 | 95 | ok |
| palantir | `https://api.lever.co/v0/postings/palantir?mode=json` | 200 | application/json; charset=utf-8 | 308 | ok |
| wealthfront | `https://api.lever.co/v0/postings/wealthfront?mode=json` | 200 | application/json; charset=utf-8 | 22 | ok |

`leverdemo` returned 383 rows but is Lever's demo site, not a hiring company, so it is not in `companies.json`. Empty 200 arrays and 404s were not seeded.

## Ashby Job Postings API

Documented endpoint: `GET https://api.ashbyhq.com/posting-api/job-board/{JOB_BOARD_NAME}` ([Ashby docs](https://developers.ashbyhq.com/docs/public-job-posting-api)).

| token | url | HTTP | content-type | row count | result |
|---|---|---|---|---|---|
| tremendous | `https://api.ashbyhq.com/posting-api/job-board/tremendous` | 200 | application/json; charset=utf-8 | 24 | ok |
| Jerry.ai | `https://api.ashbyhq.com/posting-api/job-board/Jerry.ai` | 200 | application/json; charset=utf-8 | 43 | ok |
| supabase | `https://api.ashbyhq.com/posting-api/job-board/supabase` | 200 | application/json; charset=utf-8 | 58 | ok |
| docker | `https://api.ashbyhq.com/posting-api/job-board/docker` | 200 | application/json; charset=utf-8 | 59 | ok |
| chilipiper | `https://api.ashbyhq.com/posting-api/job-board/chilipiper` | 200 | application/json; charset=utf-8 | 3 | ok |
| kraken.com | `https://api.ashbyhq.com/posting-api/job-board/kraken.com` | 200 | application/json; charset=utf-8 | 89 | ok |
| kit | `https://api.ashbyhq.com/posting-api/job-board/kit` | 200 | application/json; charset=utf-8 | 5 | ok |
| delinea | `https://api.ashbyhq.com/posting-api/job-board/delinea` | 200 | application/json; charset=utf-8 | 95 | ok |
| ashby | `https://api.ashbyhq.com/posting-api/job-board/ashby` | 200 | application/json; charset=utf-8 | 63 | ok |
| linear | `https://api.ashbyhq.com/posting-api/job-board/linear` | 200 | application/json; charset=utf-8 | 32 | ok |
| notion | `https://api.ashbyhq.com/posting-api/job-board/notion` | 200 | application/json; charset=utf-8 | 128 | ok |
| ramp | `https://api.ashbyhq.com/posting-api/job-board/ramp` | 200 | application/json; charset=utf-8 | 136 | ok |
| openai | `https://api.ashbyhq.com/posting-api/job-board/openai` | 200 | application/json; charset=utf-8 | 753 | ok |
| perplexity | `https://api.ashbyhq.com/posting-api/job-board/perplexity` | 200 | application/json; charset=utf-8 | 100 | ok |
| cursor | `https://api.ashbyhq.com/posting-api/job-board/cursor` | 200 | application/json; charset=utf-8 | 113 | ok |
| langchain | `https://api.ashbyhq.com/posting-api/job-board/langchain` | 200 | application/json; charset=utf-8 | 105 | ok |
| modal | `https://api.ashbyhq.com/posting-api/job-board/modal` | 200 | application/json; charset=utf-8 | 31 | ok |
| posthog | `https://api.ashbyhq.com/posting-api/job-board/posthog` | 200 | application/json; charset=utf-8 | 11 | ok |
| resend | `https://api.ashbyhq.com/posting-api/job-board/resend` | 200 | application/json; charset=utf-8 | 11 | ok |
| neon | `https://api.ashbyhq.com/posting-api/job-board/neon` | 200 | application/json; charset=utf-8 | 6 | ok |
| railway | `https://api.ashbyhq.com/posting-api/job-board/railway` | 200 | application/json; charset=utf-8 | 8 | ok |
| render | `https://api.ashbyhq.com/posting-api/job-board/render` | 200 | application/json; charset=utf-8 | 33 | ok |
| runway | `https://api.ashbyhq.com/posting-api/job-board/runway` | 200 | application/json; charset=utf-8 | 4 | ok |
| midjourney | `https://api.ashbyhq.com/posting-api/job-board/midjourney` | 200 | application/json; charset=utf-8 | 17 | ok |
| elevenlabs | `https://api.ashbyhq.com/posting-api/job-board/elevenlabs` | 200 | application/json; charset=utf-8 | 255 | ok |
| cognition | `https://api.ashbyhq.com/posting-api/job-board/cognition` | 200 | application/json; charset=utf-8 | 84 | ok |
| poolside | `https://api.ashbyhq.com/posting-api/job-board/poolside` | 200 | application/json; charset=utf-8 | 15 | ok |

## Remote boards

Named in [barrosohub/remote-jobs-for-devs](https://github.com/barrosohub/remote-jobs-for-devs). Endpoints taken from each board's own docs, then fetched.

| source url | HTTP | content-type | shape | row count | result |
|---|---|---|---|---|---|
| `https://remoteok.com/api` | 200 | application/json | remoteok-array | 100 | ok |
| `https://remoteok.com/api?tag=product` | 200 | application/json | remoteok-array | 100 | ok |
| `https://himalayas.app/jobs/api?limit=20` | 200 | application/json | json-jobs | 20 | ok |
| `https://himalayas.app/jobs/api/search?q=product%20manager&country=US` | 200 | application/json | json-jobs | 17 | ok |
| `https://weworkremotely.com/remote-jobs.rss` | 200 | application/rss+xml; charset=utf-8 | xml-feed | 93 | ok |
| `https://weworkremotely.com/categories/remote-product-jobs.rss` | 200 | application/rss+xml; charset=utf-8 | xml-feed | 33 | ok |
| `https://jobspresso.co/feed/?post_type=job_listing` | 200 | application/rss+xml; charset=UTF-8 | xml-feed | 20 | ok |
| `https://jobspresso.co/remote-work/feed/` | 200 | application/rss+xml; charset=UTF-8 | html-or-text | 0 | 200 but 0 items parsed |
| `https://jobspresso.co/feed/` | 200 | application/rss+xml; charset=UTF-8 | html-or-text | 0 | 200 but 0 items parsed |
| `https://jobspresso.co/job_feed/` | 200 | application/rss+xml; charset=UTF-8 | xml-feed | 10 | ok |
| `https://jobspresso.co/jobs/feed/` | 200 | application/rss+xml; charset=UTF-8 | xml-feed | 20 | ok |

Modules shipped:

- `remoteok.mjs` uses `https://remoteok.com/api` (100 jobs after dropping the legal-notice element).
- `himalayas.mjs` uses browse `/jobs/api?limit=20` (20 jobs) and search `/jobs/api/search` (17 jobs for `product manager` + US).
- `weworkremotely.mjs` uses the public RSS feeds (93 all-jobs, 33 product).
- `jobspresso.mjs` uses `https://jobspresso.co/feed/?post_type=job_listing` (20 items). `/remote-work/feed/` and `/feed/` returned RSS channel wrappers with 0 `<item>` elements, so they are not used.

## Indeed

Reference read (not copied): [jmopr/job-hunter](https://github.com/jmopr/job-hunter) — Ruby/Capybara, last commit 2021-07-31, no license. Selectors `.jobtitle`, `.company`, `.location`, `a.indeed-apply-button` were not ported.

No headless scraper was written. Each candidate below was fetched with the same Node `fetch` client.

| url | HTTP | content-type | shape | row count | notes |
|---|---|---|---|---|---|
| `https://www.indeed.com/rss?q=product+manager&l=remote` | 403 | text/html; charset=UTF-8 | bot-interstitial | 0 | Indeed RSS. Bot interstitial HTML, not a feed. |
| `https://rss.indeed.com/rss?q=product+manager&l=remote` | 403 | text/html; charset=UTF-8 | bot-interstitial | 0 | Alternate RSS host. Same interstitial. |
| `https://www.indeed.com/jobs?q=product+manager&l=remote&sort=date` | 403 | text/html; charset=UTF-8 | bot-interstitial | 0 | HTML search. Bot interstitial. Not used. |
| `https://api.indeed.com/ads/apisearch?q=product+manager&l=remote&limit=10` | 0 |  | error | 0 | Publisher/partner API. TCP/fetch failed. No free key available. |
| `https://www.indeed.com/viewjob?jk=1` | 401 | text/html | html-or-text | 0 | Single-job URL. 401 Authenticating... interstitial. |
| `https://jobicy.com/api/v2/remote-jobs?count=20&tag=product` | 200 | application/json; charset=utf-8 | json-jobs | 20 | Third-party board. Returned Jobicy's own jobs, not Indeed postings. |
| `https://www.themuse.com/api/public/jobs?page=0&descending=true` | 200 | application/json; charset=UTF-8 | json-object | 0 | Third-party board. Returned The Muse's own jobs (results[]), not Indeed postings. |
| `https://api.adzuna.com/v1/api/jobs/us/search/1?what=product%20manager&where=remote` | 503 | text/html | html-or-text | 0 | Adzuna search without app_id/app_key. HTTP 503 HTML error page. |
| `https://jooble.org/api/search` | 403 | text/html; charset=UTF-8 | bot-interstitial | 0 | Jooble. Cloudflare interstitial (Just a moment...). |
| `https://remoteok.com/remote-product-manager-jobs` | 200 | text/html; charset=UTF-8 | html-or-text | 0 | Remote OK HTML tag page, not an Indeed republisher. |

**Indeed answer:** not available. `ingest/sources/indeed.mjs` exports `meta` and a `fetchJobs` that throws `no working Indeed source — see SOURCES-VERIFIED.md`.

## Seeded companies.json counts

- Greenhouse tokens with HTTP 200 and jobs: 50
- Lever tokens with HTTP 200 and jobs seeded: 4 (airslate, spotify, palantir, wealthfront)
- Ashby tokens with HTTP 200 and jobs: 27
