/**
 * Posted column, posted-within filter, and the mobile mago span.
 *
 * Newest used to sort on updated_at, which is the last crawl and is rewritten
 * twice a day, so "Newest" never ordered by how new the job is. A freshness
 * window that is not wired still paints a select, and a count written next to
 * the rows from a second predicate is how a tile once read 510 over a list of
 * 237. This drives the real page.
 *
 * Run: node tests/posted-filter.mjs [url]
 */

import { createRequire } from 'node:module';
/* Brian's machine keeps Playwright in RedAnvil; a CI runner installs its own.
   Try the local copy, fall back to a normal resolution, so the same file runs
   in both places -- a test that only runs on one machine is not enforcement. */
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('C:/Users/brian/RedAnvil/node_modules/playwright')); }
catch { ({ chromium } = await import('playwright')); }

const SITE = process.argv[2] || 'https://apply-dashboard.pages.dev';
let bad = 0;
const check = (name, ok, detail) => {
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(name).padEnd(44)} ${detail || ''}`);
};

const POSTED_SHAPE = /^(today|\d+d ago|\u2014)$/;

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(SITE, { waitUntil: 'domcontentloaded' });
await page.locator('.row').first().waitFor({ state: 'visible', timeout: 25000 });
await page.waitForTimeout(800);

const rowCount = async () => page.locator('.row').count();
const postedTexts = async () => {
  const texts = await page.locator('.row .posted').allTextContents();
  return texts.map((t) => t.trim());
};

const nRows = await rowCount();
const nCells = await page.locator('.row .posted').count();
check('every visible row has a .posted cell', nRows === nCells && nRows > 0,
  `rows ${nRows} cells ${nCells}`);

const texts = await postedTexts();
const badShape = texts.filter((t) => !POSTED_SHAPE.test(t));
check('posted text is today, Nd ago, or em-dash', badShape.length === 0,
  badShape.slice(0, 5).join(' | ') || `${texts.length} cells`);

const nAny = nRows;
const windowCounts = {};

for (const w of [1, 3, 5, 7]) {
  await page.selectOption('#freshsel', String(w));
  await page.locator('#freshnote').waitFor({ state: 'visible', timeout: 5000 });
  const shown = await postedTexts();
  const dashes = shown.filter((t) => t === '\u2014');
  const over = shown.filter((t) => {
    const m = /^(\d+)d ago$/.exec(t);
    return m && Number(m[1]) > w;
  });
  check(`window ${w}: no no-date dash`, dashes.length === 0,
    `${dashes.length} dashes in ${shown.length}`);
  check(`window ${w}: no row older than ${w}d`, over.length === 0,
    over.slice(0, 3).join(',') || `${shown.length} rows`);
  windowCounts[w] = await rowCount();
}

check('rows(1) <= rows(3)', windowCounts[1] <= windowCounts[3],
  `${windowCounts[1]} <= ${windowCounts[3]}`);
check('rows(3) <= rows(5)', windowCounts[3] <= windowCounts[5],
  `${windowCounts[3]} <= ${windowCounts[5]}`);
check('rows(5) <= rows(7)', windowCounts[5] <= windowCounts[7],
  `${windowCounts[5]} <= ${windowCounts[7]}`);
check('rows(7) < rows(any)', windowCounts[7] < nAny,
  `${windowCounts[7]} < ${nAny}`);

await page.selectOption('#freshsel', '3');
await page.locator('#freshnote').waitFor({ state: 'visible', timeout: 5000 });
const note = ((await page.locator('#freshnote').textContent()) || '').trim();
const parsed = note.match(/^Past 3 days: (\d+) shown\. (\d+) hidden -- (\d+) posted longer ago, (\d+) from boards that publish no posting date\.$/);
check('3-day note matches the expected sentence', !!parsed, note);
if (parsed) {
  const shown = Number(parsed[1]);
  const hidden = Number(parsed[2]);
  const older = Number(parsed[3]);
  const noDate = Number(parsed[4]);
  const onScreen = await rowCount();
  check('note shown equals rows on screen', shown === onScreen,
    `note ${shown}, rows ${onScreen}`);
  check('shown + hidden == any-time count', shown + hidden === nAny,
    `${shown} + ${hidden} = ${shown + hidden}, any ${nAny}`);
  check('hidden == older + no-date', hidden === older + noDate,
    `${hidden} vs ${older} + ${noDate}`);
}

await page.selectOption('#freshsel', '');
await page.setViewportSize({ width: 375, height: 800 });
await page.waitForTimeout(300);
const posted375 = page.locator('.rows:not([hidden]) .row .posted').first();
const mago375 = page.locator('.rows:not([hidden]) .row .mago').first();
check('375px: .posted is hidden', (await posted375.count()) > 0 && !(await posted375.isVisible()), '');
check('375px: .mago is visible', (await mago375.count()) > 0 && (await mago375.isVisible()), '');

await page.setViewportSize({ width: 1280, height: 800 });
await page.waitForTimeout(300);
const posted1280 = page.locator('.rows:not([hidden]) .row .posted').first();
const mago1280 = page.locator('.rows:not([hidden]) .row .mago').first();
check('1280px: .posted is visible', (await posted1280.count()) > 0 && (await posted1280.isVisible()), '');
check('1280px: .mago is hidden', (await mago1280.count()) > 0 && !(await mago1280.isVisible()), '');

check('no page errors', errors.length === 0, errors.join('; '));

await browser.close();
console.log(bad ? `\n${bad} FAILED - posted column or freshness filter is wrong` : '\nposted column and freshness filter hold');
process.exitCode = bad ? 1 : 0;
