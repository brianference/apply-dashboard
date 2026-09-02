/**
 * Stale lens: hide by default, Over 30 days chip reveals what was hidden.
 *
 * A 31-day-old posting refreshed 2 days ago must stay on the default list
 * (Pinterest). A 31-day-old posting refreshed 40 days ago must hide, and the
 * chip count must equal the rows the chip draws -- a tile that read 510 over
 * a list of 237 shipped because those two numbers came from different
 * predicates.
 *
 * The live API has no refreshed_at yet, so this intercepts /api/jobs with
 * fixtures. Driving production would keep every old row (unknown refresh)
 * and the chip would show 0, which cannot fail.
 *
 * Run: node tests/stale-filter.mjs [url]
 *      node tests/stale-filter.mjs   (stages a temp site and serve-local)
 */

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('C:/Users/brian/RedAnvil/node_modules/playwright')); }
catch { ({ chromium } = await import('playwright')); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let bad = 0;
const check = (name, ok, detail) => {
  if (!ok) bad += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(name).padEnd(56)} ${detail || ''}`);
};

/**
 * Date-only string n whole days before local today, matching daysSince.
 * @param {number} n
 * @returns {string}
 */
function daysAgo(n) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - n);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * A queued full-time row that clears the pay floor, so only the stale lens
 * decides visibility.
 * @param {Record<string, unknown>} extra
 * @returns {Record<string, unknown>}
 */
function job(extra) {
  return {
    status: 'queued',
    lane: 'ft',
    source: 'greenhouse',
    match_pct: 80,
    rank_pct: 80,
    salary_min: 200000,
    salary_max: 240000,
    work_type: 'Remote US',
    submitted_at: null,
    blocked_reason: null,
    ...extra
  };
}

const FIXTURES = [
  job({
    dedupe_key: 'pinterest|keep-refreshed',
    company: 'Pinterest',
    title: 'KEEP-PINTEREST Product Manager II, Content Compliance',
    url: 'https://job-boards.greenhouse.io/pinterest/jobs/101',
    posted: daysAgo(31),
    refreshed_at: daysAgo(2)
  }),
  job({
    dedupe_key: 'acme|hide-stale',
    company: 'Acme',
    title: 'HIDE-STALE Principal Product Manager',
    url: 'https://job-boards.greenhouse.io/acme/jobs/102',
    posted: daysAgo(31),
    refreshed_at: daysAgo(40)
  }),
  job({
    dedupe_key: 'beta|keep-unknown',
    company: 'Beta',
    title: 'KEEP-UNKNOWN Product Manager, Platform',
    url: 'https://job-boards.greenhouse.io/beta/jobs/103',
    posted: daysAgo(31),
    refreshed_at: null
  }),
  job({
    dedupe_key: 'gamma|keep-fresh',
    company: 'Gamma',
    title: 'KEEP-FRESH Senior Product Manager',
    url: 'https://job-boards.greenhouse.io/gamma/jobs/104',
    posted: daysAgo(10),
    refreshed_at: null
  }),
  job({
    dedupe_key: 'delta|keep-nodate',
    company: 'Delta',
    title: 'KEEP-NODATE Product Manager',
    url: 'https://www.linkedin.com/jobs/view/105',
    source: 'linkedin',
    posted: null,
    refreshed_at: null
  }),
  job({
    dedupe_key: 'eps|keep-boundary',
    company: 'Eps',
    title: 'KEEP-BOUNDARY Product Manager',
    url: 'https://job-boards.greenhouse.io/eps/jobs/106',
    posted: daysAgo(30),
    refreshed_at: daysAgo(40)
  }),
  job({
    dedupe_key: 'binance|hide-evergreen',
    company: 'Binance',
    title: 'HIDE-EVERGREEN Product Manager',
    url: 'https://jobs.lever.co/binance/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    source: 'lever',
    posted: daysAgo(1972),
    refreshed_at: daysAgo(500)
  })
];

const HIDDEN_TITLES = [
  'HIDE-STALE Principal Product Manager',
  'HIDE-EVERGREEN Product Manager'
];
const KEPT_TITLES = [
  'KEEP-PINTEREST Product Manager II, Content Compliance',
  'KEEP-UNKNOWN Product Manager, Platform',
  'KEEP-FRESH Senior Product Manager',
  'KEEP-NODATE Product Manager',
  'KEEP-BOUNDARY Product Manager'
];

/**
 * Flatten web/ into a temp dir the way build-deploy.sh does, without
 * writing .deploy/.
 * @returns {string}
 */
function stageSite() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-site-'));
  fs.copyFileSync(path.join(ROOT, 'index.html'), path.join(dir, 'index.html'));
  const web = path.join(ROOT, 'web');
  for (const name of fs.readdirSync(web)) {
    const src = path.join(web, name);
    if (fs.statSync(src).isDirectory()) {
      fs.cpSync(src, path.join(dir, name), { recursive: true });
    }
  }
  for (const name of fs.readdirSync(ROOT)) {
    if (name.endsWith('.png')) fs.copyFileSync(path.join(ROOT, name), path.join(dir, name));
  }
  return dir;
}

/**
 * @param {string} dir
 * @returns {Promise<{ url: string, stop: () => Promise<void> }>}
 */
function startServer(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tests', 'serve-local.mjs'), '--dir', dir], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let buf = '';
    const onData = (chunk) => {
      buf += String(chunk);
      const m = buf.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (m) {
        child.stdout.off('data', onData);
        resolve({
          url: m[0],
          stop: () => new Promise((done) => {
            child.once('exit', () => done());
            child.kill();
          })
        });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (c) => { buf += String(c); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code) reject(new Error('serve-local exited ' + code + ': ' + buf));
    });
  });
}

const givenUrl = process.argv[2];
let staged = null;
let server = null;
let SITE = givenUrl;
if (!SITE) {
  staged = stageSite();
  server = await startServer(staged);
  SITE = server.url;
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.route('**/api/jobs**', async (route) => {
  if (route.request().method() === 'GET') {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobs: FIXTURES })
    });
    return;
  }
  await route.continue();
});

await page.goto(SITE, { waitUntil: 'domcontentloaded' });
await page.locator('.rows:not([hidden]) .row').first().waitFor({ state: 'visible', timeout: 25000 });
await page.waitForTimeout(400);

const visibleTitles = async () => {
  return page.locator('.rows:not([hidden]) .row .ttl').evaluateAll((els) =>
    els.map((el) => (el.textContent || '').trim())
  );
};

const shown = await visibleTitles();
for (const t of KEPT_TITLES) {
  check('default list keeps ' + t.slice(0, 28),
    shown.some((s) => s.includes(t.slice(0, 18))),
    shown.filter((s) => s.includes('KEEP-') || s.includes('HIDE-')).join(' | '));
}
for (const t of HIDDEN_TITLES) {
  check('default list hides ' + t.slice(0, 28),
    !shown.some((s) => s.includes(t.slice(0, 18))),
    shown.filter((s) => s.includes('KEEP-') || s.includes('HIDE-')).join(' | '));
}

const nDefault = await page.locator('.rows:not([hidden]) .row').count();
check('default list row count is the kept fixtures',
  nDefault === KEPT_TITLES.length,
  `rows ${nDefault} kept ${KEPT_TITLES.length}`);

const chip = page.locator('.chip[data-kind="stale"]');
check('Over 30 days chip is on the page', await chip.count() === 1);
const chipCountText = ((await page.locator('#nstale').textContent()) || '').trim();
const chipCount = Number(chipCountText);
check('chip count equals the hidden fixtures, from the same array the rows use',
  chipCount === HIDDEN_TITLES.length,
  `chip ${chipCountText} hidden ${HIDDEN_TITLES.length}`);

await chip.click();
await page.locator('.rows:not([hidden]) .row').first().waitFor({ state: 'visible', timeout: 5000 });
const revealed = await visibleTitles();
const revealedHide = revealed.filter((s) => s.includes('HIDE-'));
const revealedKeep = revealed.filter((s) => s.includes('KEEP-'));
check('chip reveals the hidden rows',
  HIDDEN_TITLES.every((t) => revealed.some((s) => s.includes(t.slice(0, 18)))),
  revealedHide.join(' | '));
check('chip does not show the kept rows',
  revealedKeep.length === 0,
  revealedKeep.join(' | '));
const nRevealed = await page.locator('.rows:not([hidden]) .row').count();
check('chip count equals the rows it reveals',
  nRevealed === chipCount && nRevealed === HIDDEN_TITLES.length,
  `rows ${nRevealed} chip ${chipCount}`);

await page.locator('.chip[data-kind="all"]').click();
await page.locator('.rows:not([hidden]) .row').first().waitFor({ state: 'visible', timeout: 5000 });

const pinterestRow = page.locator('.row').filter({ hasText: 'KEEP-PINTEREST' }).first();
const pinterestTitle = await pinterestRow.locator('.posted').getAttribute('title');
check('Pinterest posted title includes the refresh date',
  !!pinterestTitle && pinterestTitle.includes(daysAgo(2)),
  pinterestTitle || '');
check('Pinterest posted title says it is kept because the employer refreshed it',
  !!pinterestTitle && /kept because the employer refreshed it/.test(pinterestTitle),
  pinterestTitle || '');

const deadTitle = await page.locator('.row').filter({ hasText: 'KEEP-UNKNOWN' }).locator('.posted').getAttribute('title');
check('unknown-refresh title does not claim a refresh',
  !!deadTitle && !/refreshed/.test(deadTitle),
  deadTitle || '');

check('no page errors', errors.length === 0, errors.join('; '));

await browser.close();
if (server) await server.stop();
if (staged) fs.rmSync(staged, { recursive: true, force: true });

console.log(bad
  ? `\n${bad} FAILED - stale lens or Over 30 days chip is wrong`
  : '\nstale lens hides un-refreshed old rows, keeps refreshed and unknown, and the chip count matches the rows');
process.exitCode = bad ? 1 : 0;
