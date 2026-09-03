/**
 * The tiered job-description reader has to fail on the shapes that hid
 * 145 unread rows, not on a happy-path HTML snippet.
 *
 * A reader that only handled a single ld+json object would still pass a
 * test written from memory, and would still miss WeWorkRemotely (array),
 * Working Nomads (@graph), and a page that puts a broken block in front
 * of a good one. Each case below is a real captured payload or a real
 * URL from the unread queue.
 *
 *   node ingest/test-jd-read.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  workdayCxsUrl,
  extractJsonLdJobPosting,
  salaryFromJsonLd,
  clampPostedIso,
  matchHimalayasJob,
  hostPolicy,
  readJd,
  PAGE_TEXT_MIN
} from './jd-read.mjs';
import { fetchJd, strip, boardRef, fetchBoardJd } from './fit-score.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname)
  .replace(/^\/([A-Za-z]:)/, '$1'), '..');

let bad = 0;
/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(name, ok, detail) {
  if (!ok) bad += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(name).padEnd(78)} ${detail || ''}`);
}

/* ------------------------------------------------------------------ */
/* Real captured JSON-LD: Jobspresso / Hopper, fetched 2026-09-03.     */
/* ------------------------------------------------------------------ */

const JOBSPRESSO = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'ingest', 'test-jd-read-jobspresso.json'),
  'utf8'
));

/**
 * Wrap a JSON-LD value in the script tag the boards actually emit.
 *
 * @param {unknown} payload
 * @returns {string}
 */
function ldScript(payload) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return `<script type="application/ld+json">${body}</script>`;
}

const extracted = extractJsonLdJobPosting(ldScript(JOBSPRESSO));
check('real Jobspresso JobPosting is found in a lone ld+json block',
  !!(extracted && extracted.title === 'Principal Product Manager, Conversational AI'),
  extracted ? extracted.title : 'null');
check('real Jobspresso description is longer than 400 chars after decode',
  !!(extracted && extracted.description && extracted.description.length > 400),
  extracted ? String(extracted.description.length) : 'null');
check('real Jobspresso description is readable text, not raw &lt;p&gt;',
  !!(extracted && extracted.description && /HTS Assist/.test(extracted.description)
    && !/&lt;p&gt;/.test(extracted.description)),
  extracted ? extracted.description.slice(0, 80) : 'null');
check('real Jobspresso datePosted is kept (offset converted to UTC, not dropped)',
  extracted && extracted.datePosted === new Date('2026-08-28T22:12:12-04:00').toISOString(),
  extracted && extracted.datePosted);

const asArray = extractJsonLdJobPosting(ldScript([
  { '@type': 'Organization', name: 'Hopper' },
  JOBSPRESSO
]));
check('ld+json array: the JobPosting is found among siblings',
  !!(asArray && asArray.title === JOBSPRESSO.title),
  asArray ? asArray.title : 'null');

const asGraph = extractJsonLdJobPosting(ldScript({
  '@context': 'http://schema.org/',
  '@graph': [
    { '@type': 'WebSite', name: 'Jobspresso' },
    JOBSPRESSO
  ]
}));
check('ld+json @graph: the JobPosting is found under @graph',
  !!(asGraph && asGraph.title === JOBSPRESSO.title),
  asGraph ? asGraph.title : 'null');

const malformedBeside = extractJsonLdJobPosting(
  ldScript('{ this is not json')
  + '\n'
  + ldScript(JOBSPRESSO)
);
check('a malformed ld+json block does not stop the good JobPosting beside it',
  !!(malformedBeside && malformedBeside.title === JOBSPRESSO.title),
  malformedBeside ? malformedBeside.title : 'null');

check('a page with no JobPosting returns null, not a guess',
  extractJsonLdJobPosting(ldScript({ '@type': 'Organization', name: 'Nope' })) === null);

check('empty HTML returns null', extractJsonLdJobPosting('') === null);

/* ------------------------------------------------------------------ */
/* Workday matcher: 11 real unread URLs, with and without locale.      */
/* ------------------------------------------------------------------ */

const WORKDAY_URLS = [
  'https://empower.wd12.myworkdayjobs.com/empower/job/Nationwide-Remote/Senior-Technical-Product-Manager_R0061402',
  'https://adobe.wd5.myworkdayjobs.com/en-US/external_experienced/job/Remote-New-York/Principal-Product-Manager_R171078',
  'https://adobe.wd5.myworkdayjobs.com/en-US/external_experienced/job/Remote-California/Principal-Product-Manager--Graph_R169244',
  'https://capitalone.wd12.myworkdayjobs.com/en-US/Capital_One/job/New-York-NY/Director-of-Product--Capital-One-Shopping--Remote---Eligible-_R246543-1',
  'https://vanguard.wd5.myworkdayjobs.com/vanguard_external/job/Malvern-PA/AI-ML-Product-Manager_177614-1',
  'https://capitalone.wd12.myworkdayjobs.com/en-US/Capital_One/job/McLean-VA/Senior-Manager--Product-Management--Capital-One-Shopping--Remote-Eligible-_R246580-1',
  'https://capitalone.wd12.myworkdayjobs.com/en-US/Capital_One/job/McLean-VA/Senior-Product-Manager--Growth---Capital-One-Shopping--Remote-Eligible-_R246326-1',
  'https://vantagedc.wd1.myworkdayjobs.com/Vantage/job/Remote---US/AI-Product-Manager--Global_R21833',
  'https://capitalone.wd12.myworkdayjobs.com/en-US/Capital_One/job/McLean-VA/Product-Manager--Capital-One-Shopping--Remote-Eligible-_R246330-1',
  'https://cisco.wd5.myworkdayjobs.com/en-US/Cisco_Careers/job/San-Diego-California-US/Product-Manager---Partner-Experience_2023104',
  'https://zillow.wd5.myworkdayjobs.com/Zillow_Group_External/job/Remote-USA/Principal-Product-Manager--Listing-Product_P751217-2'
];

check('eleven real Workday URLs are on the list -- the unread queue when this was written',
  WORKDAY_URLS.length === 11, String(WORKDAY_URLS.length));

/**
 * Insert or strip a locale segment so the same posting is tested both ways.
 *
 * @param {string} url
 * @param {boolean} wantLocale
 * @returns {string}
 */
function withLocale(url, wantLocale) {
  const u = new URL(url);
  const parts = u.pathname.split('/').filter(Boolean);
  const has = /^[a-z]{2}-[A-Z]{2}$/.test(parts[0] || '');
  if (wantLocale && !has) parts.unshift('en-US');
  if (!wantLocale && has) parts.shift();
  u.pathname = '/' + parts.join('/');
  return u.toString();
}

for (const url of WORKDAY_URLS) {
  const host = new URL(url).hostname;
  const asIs = workdayCxsUrl(url);
  const yes = workdayCxsUrl(withLocale(url, true));
  const no = workdayCxsUrl(withLocale(url, false));
  check(`Workday matcher hits ${host} as-is`,
    !!(asIs && /\/wday\/cxs\//.test(asIs) && /\/job\//.test(asIs)),
    asIs || 'null');
  check(`Workday matcher hits ${host} WITH locale`,
    !!(yes && /\/wday\/cxs\//.test(yes)),
    yes || 'null');
  check(`Workday matcher hits ${host} WITHOUT locale`,
    !!(no && /\/wday\/cxs\//.test(no)),
    no || 'null');
  check(`Workday locale variants for ${host} resolve to the same CXS path`,
    !!(yes && no && yes === no),
    `with=${yes} without=${no}`);
}

const adobe = workdayCxsUrl(WORKDAY_URLS[1]);
check('Adobe locale URL does not treat en-US as the site',
  !!(adobe && adobe.indexOf('/wday/cxs/adobe/external_experienced/job/') !== -1
    && adobe.indexOf('/wday/cxs/adobe/en-US/') === -1),
  adobe || 'null');

check('a non-Workday URL is not a CXS target',
  workdayCxsUrl('https://jobs.ashbyhq.com/openai/05a8cae8-81bd-4f7b-bc48-41ef1bd67e5d') === null);

/* ------------------------------------------------------------------ */
/* Blocked hosts: the fetch must not run. "Returned null" is not the   */
/* distinction this change exists to make.                             */
/* ------------------------------------------------------------------ */

const BLOCKED = [
  'https://www.linkedin.com/jobs/view/123',
  'https://www.indeed.com/viewjob?jk=abc',
  'https://www.dice.com/job-detail/x',
  'https://www.monster.com/job/x',
  'https://wellfound.com/jobs/x',
  'https://startup.jobs/x'
];

for (const url of BLOCKED) {
  check(`hostPolicy(${new URL(url).hostname}) is blocked-by-policy`,
    hostPolicy(url) === 'blocked-by-policy');
}

const DEAD = [
  'https://careers.airbnb.com/positions/8082161?gh_jid=8082161',
  'https://www.cribl.io/careers/x',
  'https://jobs.gusto.com/postings/x',
  'https://flexgen.zya.me/job/x',
  'https://homebased.totalh.net/job/x',
  'https://lynqo.liveblog365.com/remote-jobs/x',
  'https://talentpulse.66ghz.com/remote-jobs/x'
];
for (const url of DEAD) {
  check(`hostPolicy(${new URL(url).hostname}) is board-404`,
    hostPolicy(url) === 'board-404', hostPolicy(url));
}

/**
 * @param {Array<{ match: (href: string) => boolean, status: number, body: string, contentType?: string }>} routes
 * @returns {{ fetch: typeof fetch, calls: string[] }}
 */
function fakeFetch(routes) {
  const calls = [];
  const fetchFn = async (url) => {
    const href = String(url);
    calls.push(href);
    const hit = routes.find((r) => r.match(href));
    const status = hit ? hit.status : 599;
    const body = hit ? hit.body : '';
    const contentType = hit && hit.contentType ? hit.contentType : 'text/html';
    return {
      ok: status >= 200 && status < 300,
      status,
      url: href,
      headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? contentType : null) },
      text: async () => body,
      json: async () => JSON.parse(body)
    };
  };
  return { fetch: fetchFn, calls };
}

for (const url of BLOCKED) {
  const { fetch: fetchFn, calls } = fakeFetch([{ match: () => true, status: 200, body: 'SHOULD NOT RUN' }]);
  const result = await readJd(url, { fetch: fetchFn, cacheDir: os.tmpdir() });
  check(`blocked ${new URL(url).hostname}: fetch is not attempted`,
    calls.length === 0, `calls=${calls.length} ${calls[0] || ''}`);
  check(`blocked ${new URL(url).hostname}: outcome is blocked-by-policy`,
    result.outcome === 'blocked-by-policy', result.outcome);
  check(`blocked ${new URL(url).hostname}: text is null`,
    result.text === null);
}

{
  const { fetch: fetchFn, calls } = fakeFetch([{ match: () => true, status: 200, body: 'SHOULD NOT RUN' }]);
  const result = await readJd(DEAD[3], { fetch: fetchFn, cacheDir: os.tmpdir() });
  check('scraped dead host: fetch is not attempted',
    calls.length === 0, `calls=${calls.length}`);
  check('scraped dead host: outcome is board-404',
    result.outcome === 'board-404', result.outcome);
}

/* ------------------------------------------------------------------ */
/* JSON-LD salary: USD YEAR only. EUR and HOUR would rule a job on a   */
/* number the employer did not publish as an annual USD salary.        */
/* ------------------------------------------------------------------ */

const usdYear = salaryFromJsonLd({
  baseSalary: {
    '@type': 'MonetaryAmount',
    currency: 'USD',
    value: { '@type': 'QuantitativeValue', minValue: 180000, maxValue: 240000, unitText: 'YEAR' }
  }
});
check('USD YEAR baseSalary is taken',
  !!(usdYear && usdYear.min === 180000 && usdYear.max === 240000),
  usdYear ? `${usdYear.min}-${usdYear.max}` : 'null');

const eur = salaryFromJsonLd({
  baseSalary: {
    currency: 'EUR',
    value: { minValue: 180000, maxValue: 240000, unitText: 'YEAR' }
  }
});
check('EUR YEAR baseSalary is refused',
  eur === null || (eur.min == null && eur.max == null),
  eur ? `${eur.min}-${eur.max}` : 'null');

const hourly = salaryFromJsonLd({
  baseSalary: {
    currency: 'USD',
    value: { minValue: 85, maxValue: 120, unitText: 'HOUR' }
  }
});
check('USD HOUR baseSalary is refused -- an hourly figure read as annual would rule the job on a wrong number',
  hourly === null || (hourly.min == null && hourly.max == null),
  hourly ? `${hourly.min}-${hourly.max}` : 'null');

const monthly = salaryFromJsonLd({
  baseSalary: {
    currency: 'USD',
    value: { minValue: 15000, maxValue: 20000, unitText: 'MONTH' }
  }
});
check('USD MONTH baseSalary is refused',
  monthly === null || (monthly.min == null && monthly.max == null));

/* ------------------------------------------------------------------ */
/* Future datePosted clamps, the same way ageDays already does.        */
/* ------------------------------------------------------------------ */

const NOW = new Date('2026-09-03T12:00:00.000Z');
const future = clampPostedIso('2026-12-01T00:00:00.000Z', NOW);
check('a datePosted in the future clamps to now, not a negative age',
  future === NOW.toISOString(), future);
check('a past datePosted is kept',
  clampPostedIso('2026-08-28T22:12:12.000Z', NOW) === '2026-08-28T22:12:12.000Z');
check('an unreadable datePosted is null, not invented',
  clampPostedIso('not-a-date', NOW) === null);

const futureLd = extractJsonLdJobPosting(ldScript({
  ...JOBSPRESSO,
  datePosted: '2026-12-01T00:00:00.000Z'
}), NOW);
check('extractJsonLdJobPosting clamps a future datePosted',
  !!(futureLd && futureLd.datePosted === NOW.toISOString()),
  futureLd && futureLd.datePosted);

/* ------------------------------------------------------------------ */
/* Himalayas: match by URL or slug. The page is 403; the feed is not.  */
/* ------------------------------------------------------------------ */

const HIMALAYA_URL = 'https://himalayas.app/companies/lifelancer/jobs/sr-manager-ai-technical-product-manager-6723261753';
const HIMALAYA_JOB = {
  title: 'Sr. Manager, AI Technical Product Manager',
  companyName: 'Lifelancer',
  applicationLink: HIMALAYA_URL,
  guid: HIMALAYA_URL,
  description: '<p>' + 'Himalayas listing body. '.repeat(40) + '</p>',
  pubDate: 1788451574,
  minSalary: 180000,
  maxSalary: 220000,
  currency: 'USD',
  salaryPeriod: 'annual'
};
const byUrl = matchHimalayasJob([HIMALAYA_JOB], HIMALAYA_URL);
check('Himalayas match by full URL',
  !!(byUrl && byUrl.title === HIMALAYA_JOB.title));
const bySlug = matchHimalayasJob(
  [{
    ...HIMALAYA_JOB,
    applicationLink: 'https://boards.greenhouse.io/x/jobs/sr-manager-ai-technical-product-manager-6723261753',
    guid: 'other'
  }],
  HIMALAYA_URL
);
check('Himalayas match by last-path slug when applicationLink is an external ATS',
  !!(bySlug && bySlug.title === HIMALAYA_JOB.title));
const slugOnly = matchHimalayasJob(
  [{
    ...HIMALAYA_JOB,
    applicationLink: 'https://boards.greenhouse.io/x/jobs/1',
    guid: 'sr-manager-ai-technical-product-manager-6723261753'
  }],
  HIMALAYA_URL
);
check('Himalayas match by guid slug',
  !!(slugOnly && slugOnly.title === HIMALAYA_JOB.title));
check('Himalayas does not match a different slug',
  matchHimalayasJob([HIMALAYA_JOB], 'https://himalayas.app/companies/lifelancer/jobs/some-other-role') === null);

/* ------------------------------------------------------------------ */
/* Tier order: board API wins over JSON-LD on the same URL.            */
/* ------------------------------------------------------------------ */

const GH_URL = 'https://job-boards.greenhouse.io/mercury/jobs/6126980004';
const BOARD_TEXT = ('Board API description with requirements and qualifications. '
  + 'AI, enterprise SaaS, analytics, dashboards, B2B. 5+ years. ').repeat(8);
const PAGE_JSONLD = `<html><body>${ldScript({
  '@type': 'JobPosting',
  title: 'From JSON-LD',
  description: ('JSON-LD description that must lose to the board API. '
    + 'This text is long enough to look like a real posting. ').repeat(20)
})}<p>${'Page body text that is also long enough. '.repeat(80)}</p></body></html>`;

{
  const { fetch: fetchFn, calls } = fakeFetch([
    {
      match: (href) => /boards-api\.greenhouse\.io/.test(href),
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ content: `<p>${BOARD_TEXT}</p>` })
    },
    {
      match: (href) => /job-boards\.greenhouse\.io/.test(href),
      status: 200,
      contentType: 'text/html',
      body: PAGE_JSONLD
    }
  ]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jd-read-'));
  const result = await readJd(GH_URL, { fetch: fetchFn, cacheDir: tmp, refetch: true });
  check('tier order: a greenhouse URL is read from the board API, not JSON-LD',
    !!(result.text && result.text.indexOf('Board API description') !== -1
      && result.text.indexOf('JSON-LD description that must lose') === -1),
    result.via + ' ' + (result.text ? result.text.slice(0, 60) : 'null'));
  check('tier order: via is board-api',
    result.via === 'board-api', result.via);
  check('tier order: the posting page is not fetched when the board API already answered',
    calls.every((c) => !/job-boards\.greenhouse\.io/.test(c)),
    calls.join(' | '));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir is a proof */ }
}

/* JSON-LD via the page, when no board API applies. */
{
  const { fetch: fetchFn } = fakeFetch([
    { match: () => true, status: 200, contentType: 'text/html', body: PAGE_JSONLD }
  ]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jd-read-'));
  const result = await readJd('https://jobspresso.co/job/principal-product-manager-conversational-ai/', {
    fetch: fetchFn, cacheDir: tmp, refetch: true
  });
  check('JSON-LD tier reads a JobPosting off a non-board URL',
    !!(result.text && result.text.length > 400 && result.via === 'json-ld'),
    `${result.via} len=${result.text && result.text.length}`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir is a proof */ }
}

/* Page text when there is no JSON-LD but plenty of HTML. */
{
  const long = '<html><body><article>' + ('About the role. Product manager for a B2B platform. '.repeat(40)) + '</article></body></html>';
  check('the page-text fixture is above the survey threshold',
    long.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length > PAGE_TEXT_MIN);
  const { fetch: fetchFn } = fakeFetch([
    { match: () => true, status: 200, contentType: 'text/html', body: long }
  ]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jd-read-'));
  const result = await readJd('https://www.samsara.com/careers/x', {
    fetch: fetchFn, cacheDir: tmp, refetch: true
  });
  check('page-text tier reads HTML with no JSON-LD when there is enough of it',
    !!(result.text && result.via === 'page-text' && result.text.length > PAGE_TEXT_MIN),
    `${result.via} len=${result.text && result.text.length}`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir is a proof */ }
}

/* Himalayas: page must not be fetched; the feed is. */
{
  const { fetch: fetchFn, calls } = fakeFetch([
    {
      match: (href) => /himalayas\.app\/jobs\/api/.test(href),
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobs: [HIMALAYA_JOB], totalCount: 1, limit: 20 })
    },
    {
      match: (href) => /himalayas\.app\/companies/.test(href),
      status: 403,
      body: 'forbidden'
    }
  ]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jd-read-'));
  const result = await readJd(HIMALAYA_URL, { fetch: fetchFn, cacheDir: tmp, refetch: true });
  check('Himalayas is read from the feed, not the 403 page',
    !!(result.text && result.via === 'himalayas' && /Himalayas listing body/.test(result.text)),
    `${result.via} ${result.outcome}`);
  check('Himalayas page URL is never fetched',
    calls.every((c) => !/himalayas\.app\/companies/.test(c)),
    calls.join(' | '));
  check('Himalayas USD annual salary is taken from the same fetch',
    !!(result.salary && result.salary.min === 180000 && result.salary.max === 220000
      && result.salarySource === 'himalayas:api'),
    result.salarySource + ' ' + (result.salary && result.salary.min));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir is a proof */ }
}

/* Workday CXS via injected fetch. */
{
  const cxs = workdayCxsUrl(WORKDAY_URLS[0]);
  const desc = '<p>' + ('Empower role description with product requirements. '.repeat(30)) + '</p>';
  const { fetch: fetchFn, calls } = fakeFetch([
    {
      match: (href) => /\/wday\/cxs\//.test(href),
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        jobPostingInfo: { jobDescription: desc, startDate: '2026-08-27', title: 'Senior Technical Product Manager' }
      })
    }
  ]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jd-read-'));
  const result = await readJd(WORKDAY_URLS[0], { fetch: fetchFn, cacheDir: tmp, refetch: true });
  check('Workday CXS tier reads jobPostingInfo.jobDescription',
    !!(result.text && result.via === 'workday-cxs' && /Empower role description/.test(result.text)),
    `${result.via} ${result.outcome}`);
  check('Workday CXS startDate becomes posted',
    !!(result.posted && String(result.posted).indexOf('2026-08-27') === 0),
    result.posted);
  check('Workday page is not fetched when CXS answered',
    calls.every((c) => /\/wday\/cxs\//.test(c)),
    calls.join(' | '));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir is a proof */ }
}

/* fetchJd still returns the description string, so existing callers do not drift. */
{
  const { fetch: fetchFn } = fakeFetch([
    { match: () => true, status: 200, contentType: 'text/html', body: PAGE_JSONLD }
  ]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jd-read-'));
  const text = await fetchJd('https://www.aha.io/company/careers/x', {
    fetch: fetchFn, cacheDir: tmp, refetch: true
  });
  check('fetchJd returns the description string for existing callers',
    typeof text === 'string' && text.length > 400,
    typeof text);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir is a proof */ }
}

/* JSON-LD salary source wins over prose, loses to Ashby -- pickSalary. */
{
  const { pickSalary } = await import('./jd-read.mjs');
  const ashby = { min: 90000, max: 120500 };
  const jsonld = { min: 180000, max: 240000 };
  const prose = { min: 75000, max: 99999 };
  const a = pickSalary({ ashby, jsonld, prose });
  check('pickSalary: Ashby structured compensation wins over JSON-LD',
    a.min === 90000 && a.source === 'ashby:compensation',
    a.source + ' ' + a.min);
  const b = pickSalary({ ashby: { min: null, max: null }, jsonld, prose });
  check('pickSalary: JSON-LD wins over prose',
    b.min === 180000 && b.source === 'jsonld:baseSalary',
    b.source + ' ' + b.min);
  const c = pickSalary({ jsonld: null, prose });
  check('pickSalary: prose is used when nothing structured exists',
    c.min === 75000 && c.source === 'posting:page',
    c.source + ' ' + c.min);
}

/* Lever 404 from the board API is posting-closed, not a retry loop. */
{
  const lever = 'https://jobs.lever.co/workwave/1eb3501d-0d30-4f46-8904-069849fc0396';
  const { fetch: fetchFn } = fakeFetch([
    { match: () => true, status: 404, body: 'not found' }
  ]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jd-read-'));
  const result = await readJd(lever, { fetch: fetchFn, cacheDir: tmp, refetch: true });
  check('a Lever 404 is board-404 / posting-closed, not an unread blank',
    result.outcome === 'board-404' && result.closed === true,
    `${result.outcome} closed=${result.closed}`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir is a proof */ }
}

/* ---- known-bad: break each tier in a TEMP COPY, never in this tree.
   If this block starts passing because the copy still behaves, the suite
   is decorative. */

const src = fs.readFileSync(path.join(ROOT, 'ingest', 'jd-read.mjs'), 'utf8');
const ingestUrl = pathToFileURL(path.join(ROOT, 'ingest')).href.replace(/\/$/, '');
const tmpBreak = fs.mkdtempSync(path.join(os.tmpdir(), 'jd-read-break-'));

/**
 * Load a mutated copy of jd-read.mjs from a temp dir.
 *
 * @param {string} mutated
 * @param {string} name
 * @returns {Promise<object>}
 */
async function loadBroken(mutated, name) {
  const p = path.join(tmpBreak, name);
  fs.writeFileSync(p, mutated.replace(/from '\.\//g, `from '${ingestUrl}/`));
  const mod = await import(pathToFileURL(p).href + '?t=' + Date.now() + Math.random());
  /* Each copy has its own fitMod. Without this, readJd throws
     "helpers were not bound" and the blocked-host / tier-order
     breaks would fail for the wrong reason. */
  if (typeof mod.bindFit === 'function') {
    mod.bindFit({ strip, boardRef, fetchBoardJd });
  }
  return mod;
}

{
  const broken = await loadBroken(
    src.replace('if (Array.isArray(node)) {\n    for (const el of node) walkJobPosting(el, found);\n    return;\n  }',
      'if (Array.isArray(node)) {\n    return;\n  }'),
    'no-array.mjs'
  );
  const miss = broken.extractJsonLdJobPosting(ldScript([
    { '@type': 'Organization', name: 'Hopper' },
    JOBSPRESSO
  ]));
  check('TEMP COPY that skips ld+json arrays FAILS the array case',
    !(miss && miss.title === JOBSPRESSO.title),
    miss ? 'still found -- walker not actually broken' : 'null as required');
}

{
  const broken = await loadBroken(
    src.replace("if (rec['@graph']) walkJobPosting(rec['@graph'], found);", '/* no graph walk */'),
    'no-graph.mjs'
  );
  const miss = broken.extractJsonLdJobPosting(ldScript({
    '@context': 'http://schema.org/',
    '@graph': [{ '@type': 'WebSite', name: 'x' }, JOBSPRESSO]
  }));
  check('TEMP COPY that skips @graph FAILS the @graph case',
    !(miss && miss.title === JOBSPRESSO.title),
    miss ? 'still found -- @graph walk not actually broken' : 'null as required');
}

{
  const broken = await loadBroken(
    src.replace('} catch {\n      continue;\n    }', '} catch {\n      throw new Error(\'malformed ld+json\');\n    }'),
    'throw-malformed.mjs'
  );
  let threw = false;
  try {
    broken.extractJsonLdJobPosting(ldScript('{ this is not json') + '\n' + ldScript(JOBSPRESSO));
  } catch {
    threw = true;
  }
  check('TEMP COPY that throws on a malformed block FAILS the beside-a-good-one case',
    threw,
    threw ? 'threw as required' : 'still returned a JobPosting');
}

{
  const oldMatcher = src.replace(
    'if (parts[0] && /^[a-z]{2}-[A-Z]{2}$/.test(parts[0])) i = 1;',
    '/* locale not optional -- the bug that dropped Adobe */'
  );
  const broken = await loadBroken(oldMatcher, 'no-locale.mjs');
  const adobeLocale = WORKDAY_URLS[1];
  const adobeBare = withLocale(adobeLocale, false);
  check('TEMP COPY without optional locale FAILS the Adobe en-US URL',
    broken.workdayCxsUrl(adobeLocale) === null,
    broken.workdayCxsUrl(adobeLocale) || 'null');
  check('TEMP COPY without optional locale still matches a URL that has no locale',
    !!broken.workdayCxsUrl(adobeBare),
    broken.workdayCxsUrl(adobeBare) || 'null');
}

{
  const brokenSrc = src.replace(
    "if (policy === 'blocked-by-policy') return emptyResult('blocked-by-policy');",
    "if (policy === 'blocked-by-policy') { /* fall through and fetch -- the bug */ }"
  );
  const broken = await loadBroken(brokenSrc, 'fetch-blocked.mjs');
  const { fetch: fetchFn, calls } = fakeFetch([{ match: () => true, status: 200, body: 'SHOULD NOT RUN' }]);
  await broken.readJd('https://www.linkedin.com/jobs/view/123', { fetch: fetchFn, cacheDir: os.tmpdir() });
  check('TEMP COPY that fetches a blocked host FAILS the never-attempted assertion',
    calls.length > 0,
    `calls=${calls.length}`);
}

{
  const broken = await loadBroken(
    src.replace("if (currency !== 'USD') return null;", '/* EUR accepted -- the bug */'),
    'eur-ok.mjs'
  );
  const got = broken.salaryFromJsonLd({
    baseSalary: { currency: 'EUR', value: { minValue: 180000, maxValue: 240000, unitText: 'YEAR' } }
  });
  check('TEMP COPY that accepts EUR FAILS the EUR-refused assertion',
    !!(got && got.min === 180000),
    got ? `${got.min}` : 'null');
}

{
  const broken = await loadBroken(
    src.replace("if (date.getTime() > now.getTime()) return now.toISOString();", '/* no clamp */'),
    'no-clamp.mjs'
  );
  const got = broken.clampPostedIso('2026-12-01T00:00:00.000Z', NOW);
  check('TEMP COPY that does not clamp FAILS the future-date assertion',
    got === '2026-12-01T00:00:00.000Z',
    got);
}

{
  /* Swap tier 1 and tier 4: JSON-LD on the page runs before the board API.
     The greenhouse URL then returns the JSON-LD description. */
  const swapped = src.replace(
    '/* 1. greenhouse / ashby / lever, unchanged in what they request. */',
    `/* broken: JSON-LD first */
  try {
    const pageEarly = await getUrl(get, url);
    const fromLdEarly = pageEarly && pageEarly.text ? fromJsonLdHtml(pageEarly.text, now) : null;
    if (fromLdEarly) return fromLdEarly;
  } catch { /* ignore */ }
  /* 1. greenhouse / ashby / lever, unchanged in what they request. */`
  );
  const broken = await loadBroken(swapped, 'jsonld-first.mjs');
  const { fetch: fetchFn } = fakeFetch([
    {
      match: (href) => /boards-api\.greenhouse\.io/.test(href),
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ content: `<p>${BOARD_TEXT}</p>` })
    },
    {
      match: (href) => /job-boards\.greenhouse\.io/.test(href),
      status: 200,
      contentType: 'text/html',
      body: PAGE_JSONLD
    }
  ]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jd-read-'));
  const result = await broken.readJd(GH_URL, { fetch: fetchFn, cacheDir: tmp, refetch: true });
  check('TEMP COPY that runs JSON-LD before the board API FAILS the tier-order assertion',
    !!(result.text && result.text.indexOf('JSON-LD description that must lose') !== -1
      && result.via === 'json-ld'),
    `${result.via} ${(result.text || '').slice(0, 40)}`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir is a proof */ }
}

try { fs.rmSync(tmpBreak, { recursive: true, force: true }); } catch { /* temp dir is a proof */ }

console.log(bad
  ? `\n${bad} FAILED`
  : '\nthe tiered reader finds a JobPosting, skips blocked hosts, and the board API still wins');
process.exitCode = bad ? 1 : 0;
