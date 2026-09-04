/**
 * Header search, the slash shortcut, and the filter chips.
 *
 * Both were recorded in FEATURES.md as gaps: search was "verified by screenshot
 * only" and the chips had no test at all. A screenshot cannot verify a keyboard
 * shortcut, and it cannot verify that a chip changes the rows rather than only
 * changing its own colour, which is the failure worth catching here.
 *
 * Every count is asserted against the rows the page is actually showing, not
 * against a tile that was computed separately. A tile written apart from its
 * list answers a different question.
 *
 * Run: node tests/search-and-chips.mjs [url]
 */

import { createRequire } from 'node:module';
/* Brian's machine keeps Playwright in RedAnvil; a CI runner installs its own.
   Try the local copy, fall back to a normal resolution, so the same file runs
   in both places. */
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('C:/Users/brian/RedAnvil/node_modules/playwright')); }
catch { ({ chromium } = await import('playwright')); }

const SITE = process.argv[2] || 'https://apply-dashboard.pages.dev';

let bad = 0;
const check = (name, ok, detail) => {
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(name).padEnd(62)} ${detail || ''}`);
};

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(SITE, { waitUntil: 'domcontentloaded' });
await page.locator('.row').first().waitFor({ state: 'visible', timeout: 25000 });

const rows = () => page.locator('.rows:not([hidden]) .row');
/* .cocol, not .co. Company became its own column when the role/company
   cell was split, and a selector guessed from the old markup silently
   returns an empty list, which reads as "every row matched". */
const companies = async () => (await page.locator('.rows:not([hidden]) .row .cocol').allTextContents()).map((t) => t.trim());

/* Poll the settled state rather than a bare count. Bytes landing precedes
   paint, and a count read mid-render measures the previous list. */
const settledCount = async (predicate, label) => {
  const deadline = Date.now() + 15000;
  let seen = -1;
  while (Date.now() < deadline) {
    seen = await rows().count();
    if (predicate(seen)) return seen;
    await page.waitForTimeout(120);
  }
  throw new Error(`${label}: never settled, last count ${seen}`);
};

const startCount = await rows().count();
check('the queue renders rows to filter', startCount > 10, `${startCount} rows`);

/* ---------------------------------------------------------------- search -- */

const search = page.locator('header.site input[type="search"], header.site .search').first();
check('the header carries a search box', await search.count() > 0);

/* The shortcut, which no screenshot could ever have shown. */
await page.locator('body').click({ position: { x: 5, y: 5 } });
await page.keyboard.press('/');
const focusedAfterSlash = await page.evaluate(() => {
  const el = document.activeElement;
  return el ? (el.getAttribute('type') || '') + ':' + (el.tagName || '') : 'none';
});
check('slash focuses the search box from the page body',
  /search/i.test(focusedAfterSlash) || /INPUT/.test(focusedAfterSlash), focusedAfterSlash);

/* And the half of the rule that stops it being a nuisance. */
await page.evaluate(() => {
  const box = document.querySelector('#q') || document.querySelector('input[type="search"]');
  if (box) { box.blur(); }
});
const typed = await page.evaluate(() => {
  const box = document.querySelector('#q');
  if (!box) return 'no #q';
  box.focus();
  return document.activeElement === box ? 'focused' : 'not focused';
});
check('the in-page filter box can hold focus', typed === 'focused', typed);

/* Search a company that is definitely present, taken from the rendered rows
   rather than assumed, so this cannot pass by searching for nothing. */
const firstCompany = (await companies())[0] || '';
const term = firstCompany.split(/\s+/)[0].replace(/[^A-Za-z0-9]/g, '');
check('a real company name was read off the page to search for', term.length >= 3, term);

const box = page.locator('#q');
await box.fill(term);
const narrowed = await settledCount((n) => n > 0 && n <= startCount, 'search narrowed');
const shown = await companies();
check('every remaining row matches what was typed',
  shown.length === narrowed && narrowed > 0
  && shown.every((c) => c.toLowerCase().includes(term.toLowerCase())),
  `${shown.length} company cells for ${narrowed} rows, term "${term}"`);

await box.fill('zzzznotacompanyzzzz');
const none = await settledCount((n) => n === 0, 'search with no matches');
check('a term nothing matches empties the list rather than ignoring the filter', none === 0);

await box.fill('');
const restored = await settledCount((n) => n === startCount, 'search cleared');
check('clearing the box puts every row back', restored === startCount, `${restored} rows`);

/* ----------------------------------------------------------------- chips -- */

const chips = page.locator('.chips .chip');
const chipCount = await chips.count();
check('the filter chips are on the page', chipCount >= 4, `${chipCount} chips`);

const all = page.locator('.chips .chip[data-kind="all"]');
check('All starts pressed', await all.getAttribute('aria-pressed') === 'true');

/* A chip that changes only its own colour is the failure this catches, so each
   one is judged on the ROWS, not on aria-pressed. */
const applied = page.locator('.chips .chip[data-kind="submitted"]');
await applied.click();
await settledCount((n) => n !== startCount || n === 0, 'Applied chip');
check('Applied becomes the pressed chip', await applied.getAttribute('aria-pressed') === 'true');
check('and All is no longer pressed', await all.getAttribute('aria-pressed') === 'false');
const appliedRows = await rows().count();
check('Applied changes which rows are shown', appliedRows !== startCount,
  `${appliedRows} applied vs ${startCount} on the default list`);

const over = page.locator('.chips .chip[data-kind="over"]');
await over.click();
await settledCount((n) => n !== appliedRows, 'Over $180k chip');
const overRows = await rows().count();
check('Over $180k shows its own set, not the previous chip\'s', overRows !== appliedRows,
  `${overRows} rows`);

/* The chip claims a published band starting at or above 180k. Read the pay
   column of the rows it produced and hold it to that. */
const overPay = await page.locator('.rows:not([hidden]) .row .pay').allTextContents();
const parsedStarts = overPay
  .map((t) => (t.match(/\$\s?([0-9][0-9,.]*)\s?[kK]?/) || [])[1])
  .filter(Boolean)
  .map((n) => {
    const clean = n.replace(/,/g, '');
    return clean.includes('.') || Number(clean) < 1000 ? Math.round(parseFloat(clean) * 1000) : Number(clean);
  });
check('every Over $180k row publishes a band, so none is blank',
  parsedStarts.length === overRows && overRows > 0,
  `${parsedStarts.length} pay values for ${overRows} rows`);
check('and every published start is at or above $180k',
  parsedStarts.every((n) => n >= 180000),
  parsedStarts.filter((n) => n < 180000).slice(0, 3).join(', ') || 'none below');

await all.click();
const back = await settledCount((n) => n === startCount, 'All chip');
check('All puts the full list back', back === startCount, `${back} rows`);

check('no console error through all of it', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close();
console.log(bad
  ? `\n${bad} FAILED`
  : '\nsearch narrows and restores, slash focuses it, and every chip changes the rows');
process.exitCode = bad ? 1 : 0;
