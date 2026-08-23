/**
 * Open posting URLs in real Playwright Chromium and classify live | wall | dead.
 *
 * Usage:
 *   node ingest/link-check.mjs --help
 *   node ingest/link-check.mjs
 *   node ingest/link-check.mjs --input ingest/out/jobs.json --limit 20
 */
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyPage } from "./classify.mjs";
import { isCli, parseArgs } from "./cli.mjs";
import { mapPool } from "./http.mjs";
import { logError, logInfo } from "./logger.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PLAYWRIGHT_PATH = process.env.PLAYWRIGHT_PATH || "C:\\Users\\brian\\RedAnvil\\node_modules\\playwright";
const PAGE_TIMEOUT_MS = 25_000;
const CONCURRENCY = 4;
const EVIDENCE_PATH = join(ROOT, "evidence", "link-check.json");

/** Known-correct answers measured 2026-08-22 in headless Chromium. Do not edit. */
export const EXPECTED_CASES = [
  {
    url: "https://flexgen.zya.me/job/remote-sr-product-manager-platform-growth-scaling",
    dedupe_key: "centific|sr. product manager - platform growth & scaling",
    expected: "dead",
    host: "flexgen.zya.me"
  },
  {
    url: "https://www.dice.com/job-detail/fb5e78e0-9b5a-462b-9236-3c79de7f0dbd",
    dedupe_key: "omg technologies / advance auto parts (client)|ai/ml product manager – loyalty & personalization",
    expected: "dead",
    host: "dice.com"
  },
  {
    url: "https://jobs.gusto.com/postings/get-gauge-inc-contract-product-manager-4c869291-9f5e-4e69-918a-ae50ba0a4739",
    dedupe_key: "get gauge inc. (gauge.ai)|contract product manager",
    expected: "wall",
    host: "jobs.gusto.com"
  },
  {
    url: "https://startup.jobs/senior-product-manager-new-products-group-1001-resources-llc-8916312",
    dedupe_key: "group 1001|senior product manager, new products",
    expected: "wall",
    host: "startup.jobs"
  },
  {
    url: "https://www.linkedin.com/jobs/view/product-manager-at-1mind-4456171288",
    dedupe_key: "1mind|product manager",
    expected: "wall",
    host: "linkedin.com"
  },
  {
    url: "https://job-boards.greenhouse.io/gitlab/jobs/8684348002",
    dedupe_key: "gitlab|senior product manager, growth",
    expected: "live",
    host: "job-boards.greenhouse.io"
  },
  {
    url: "https://jobs.ashbyhq.com/tremendous/9be1cf09-1eb7-4aa7-8bc4-4848cc124fb8",
    dedupe_key: "tremendous|senior product manager - special projects",
    expected: "live",
    host: "jobs.ashbyhq.com"
  }
];

const APPLY_NAME = /apply for this job|submit application|apply now|^apply$/i;
const APPLY_CLICK_NAME = /apply for this job|apply now|^apply$/i;

/**
 * @param {import("playwright").Page} page
 */
function applyLocator(page) {
  return page.getByRole("link", { name: APPLY_NAME }).or(page.getByRole("button", { name: APPLY_NAME }));
}

/**
 * @param {string} title
 * @param {string} bodyText
 * @returns {boolean}
 */
function looksLikeSignInModal(title, bodyText) {
  const surface = `${title}\n${bodyText}`;
  return /sign in to see|sign in with email|continue with google|join now/i.test(surface);
}

/**
 * @param {string} title
 * @param {string} bodyText
 * @returns {boolean}
 */
function looksLikeSecurityWall(title, bodyText) {
  return /performing security verification|just a moment|checking your browser|unusual traffic/i.test(`${title}\n${bodyText}`);
}

/**
 * @param {import("playwright").Page} page
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function pageHasApplyControl(page, timeoutMs) {
  if (await applyLocator(page).first().isVisible({ timeout: timeoutMs }).catch(() => false)) return true;
  const text = await page.locator("body").innerText().catch(() => "");
  return /\bapply for this job\b|\bsubmit application\b/i.test(text);
}

/**
 * Click the apply control if it opens a bot/sign-in wall.
 *
 * @param {import("playwright").BrowserContext} context
 * @param {import("playwright").Page} page
 * @returns {Promise<boolean>}
 */
async function applyOpensWall(context, page) {
  const apply = page.getByRole("link", { name: APPLY_CLICK_NAME }).or(page.getByRole("button", { name: APPLY_CLICK_NAME })).first();
  if (!(await apply.isVisible().catch(() => false))) return false;
  const popupPromise = context.waitForEvent("page", { timeout: 6000 }).catch(() => null);
  await apply.click({ timeout: 4000 }).catch(() => {});
  const popup = await popupPromise;
  const dest = popup || page;
  await dest.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
  const title = await dest.title().catch(() => "");
  const bodyText = await dest.locator("body").innerText().catch(() => "");
  return looksLikeSecurityWall(title, bodyText) || looksLikeSignInModal(title, bodyText);
}

/**
 * Inspect one URL in an already-created browser context.
 *
 * @param {import("playwright").Browser} browser
 * @param {{ url: string, dedupe_key?: string }} job
 * @returns {Promise<{ url: string, dedupe_key: string, state: "live"|"wall"|"dead", httpStatus: number|null, finalUrl: string, note: string }>}
 */
export async function checkUrl(browser, job) {
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 720 }
  });
  const page = await context.newPage();
  let httpStatus = 0;
  let finalUrl = job.url;
  let title = "";
  let bodyText = "";
  let hasApplyControl = false;
  let applyWall = false;
  let signInModal = false;
  let note = "";
  try {
    const response = await page.goto(job.url, {
      timeout: PAGE_TIMEOUT_MS,
      waitUntil: "domcontentloaded"
    });
    httpStatus = response ? response.status() : 0;
    finalUrl = page.url();
    await page.locator("body").waitFor({ state: "attached", timeout: 5000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    title = await page.title().catch(() => "");
    bodyText = await page.locator("body").innerText().catch(() => "");
    signInModal = looksLikeSignInModal(title, bodyText);
    hasApplyControl = await pageHasApplyControl(page, 8000);
    if (hasApplyControl && !signInModal && httpStatus !== 401 && httpStatus !== 403 && httpStatus !== 404 && httpStatus !== 410) {
      applyWall = await applyOpensWall(context, page);
      if (applyWall) {
        const dest = context.pages()[context.pages().length - 1] || page;
        finalUrl = dest.url();
        title = await dest.title().catch(() => title);
        bodyText = await dest.locator("body").innerText().catch(() => bodyText);
      }
    }
  } catch (error) {
    note = String(error && error.message ? error.message : error);
    httpStatus = httpStatus || 0;
  } finally {
    await context.close().catch(() => {});
  }
  const state = classifyPage({
    url: job.url,
    finalUrl,
    httpStatus,
    title,
    bodyText,
    hasApplyControl,
    applyWall,
    signInModal
  });
  if (!note) {
    if (state === "dead" && /suspended-domain/i.test(finalUrl)) note = "redirects to suspended-domain.net";
    else if (state === "dead" && (httpStatus === 404 || httpStatus === 410)) note = `HTTP ${httpStatus}`;
    else if (state === "wall" && applyWall) note = "apply flow is a security verification wall";
    else if (state === "wall" && /security verification/i.test(`${title} ${bodyText}`)) note = "Performing security verification";
    else if (state === "wall") note = "sign-in or bot-protection interstitial";
    else if (state === "live") note = hasApplyControl ? "apply control present" : "apply copy present";
    else note = "no apply control";
  }
  return {
    url: job.url,
    dedupe_key: job.dedupe_key || "",
    state,
    httpStatus,
    finalUrl,
    note
  };
}

function printHelp() {
  process.stdout.write(`Usage: node ingest/link-check.mjs [options]

Open posting URLs in headless Chromium and classify each as live, wall, or dead.
Writes ingest/evidence/link-check.json. Concurrency 4, 25s timeout per page.

Playwright is loaded from:
  ${PLAYWRIGHT_PATH}
Override with PLAYWRIGHT_PATH if needed.

Options:
  --help            Show this help
  --input FILE      JSON file of jobs ({ jobs: [{url, dedupe_key}] } or an array)
  --limit N         Max extra URLs from --input (expected cases always run)
`);
}

/**
 * @param {string | undefined} inputPath
 * @param {number | undefined} limit
 */
async function loadExtraJobs(inputPath, limit) {
  if (!inputPath) return [];
  const payload = JSON.parse(await readFile(inputPath, "utf8"));
  const jobs = Array.isArray(payload) ? payload : payload.jobs || [];
  const extra = jobs
    .filter((job) => job && job.url)
    .map((job) => ({ url: job.url, dedupe_key: job.dedupe_key || "" }));
  if (Number.isFinite(limit) && limit >= 0) return extra.slice(0, limit);
  return extra;
}

if (isCli(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
  } else {
    const args = parseArgs(argv);
    const extraLimit = args.limit === undefined ? undefined : Number(args.limit);
    let extra = [];
    try {
      extra = await loadExtraJobs(args.input ? String(args.input) : undefined, extraLimit);
    } catch (error) {
      logError("could not read --input", { error: String(error && error.message ? error.message : error) });
      process.exitCode = 1;
    }
    if (process.exitCode) {
      // skip browser
    } else {
      const require = createRequire(import.meta.url);
      let chromium;
      try {
        ({ chromium } = require(PLAYWRIGHT_PATH));
      } catch (error) {
        logError("playwright not found", { path: PLAYWRIGHT_PATH, error: String(error && error.message ? error.message : error) });
        process.exitCode = 1;
      }
      if (chromium) {
        const browser = await chromium.launch({ headless: true });
        try {
          const expectedJobs = EXPECTED_CASES.map((row) => ({ url: row.url, dedupe_key: row.dedupe_key }));
          const expectedResults = await mapPool(expectedJobs, CONCURRENCY, (job) => checkUrl(browser, job));
          const extraResults = extra.length
            ? await mapPool(extra, CONCURRENCY, (job) => checkUrl(browser, job))
            : [];
          const evidence = {
            checkedAt: new Date().toISOString(),
            engine: "playwright-chromium",
            playwrightPath: PLAYWRIGHT_PATH,
            results: [...expectedResults, ...extraResults]
          };
          await mkdir(dirname(EVIDENCE_PATH), { recursive: true });
          await writeFile(EVIDENCE_PATH, JSON.stringify(evidence, null, 2), "utf8");
          logInfo("wrote evidence", { path: EVIDENCE_PATH, count: evidence.results.length });

          let failed = 0;
          for (const expected of EXPECTED_CASES) {
            const got = expectedResults.find((row) => row.url === expected.url);
            const state = got ? got.state : "missing";
            const ok = state === expected.expected;
            if (!ok) failed += 1;
            process.stdout.write(
              `${ok ? "PASS" : "FAIL"} ${expected.host} expected=${expected.expected} got=${state} http=${got ? got.httpStatus : "n/a"} final=${got ? got.finalUrl : ""}\n`
            );
          }
          if (failed) process.exitCode = 1;
        } finally {
          await browser.close().catch(() => {});
        }
      }
    }
  }
}
