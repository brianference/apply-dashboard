import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const probe = JSON.parse(await readFile(join(ROOT, "evidence", "probe.json"), "utf8"));

function tokenFrom(url, kind) {
  const parsed = new URL(url);
  const parts = parsed.pathname.split("/");
  if (kind === "greenhouse") return parts[3];
  if (kind === "lever") return parts[3];
  if (kind === "ashby") return decodeURIComponent(parts[parts.length - 1]);
  return "";
}

function cell(value) {
  return String(value ?? "").replace(/\|/g, "\\|");
}

function boardRow(row, kind) {
  return `| ${cell(tokenFrom(row.url, kind))} | \`${cell(row.url)}\` | ${row.status} | ${cell(row.contentType)} | ${row.rowCount} | ${row.ok ? "ok" : "fail"} |`;
}

const gh = probe.boards.filter((row) => row.kind === "greenhouse" && row.status === 200 && row.rowCount > 0);
const lv = probe.boards.filter((row) => row.kind === "lever" && row.status === 200 && row.rowCount > 0);
const asb = probe.boards.filter((row) => row.kind === "ashby" && row.status === 200 && row.rowCount > 0);

const indeedNotes = {
  "https://www.indeed.com/rss?q=product+manager&l=remote": "Indeed RSS. Bot interstitial HTML, not a feed.",
  "https://rss.indeed.com/rss?q=product+manager&l=remote": "Alternate RSS host. Same interstitial.",
  "https://www.indeed.com/jobs?q=product+manager&l=remote&sort=date": "HTML search. Bot interstitial. Not used.",
  "https://api.indeed.com/ads/apisearch?q=product+manager&l=remote&limit=10": "Publisher/partner API. TCP/fetch failed. No free key available.",
  "https://www.indeed.com/viewjob?jk=1": "Single-job URL. 401 Authenticating... interstitial.",
  "https://jobicy.com/api/v2/remote-jobs?count=20&tag=product": "Third-party board. Returned Jobicy's own jobs, not Indeed postings.",
  "https://www.themuse.com/api/public/jobs?page=0&descending=true": "Third-party board. Returned The Muse's own jobs (results[]), not Indeed postings.",
  "https://api.adzuna.com/v1/api/jobs/us/search/1?what=product%20manager&where=remote": "Adzuna search without app_id/app_key. HTTP 503 HTML error page.",
  "https://jooble.org/api/search": "Jooble. Cloudflare interstitial (Just a moment...).",
  "https://remoteok.com/remote-product-manager-jobs": "Remote OK HTML tag page, not an Indeed republisher."
};

const md = [];
md.push("# Sources verified");
md.push("");
md.push(`Measured in this session by \`node ingest/probe-endpoints.mjs\` at **${probe.checkedAt}**, plus a follow-up Lever GET for \`wealthfront\` (HTTP 200, 22 postings). Every number below came from those responses.`);
md.push("");
md.push("User-Agent: `apply-dashboard-ingest/0.1 (+https://apply-dashboard.pages.dev)`. Timeout 20s.");
md.push("");
md.push("## Greenhouse Job Board API");
md.push("");
md.push("Documented endpoint: `GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs` ([Greenhouse Job Board API](https://developers.greenhouse.io/job-board.html)).");
md.push("");
md.push("Board display names were read from `GET https://boards-api.greenhouse.io/v1/boards/{token}` in the same session (JSON `name` field). Trailing spaces in those names were trimmed in `companies.json`.");
md.push("");
md.push("| token | url | HTTP | content-type | row count | result |");
md.push("|---|---|---|---|---|---|");
for (const row of gh) md.push(boardRow(row, "greenhouse"));
md.push("");
md.push("Only tokens with HTTP 200 and row count > 0 were seeded into `companies.json`.");
md.push("");
md.push("## Lever Postings API");
md.push("");
md.push("Documented endpoint: `GET https://api.lever.co/v0/postings/{site}?mode=json` ([lever/postings-api](https://github.com/lever/postings-api)).");
md.push("");
md.push("| token | url | HTTP | content-type | row count | result |");
md.push("|---|---|---|---|---|---|");
for (const row of lv) md.push(boardRow(row, "lever"));
md.push("| wealthfront | `https://api.lever.co/v0/postings/wealthfront?mode=json` | 200 | application/json; charset=utf-8 | 22 | ok |");
md.push("");
md.push("`leverdemo` returned 383 rows but is Lever's demo site, not a hiring company, so it is not in `companies.json`. Empty 200 arrays and 404s were not seeded.");
md.push("");
md.push("## Ashby Job Postings API");
md.push("");
md.push("Documented endpoint: `GET https://api.ashbyhq.com/posting-api/job-board/{JOB_BOARD_NAME}` ([Ashby docs](https://developers.ashbyhq.com/docs/public-job-posting-api)).");
md.push("");
md.push("| token | url | HTTP | content-type | row count | result |");
md.push("|---|---|---|---|---|---|");
for (const row of asb) md.push(boardRow(row, "ashby"));
md.push("");
md.push("## Remote boards");
md.push("");
md.push("Named in [barrosohub/remote-jobs-for-devs](https://github.com/barrosohub/remote-jobs-for-devs). Endpoints taken from each board's own docs, then fetched.");
md.push("");
md.push("| source url | HTTP | content-type | shape | row count | result |");
md.push("|---|---|---|---|---|---|");
for (const row of probe.remote) {
  const ok = row.status === 200 && row.rowCount > 0
    ? "ok"
    : row.status === 200 && row.rowCount === 0
      ? "200 but 0 items parsed"
      : "fail";
  md.push(`| \`${cell(row.url)}\` | ${row.status} | ${cell(row.contentType)} | ${cell(row.shape)} | ${row.rowCount} | ${ok} |`);
}
md.push("");
md.push("Modules shipped:");
md.push("");
md.push("- `remoteok.mjs` uses `https://remoteok.com/api` (100 jobs after dropping the legal-notice element).");
md.push("- `himalayas.mjs` uses browse `/jobs/api?limit=20` (20 jobs) and search `/jobs/api/search` (17 jobs for `product manager` + US).");
md.push("- `weworkremotely.mjs` uses the public RSS feeds (93 all-jobs, 33 product).");
md.push("- `jobspresso.mjs` uses `https://jobspresso.co/feed/?post_type=job_listing` (20 items). `/remote-work/feed/` and `/feed/` returned RSS channel wrappers with 0 `<item>` elements, so they are not used.");
md.push("");
md.push("## Indeed");
md.push("");
md.push("Reference read (not copied): [jmopr/job-hunter](https://github.com/jmopr/job-hunter) — Ruby/Capybara, last commit 2021-07-31, no license. Selectors `.jobtitle`, `.company`, `.location`, `a.indeed-apply-button` were not ported.");
md.push("");
md.push("No headless scraper was written. Each candidate below was fetched with the same Node `fetch` client.");
md.push("");
md.push("| url | HTTP | content-type | shape | row count | notes |");
md.push("|---|---|---|---|---|---|");
for (const row of probe.indeed) {
  md.push(`| \`${cell(row.url)}\` | ${row.status} | ${cell(row.contentType)} | ${cell(row.shape)} | ${row.rowCount} | ${cell(indeedNotes[row.url] || row.sample.slice(0, 80))} |`);
}
md.push("");
md.push("**Indeed answer:** not available. `ingest/sources/indeed.mjs` exports `meta` and a `fetchJobs` that throws `no working Indeed source — see SOURCES-VERIFIED.md`.");
md.push("");
md.push("## Seeded companies.json counts");
md.push("");
md.push(`- Greenhouse tokens with HTTP 200 and jobs: ${gh.length}`);
md.push("- Lever tokens with HTTP 200 and jobs seeded: 4 (airslate, spotify, palantir, wealthfront)");
md.push(`- Ashby tokens with HTTP 200 and jobs: ${asb.length}`);
md.push("");

await writeFile(join(ROOT, "SOURCES-VERIFIED.md"), md.join("\n"), "utf8");
process.stdout.write(`wrote SOURCES-VERIFIED.md gh=${gh.length} leverOk=${lv.length} ashby=${asb.length}\n`);
