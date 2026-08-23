/**
 * One-shot probe of documented public job endpoints.
 * Writes ingest/evidence/probe.json with measured HTTP status, content-type, and row counts.
 * Not a source module — do not import from production code.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const TIMEOUT_MS = 20_000;
const UA = "apply-dashboard-ingest/0.1 (+https://apply-dashboard.pages.dev)";

/**
 * @param {string} url
 * @param {Record<string, string>} [extraHeaders]
 */
async function probe(url, extraHeaders = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": UA,
        accept: "application/json, application/xml, application/rss+xml, text/xml, text/html;q=0.8, */*;q=0.5",
        ...extraHeaders
      }
    });
    const contentType = res.headers.get("content-type") || "";
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString("utf8");
    let rowCount = null;
    let shape = "unknown";
    let sample = text.slice(0, 180).replace(/\s+/g, " ");
    try {
      const json = JSON.parse(text);
      if (Array.isArray(json)) {
        shape = "json-array";
        rowCount = json.filter((row) => row && typeof row === "object" && (row.title || row.position || row.text || row.id || row.company)).length;
        if (json.length > 0 && json[0] && json[0].legal) {
          // RemoteOK: first element is legal notice
          rowCount = json.filter((row) => row && row.id && row.position).length;
          shape = "remoteok-array";
        }
      } else if (json && Array.isArray(json.jobs)) {
        shape = "json-jobs";
        rowCount = json.jobs.length;
      } else if (json && Array.isArray(json.postings)) {
        shape = "json-postings";
        rowCount = json.postings.length;
      } else if (json && typeof json === "object") {
        shape = "json-object";
        rowCount = 0;
      }
    } catch {
      const items = text.match(/<item[\s>]/gi);
      const entries = text.match(/<entry[\s>]/gi);
      if (items || entries) {
        shape = "xml-feed";
        rowCount = (items ? items.length : 0) + (entries ? entries.length : 0);
      } else if (/captcha|unusual traffic|enable javascript|robot/i.test(text)) {
        shape = "bot-interstitial";
        rowCount = 0;
      } else {
        shape = "html-or-text";
        rowCount = 0;
      }
    }
    return {
      url,
      ok: res.ok,
      status: res.status,
      contentType,
      bytes: buf.length,
      ms: Date.now() - started,
      shape,
      rowCount,
      finalUrl: res.url,
      sample
    };
  } catch (error) {
    return {
      url,
      ok: false,
      status: 0,
      contentType: "",
      bytes: 0,
      ms: Date.now() - started,
      shape: "error",
      rowCount: 0,
      finalUrl: url,
      sample: String(error && error.message ? error.message : error)
    };
  } finally {
    clearTimeout(timer);
  }
}

const GREENHOUSE = [
  "gitlab", "stripe", "anthropic", "instacart", "sfox", "mindgrub", "coinbase",
  "fivetran", "samsara", "databricks", "reddit", "pinterest", "airbnb", "discord",
  "figma", "notion", "vercel", "dropbox", "robinhood", "doordash", "airtable",
  "asana", "mongodb", "duolingo", "gusto", "brex", "plaid", "hubspot", "zendesk",
  "canva", "grammarly", "intercom", "posthog", "temporal", "datadog", "sentry",
  "wikimedia", "coursera", "circle", "shopify", "chime", "snowflake", "amplitude",
  "mixpanel", "braze", "clickup", "webflow", "cloudflare", "digitalocean", "openai",
  "palantir", "anduril", "huggingface", "retool", "ramp", "mercury", "loom",
  "elastic", "twilio", "hashicorp", "confluent", "dbt", "dbtlabs", "mode",
  "segment", "iterable", "customerio", "freshworks", "atlassian", "linearapp",
  "cal", "remote", "heroku", "render", "flyio", "automattic", "wordpress",
  "github", "mozilla", "lyft", "uber", "spotify", "netflix", "block", "square",
  "affirm", "klarna", "wise", "sofi", "n26", "rippling", "deel", "remotecom",
  "flexport", "faire", "whatnot", "redditinc", "pinterestcareers", "twilioinc"
];

const LEVER = [
  "airslate", "lever", "leverdemo", "netflix", "spotify", "palantir", "twitch",
  "box", "lyft", "uber", "shopify", "reddit", "pinterest", "notion", "figma",
  "canva", "duolingo", "airtable", "asana", "intercom", "grafana", "hashicorp",
  "elastic", "twilio", "plaid", "brex", "ramp", "mercury", "deel", "remote",
  "rippling", "flexport", "faire", "whatnot", "chime", "sofi", "affirm",
  "circle", "kraken", "coinbase", "openai", "anthropic", "mistral", "huggingface",
  "retool", "linear", "vercel", "netlify", "cloudflare", "posthog", "sentry",
  "datadog", "snowflake", "databricks", "fivetran", "samsara", "instacart"
];

const ASHBY = [
  "tremendous", "Jerry.ai", "supabase", "docker", "chilipiper", "kraken.com",
  "kit", "delinea", "ashby", "linear", "notion", "ramp", "mercury", "retool",
  "vercel", "openai", "anthropic", "perplexity", "cursor", "anysphere",
  "pydantic", "langchain", "huggingface", "replicate", "modal", "together",
  "groq", "xai", "x.ai", "spacex", "tesla", "stripe", "gitlab", "posthog",
  "cal.com", "calcom", "resend", "planetscale", "neon", "turso", "fly.io",
  "railway", "render", "loom", "grain", "descript", "runway", "midjourney",
  "elevenlabs", "characterai", "adept", "cognition", "devin", "poolside"
];

async function runPool(items, worker, concurrency) {
  const out = [];
  let i = 0;
  async function next() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
  return out;
}

const boards = [];
const remote = [];
const indeed = [];

console.error("probing greenhouse...");
const gh = await runPool(GREENHOUSE, (token) => probe(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs`), 6);
for (const row of gh) {
  const token = new URL(row.url).pathname.split("/")[4];
  boards.push({ kind: "greenhouse", token, ...row });
}

console.error("probing lever...");
const lv = await runPool(LEVER, (token) => probe(`https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`), 6);
for (const row of lv) {
  const token = new URL(row.url).pathname.split("/")[3];
  boards.push({ kind: "lever", token, ...row });
}

console.error("probing ashby...");
const as = await runPool(ASHBY, (token) => probe(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}`), 6);
for (const row of as) {
  const token = decodeURIComponent(new URL(row.url).pathname.split("/").pop() || "");
  boards.push({ kind: "ashby", token, ...row });
}

console.error("probing remote boards...");
remote.push(await probe("https://remoteok.com/api"));
remote.push(await probe("https://remoteok.com/api?tag=product"));
remote.push(await probe("https://himalayas.app/jobs/api?limit=20"));
remote.push(await probe("https://himalayas.app/jobs/api/search?q=product%20manager&country=US"));
remote.push(await probe("https://weworkremotely.com/remote-jobs.rss"));
remote.push(await probe("https://weworkremotely.com/categories/remote-product-jobs.rss"));
remote.push(await probe("https://jobspresso.co/feed/?post_type=job_listing"));
remote.push(await probe("https://jobspresso.co/remote-work/feed/"));
remote.push(await probe("https://jobspresso.co/feed/"));
remote.push(await probe("https://jobspresso.co/job_feed/"));
remote.push(await probe("https://jobspresso.co/jobs/feed/"));

console.error("probing indeed variants...");
indeed.push(await probe("https://www.indeed.com/rss?q=product+manager&l=remote"));
indeed.push(await probe("https://rss.indeed.com/rss?q=product+manager&l=remote"));
indeed.push(await probe("https://www.indeed.com/jobs?q=product+manager&l=remote&sort=date"));
indeed.push(await probe("https://api.indeed.com/ads/apisearch?q=product+manager&l=remote&limit=10"));
indeed.push(await probe("https://www.indeed.com/viewjob?jk=1"));
indeed.push(await probe("https://jobicy.com/api/v2/remote-jobs?count=20&tag=product"));
indeed.push(await probe("https://www.themuse.com/api/public/jobs?page=0&descending=true"));
indeed.push(await probe("https://api.adzuna.com/v1/api/jobs/us/search/1?what=product%20manager&where=remote"));
indeed.push(await probe("https://jooble.org/api/search"));
indeed.push(await probe("https://remoteok.com/remote-product-manager-jobs"));

const summary = {
  checkedAt: new Date().toISOString(),
  greenhouseOk: boards.filter((b) => b.kind === "greenhouse" && b.status === 200 && b.rowCount > 0).map((b) => ({ token: b.token, status: b.status, contentType: b.contentType, rowCount: b.rowCount })),
  leverOk: boards.filter((b) => b.kind === "lever" && b.status === 200 && b.rowCount > 0).map((b) => ({ token: b.token, status: b.status, contentType: b.contentType, rowCount: b.rowCount })),
  ashbyOk: boards.filter((b) => b.kind === "ashby" && b.status === 200 && b.rowCount > 0).map((b) => ({ token: b.token, status: b.status, contentType: b.contentType, rowCount: b.rowCount })),
  boards,
  remote,
  indeed
};

await mkdir(join(ROOT, "evidence"), { recursive: true });
await writeFile(join(ROOT, "evidence", "probe.json"), JSON.stringify(summary, null, 2), "utf8");

console.log(JSON.stringify({
  greenhouseOk: summary.greenhouseOk.length,
  leverOk: summary.leverOk.length,
  ashbyOk: summary.ashbyOk.length,
  greenhouse: summary.greenhouseOk,
  lever: summary.leverOk,
  ashby: summary.ashbyOk,
  remote: remote.map((r) => ({ url: r.url, status: r.status, contentType: r.contentType, shape: r.shape, rowCount: r.rowCount, sample: r.sample })),
  indeed: indeed.map((r) => ({ url: r.url, status: r.status, contentType: r.contentType, shape: r.shape, rowCount: r.rowCount, finalUrl: r.finalUrl, sample: r.sample }))
}, null, 2));
