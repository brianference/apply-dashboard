/**
 * Resolve the real employer apply URL behind an aggregator listing.
 *
 * Five hosts in the queue are not application forms -- they are indexes that
 * point at somebody else's ATS. Each one exposes (or hides) the outbound link
 * differently, and every mechanism below was found by opening real postings
 * rather than assumed:
 *
 *   workingnomads.com  the posting renders <a class="jd-apply-btn" href="/job/go/<id>/">
 *                      and that path 302s straight to the employer's ATS.
 *   weworkremotely.com the apply CTA is <a id="job-cta-alt">. On most listings
 *                      it carries class "apply-btn--locked" and points at
 *                      /job-seekers/account/register -- the outbound URL is
 *                      withheld until you make an account. On the rest the href
 *                      IS the employer URL.
 *   himalayas.app      Cloudflare Turnstile answers a headless fetch with 403,
 *                      so this host needs a real browser. Even past the
 *                      challenge the RSC payload serialises applicationLink as
 *                      "$undefined" and the Apply CTA points at /signup/talent.
 *   monster.com        DataDome. 403 with a geo.captcha-delivery.com iframe for
 *                      both curl and Playwright. No JSON endpoint answered.
 *   dice.com           Server-rendered, and the ld+json JobPosting carries no
 *                      apply URL. Dice's own RSC records applyType "Internal",
 *                      so there is no outbound URL to find in the first place.
 *
 * Nothing is guessed. A link found in the job DESCRIPTION is not treated as the
 * apply URL: himalayas' Orderly Network posting embeds a greenhouse referral
 * link in its body that 404s, which is exactly the false positive that would
 * produce. A row that cannot be resolved is recorded with the HTTP status and
 * the reason, never with a plausible-looking URL.
 *
 * Read only. This writes one JSON file and never touches the database.
 *
 *   node ingest/resolve-outbound.mjs
 *   node ingest/resolve-outbound.mjs --host weworkremotely.com
 *   node ingest/resolve-outbound.mjs --limit 5 --out ingest/out/sample.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname)
  .replace(/^\/([A-Za-z]:)/, '$1'), '..');
const OUT_DIR = path.join(ROOT, 'ingest', 'out');
const API = 'https://apply-dashboard.pages.dev/api/jobs';
const PLAYWRIGHT = 'C:/Users/brian/RedAnvil/node_modules/playwright';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 25000;
const HOST_DELAY_MS = 900;      /* one request per host per second, roughly */
const MAX_REDIRECT_HOPS = 8;
const CF_SETTLE_TRIES = 20;
const CF_SETTLE_WAIT_MS = 1500;

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};
const LIMIT = Number(flag('--limit')) || Infinity;
const ONLY_HOST = flag('--host');
const OUT_PATH = flag('--out')
  ? path.resolve(ROOT, flag('--out'))
  : path.join(OUT_DIR, 'outbound.json');

/** Hostnames handled here, www-stripped. */
const AGGREGATORS = new Set([
  'workingnomads.com',
  'weworkremotely.com',
  'himalayas.app',
  'monster.com',
  'dice.com',
]);

/** Hostname patterns for the applicant tracking systems we care about. */
const ATS_HOSTS = [
  [/(^|\.)greenhouse\.io$/i, 'greenhouse'],
  [/(^|\.)ashbyhq\.com$/i, 'ashby'],
  [/(^|\.)lever\.co$/i, 'lever'],
  [/myworkdayjobs\.com$/i, 'workday'],
  [/(^|\.)smartrecruiters\.com$/i, 'smartrecruiters'],
  [/(^|\.)icims\.com$/i, 'icims'],
  [/(^|\.)jobvite\.com$/i, 'jobvite'],
  [/(^|\.)workable\.com$/i, 'workable'],
  [/(^|\.)breezy\.hr$/i, 'breezy'],
  [/(^|\.)recruitee\.com$/i, 'recruitee'],
  [/(^|\.)bamboohr\.com$/i, 'bamboohr'],
  [/(^|\.)teamtailor\.com$/i, 'teamtailor'],
  [/(^|\.)rippling(-ats)?\.com$/i, 'rippling'],
  [/(^|\.)applytojob\.com$/i, 'jazzhr'],
  [/(^|\.)paylocity\.com$/i, 'paylocity'],
  [/(^|\.)successfactors\.com$/i, 'successfactors'],
  [/(^|\.)taleo\.net$/i, 'taleo'],
];

/**
 * Strip a leading www. so hostnames compare cleanly.
 * @param {string} url
 * @returns {string|null} hostname, or null if the URL will not parse
 */
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Name the applicant tracking system a resolved URL belongs to.
 * @param {string|null} url final outbound URL
 * @returns {string} one of the ATS names, 'mailto', 'other', or 'unresolved'
 */
function classifyAts(url) {
  if (!url) return 'unresolved';
  if (/^mailto:/i.test(url)) return 'mailto';
  const host = hostOf(url);
  if (!host) return 'other';
  for (const [re, name] of ATS_HOSTS) if (re.test(host)) return name;
  return 'other';
}

/**
 * Fetch with a hard timeout, returning the body even on a non-2xx so the
 * status can be reported as evidence rather than swallowed.
 * @param {string} url
 * @param {{redirect?: 'follow'|'manual'}} [opts]
 * @returns {Promise<{status:number|null, body:string, location:string|null, finalUrl:string|null, error:string|null}>}
 */
async function get(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: opts.redirect || 'follow',
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8' },
    });
    let body = '';
    try {
      body = await res.text();
    } catch {
      body = '';
    }
    return {
      status: res.status,
      body,
      location: res.headers.get('location'),
      finalUrl: res.url || null,
      error: null,
    };
  } catch (err) {
    return { status: null, body: '', location: null, finalUrl: null, error: String(err && err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Walk a redirect chain by hand so the FINAL destination is recorded rather
 * than whatever fetch happened to land on. Stops at the first non-redirect.
 * @param {string} start
 * @returns {Promise<{url:string|null, status:number|null, hops:number, error:string|null}>}
 */
async function followRedirects(start) {
  let url = start;
  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
    const res = await get(url, { redirect: 'manual' });
    if (res.error) return { url: hop ? url : null, status: null, hops: hop, error: res.error };
    if (res.status >= 300 && res.status < 400 && res.location) {
      try {
        url = new URL(res.location, url).toString();
      } catch {
        return { url, status: res.status, hops: hop, error: `unparseable Location: ${res.location}` };
      }
      continue;
    }
    return { url, status: res.status, hops: hop, error: null };
  }
  return { url, status: null, hops: MAX_REDIRECT_HOPS, error: 'redirect loop' };
}

/**
 * Pull the href out of the first <a> tag whose attributes match a pattern.
 * Attribute order varies across the three places Working Nomads renders its
 * apply button, so the tag is matched whole and the href read out of it.
 * @param {string} html
 * @param {RegExp} tagPattern must match somewhere inside the opening <a ...>
 * @returns {string|null}
 */
function hrefOfAnchor(html, tagPattern) {
  for (const m of html.matchAll(/<a\b[^>]*>/g)) {
    const tag = m[0];
    if (!tagPattern.test(tag)) continue;
    const href = tag.match(/href="([^"]*)"/);
    if (href) return decodeEntities(href[1]);
  }
  return null;
}

/**
 * Undo the handful of HTML entities that turn up inside href attributes.
 * @param {string} s
 * @returns {string}
 */
function decodeEntities(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}

/**
 * Working Nomads: scrape the /job/go/<id>/ apply path off the posting, then
 * follow its 302 to the employer.
 * @param {{url:string}} job
 * @returns {Promise<object>} partial row
 */
async function resolveWorkingNomads(job) {
  const page = await get(job.url);
  if (page.error) return { outbound_url: null, method: 'wn-job-go-redirect', http_status: null, error: page.error };
  if (page.status !== 200) {
    return { outbound_url: null, method: 'wn-job-go-redirect', http_status: page.status, error: `posting returned ${page.status}` };
  }
  const href = hrefOfAnchor(page.body, /jd-apply-btn/)
    || (page.body.match(/href="(\/job\/go\/\d+\/?)"/) || [])[1] || null;
  if (!href) {
    /* Working Nomads drops the apply button entirely once a listing lapses and
       renders jd-expired-notice in its place, so an absent button is usually a
       dead posting rather than a scraping miss. Say which. */
    const expired = /jd-expired-notice/.test(page.body);
    return {
      outbound_url: null,
      method: 'wn-job-go-redirect',
      http_status: page.status,
      error: expired
        ? 'listing expired: posting renders jd-expired-notice and no apply button'
        : 'no jd-apply-btn anchor on the posting',
    };
  }
  const go = new URL(href, job.url).toString();
  const hop = await followRedirects(go);
  if (hop.error) return { outbound_url: hop.url, method: 'wn-job-go-redirect', http_status: hop.status, error: hop.error };
  if (hostOf(hop.url) === 'workingnomads.com') {
    return { outbound_url: null, method: 'wn-job-go-redirect', http_status: hop.status, error: `apply path stayed on workingnomads: ${hop.url}` };
  }
  return { outbound_url: hop.url, method: 'wn-job-go-redirect', http_status: hop.status, error: null };
}

/**
 * We Work Remotely: read the href off the apply CTA. Locked listings point the
 * CTA at the registration page instead of the employer.
 * @param {{url:string}} job
 * @returns {Promise<object>} partial row
 */
async function resolveWeWorkRemotely(job) {
  const page = await get(job.url);
  if (page.error) return { outbound_url: null, method: 'wwr-job-cta-alt', http_status: null, error: page.error };
  if (page.status !== 200) {
    return { outbound_url: null, method: 'wwr-job-cta-alt', http_status: page.status, error: `posting returned ${page.status}` };
  }
  const href = hrefOfAnchor(page.body, /id="job-cta-alt"/);
  if (!href) {
    return { outbound_url: null, method: 'wwr-job-cta-alt', http_status: page.status, error: 'no #job-cta-alt apply CTA on the posting' };
  }
  const abs = /^https?:|^mailto:/i.test(href) ? href : new URL(href, job.url).toString();
  const host = hostOf(abs);
  if (host === 'weworkremotely.com' || /^\/job-seekers\/account\/register/.test(href)) {
    const locked = /apply-btn--locked/.test(page.body);
    return {
      outbound_url: null,
      method: 'wwr-job-cta-alt',
      http_status: page.status,
      error: locked
        ? 'account required: apply CTA is apply-btn--locked and points at /job-seekers/account/register'
        : `apply CTA stayed on weworkremotely: ${abs}`,
    };
  }
  /* The CTA can be the employer's own site rather than an ATS; follow it so the
     row records where an applicant actually lands. */
  if (/^mailto:/i.test(abs)) {
    return { outbound_url: abs, method: 'wwr-job-cta-alt', http_status: page.status, error: null };
  }
  const hop = await followRedirects(abs);
  return {
    outbound_url: hop.url || abs,
    method: 'wwr-job-cta-alt',
    http_status: hop.status,
    error: hop.error,
  };
}

/**
 * Dice: the posting is server-rendered but carries no outbound apply URL. A
 * pulled listing answers 410 and says so in the body.
 * @param {{url:string}} job
 * @returns {Promise<object>} partial row
 */
async function resolveDice(job) {
  const page = await get(job.url);
  if (page.error) return { outbound_url: null, method: 'dice-page', http_status: null, error: page.error };
  const gone = page.status === 410 || /no longer available/i.test(page.body);
  if (gone) {
    return { outbound_url: null, method: 'dice-page', http_status: page.status, error: 'listing expired: dice returned 410 / "no longer available"' };
  }
  /* Dice records how the posting is applied to in its own RSC payload. */
  const applyType = (page.body.match(/applyType\\?":\\?"([A-Za-z]+)/) || [])[1] || null;
  if (applyType && /internal/i.test(applyType)) {
    return { outbound_url: null, method: 'dice-page', http_status: page.status, error: 'dice applyType=Internal: the apply form is hosted on dice, there is no outbound employer URL' };
  }
  const ld = jobPostingLd(page.body);
  const direct = ld && typeof ld.url === 'string' && hostOf(ld.url) !== 'dice.com' ? ld.url : null;
  if (direct) {
    const hop = await followRedirects(direct);
    return { outbound_url: hop.url || direct, method: 'dice-json-ld', http_status: hop.status, error: hop.error };
  }
  return { outbound_url: null, method: 'dice-page', http_status: page.status, error: `no outbound apply URL on the posting (applyType=${applyType})` };
}

/**
 * Monster: DataDome answers anonymous traffic with a captcha page.
 * @param {{url:string}} job
 * @returns {Promise<object>} partial row
 */
async function resolveMonster(job) {
  const page = await get(job.url);
  if (page.error) return { outbound_url: null, method: 'monster-page', http_status: null, error: page.error };
  if (/captcha-delivery\.com/.test(page.body)) {
    return { outbound_url: null, method: 'monster-page', http_status: page.status, error: `DataDome bot wall: HTTP ${page.status} with a geo.captcha-delivery.com captcha iframe` };
  }
  if (page.status !== 200) {
    return { outbound_url: null, method: 'monster-page', http_status: page.status, error: `posting returned ${page.status}` };
  }
  const ld = jobPostingLd(page.body);
  const direct = ld && typeof ld.url === 'string' && hostOf(ld.url) !== 'monster.com' ? ld.url : null;
  if (direct) {
    const hop = await followRedirects(direct);
    return { outbound_url: hop.url || direct, method: 'monster-json-ld', http_status: hop.status, error: hop.error };
  }
  return { outbound_url: null, method: 'monster-page', http_status: page.status, error: 'no outbound apply URL in the posting ld+json' };
}

/**
 * Parse the first schema.org JobPosting out of a page's ld+json blocks.
 * @param {string} html
 * @returns {object|null}
 */
function jobPostingLd(html) {
  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(m[1]);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const hit = list.find((x) => x && x['@type'] === 'JobPosting');
      if (hit) return hit;
    } catch {
      /* a malformed block is not a reason to abandon the rest */
    }
  }
  return null;
}

/**
 * Himalayas sits behind a Cloudflare Turnstile challenge that a headless
 * browser does not clear, so this host is driven with a visible one. The page
 * is read for the Apply CTA and for the applicationLink field in the Next.js
 * RSC payload.
 * @param {import('playwright').BrowserContext} ctx
 * @param {{url:string}} job
 * @returns {Promise<object>} partial row
 */
async function resolveHimalayas(ctx, job) {
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const status = resp ? resp.status() : null;
    for (let i = 0; i < CF_SETTLE_TRIES; i++) {
      const title = await page.title();
      if (title && !/just a moment|attention required/i.test(title)) break;
      await page.waitForTimeout(CF_SETTLE_WAIT_MS);
    }
    const title = await page.title();
    if (/just a moment|attention required/i.test(title)) {
      return { outbound_url: null, method: 'himalayas-apply-cta', http_status: status, error: 'Cloudflare challenge did not clear' };
    }
    const html = await page.content();

    let href = null;
    const cta = page.getByRole('link', { name: /^\s*apply/i }).first();
    if (await cta.count()) href = await cta.getAttribute('href');

    if (href && /^https?:/i.test(href) && hostOf(href) !== 'himalayas.app') {
      const hop = await followRedirects(href);
      return { outbound_url: hop.url || href, method: 'himalayas-apply-cta', http_status: hop.status, error: hop.error };
    }
    /* applicationLink is the field that would carry the employer URL. It comes
       back as the literal "$undefined" for anonymous readers. */
    const appLink = (html.match(/applicationLink\\?":\\?"([^"\\]*)/) || [])[1] || null;
    if (appLink && /^https?:/i.test(appLink) && hostOf(appLink) !== 'himalayas.app') {
      const hop = await followRedirects(appLink);
      return { outbound_url: hop.url || appLink, method: 'himalayas-rsc-application-link', http_status: hop.status, error: hop.error };
    }
    const gated = href && /\/signup\//.test(href);
    return {
      outbound_url: null,
      method: 'himalayas-apply-cta',
      http_status: status,
      error: gated
        ? `signup required: Apply CTA points at ${href} and the RSC applicationLink is ${appLink || 'absent'}`
        : `no outbound apply URL (CTA href=${href}, applicationLink=${appLink})`,
    };
  } catch (err) {
    return { outbound_url: null, method: 'himalayas-apply-cta', http_status: null, error: String(err && err.message || err).split('\n')[0] };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ run */

const live = await fetch(API, { headers: { 'cache-control': 'no-cache' } })
  .then((r) => r.json())
  .catch((e) => {
    console.error(`could not read ${API}: ${e.message}`);
    process.exit(1);
  });

const queued = live.jobs
  .filter((j) => j.status === 'queued')
  .map((j) => ({ ...j, host: hostOf(j.url) }))
  .filter((j) => j.host && AGGREGATORS.has(j.host))
  .filter((j) => !ONLY_HOST || j.host === ONLY_HOST.replace(/^www\./, ''))
  .slice(0, LIMIT);

const byHost = {};
for (const j of queued) (byHost[j.host] = byHost[j.host] || []).push(j);

console.log(`resolving outbound apply URLs for ${queued.length} queued aggregator rows`);
for (const [h, rows] of Object.entries(byHost)) console.log(`  ${h.padEnd(20)} ${rows.length}`);
console.log('');

let browser = null;
let ctx = null;
if (byHost['himalayas.app'] && byHost['himalayas.app'].length) {
  /* Headless chromium never clears himalayas' Turnstile challenge; a visible
     one does. This is why the script opens a window. */
  const { chromium } = require(PLAYWRIGHT);
  browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
  ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  console.log('himalayas rows present -> launched a visible browser for the Cloudflare challenge\n');
}

/** @type {Array<object>} */
const rows = [];

/**
 * Resolve one host's rows sequentially, pausing between requests.
 * @param {string} host
 * @param {Array<object>} jobs
 * @returns {Promise<void>}
 */
async function runHost(host, jobs) {
  for (const job of jobs) {
    let part;
    try {
      if (host === 'workingnomads.com') part = await resolveWorkingNomads(job);
      else if (host === 'weworkremotely.com') part = await resolveWeWorkRemotely(job);
      else if (host === 'himalayas.app') part = await resolveHimalayas(ctx, job);
      else if (host === 'monster.com') part = await resolveMonster(job);
      else if (host === 'dice.com') part = await resolveDice(job);
      else part = { outbound_url: null, method: 'none', http_status: null, error: `no resolver for ${host}` };
    } catch (err) {
      part = { outbound_url: null, method: 'none', http_status: null, error: String(err && err.message || err).split('\n')[0] };
    }
    const row = {
      dedupe_key: job.dedupe_key,
      company: job.company,
      title: job.title,
      aggregator_host: host,
      aggregator_url: job.url,
      outbound_url: part.outbound_url,
      ats: classifyAts(part.outbound_url),
      method: part.method,
      http_status: part.http_status,
      error: part.error,
    };
    rows.push(row);
    const mark = row.outbound_url ? `OK   ${row.ats.padEnd(15)} ${row.outbound_url}` : `MISS ${row.error}`;
    console.log(`  [${host}] ${String(job.company).slice(0, 24).padEnd(24)} ${mark}`);
    await sleep(HOST_DELAY_MS);
  }
}

/* Hosts run in parallel with each other, rows within a host run one at a time.
   That keeps the load on any single aggregator to about one request a second
   while the whole job still finishes in minutes. */
await Promise.all(Object.entries(byHost).map(([h, jobs]) => runHost(h, jobs)));

if (browser) await browser.close().catch(() => {});

const counts = {};
for (const r of rows) {
  const c = counts[r.aggregator_host] = counts[r.aggregator_host]
    || { total: 0, resolved: 0, unresolved: 0, ats: {} };
  c.total += 1;
  if (r.outbound_url) {
    c.resolved += 1;
    c.ats[r.ats] = (c.ats[r.ats] || 0) + 1;
  } else {
    c.unresolved += 1;
  }
}

const out = {
  generated_at: new Date().toISOString(),
  counts: {
    total: rows.length,
    resolved: rows.filter((r) => r.outbound_url).length,
    unresolved: rows.filter((r) => !r.outbound_url).length,
    by_host: counts,
  },
  rows,
};

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 1));

console.log(`\nresolved ${out.counts.resolved}/${out.counts.total}`);
for (const [h, c] of Object.entries(counts)) {
  const ats = Object.entries(c.ats).map(([k, v]) => `${k}:${v}`).join(' ') || '-';
  console.log(`  ${h.padEnd(20)} ${String(c.resolved).padStart(2)}/${String(c.total).padStart(2)}   ${ats}`);
}
console.log(`\n-> ${path.relative(ROOT, OUT_PATH).replace(/\\/g, '/')}`);
