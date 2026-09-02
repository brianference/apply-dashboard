/**
 * The Clear all filters button must clear all the filters.
 *
 * Brian asked for it after filtering himself into a view he could not easily
 * undo. A button like this fails in two quiet ways: it resets the controls but
 * not the state behind them, so the list stays narrowed while the toolbar
 * looks clean, or it resets some lenses and not others. Both look fine in a
 * screenshot. This drives the real page and compares the row count against the
 * untouched baseline, which is the only number that cannot be argued with.
 *
 * Run: node tests/clear-filters.mjs [url]
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
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(name).padEnd(52)} ${detail || ''}`);
};

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(SITE, { waitUntil: 'domcontentloaded' });
await page.locator('.row').first().waitFor({ state: 'visible', timeout: 25000 });
await page.waitForTimeout(800);

const rows = () => page.locator('.row').count();
const btn = page.locator('#clearall');

const baseline = await rows();
check('the button exists', await btn.count() === 1);
check('it is disabled with nothing filtered', await btn.isDisabled(),
  await btn.textContent());
check('it reads "Clear all filters" when idle',
  ((await btn.textContent()) || '').trim() === 'Clear all filters');

/* One filter at a time, so the count in the label is checked as it grows. */
await page.fill('#q', 'product');
await page.waitForTimeout(400);
check('one filter enables it and it says 1', !(await btn.isDisabled())
  && /Clear 1 filter$/.test(((await btn.textContent()) || '').trim()),
  ((await btn.textContent()) || '').trim());

await page.locator('.chip[data-kind="ft"]').click();
await page.waitForTimeout(400);
await page.selectOption('#freshsel', '7');
await page.locator('#freshnote').waitFor({ state: 'visible', timeout: 5000 });
check('three filters say 3', /Clear 3 filters$/.test(((await btn.textContent()) || '').trim()),
  ((await btn.textContent()) || '').trim());

/* A column filter is the one most easily forgotten by a reset, because it
   lives in a popup rather than in the toolbar. */
/* The header button sorts; the small arrow inside it opens the filter popup.
   Its own title says so, and clicking the button body just re-sorted the list
   the first time this was written. */
await page.locator('.colbtn[data-col="ats"] .fun').first().click();
await page.locator('.fmenu').waitFor({ state: 'visible', timeout: 5000 });
/* The popup discards on Escape and commits on Apply. Unticking a value and
   walking away is exactly the interaction that left this branch vacuous the
   first time it was written. */
await page.locator('.fmenu .flist label input[type="checkbox"]').first()
  .uncheck({ timeout: 5000 });
await page.locator('.fmenu button.ok').click();
await page.waitForTimeout(500);
const withColumn = ((await btn.textContent()) || '').trim();
/* Assert the column filter actually engaged. Without this the check below --
   "no column header still shows a filter count" -- passes whether or not the
   popup ever applied anything, which is a check that cannot fail. */
/* The column header is rendered once per SECTION, so one active column filter
   marks three buttons, not one. Asserting exactly one was wrong and said so
   loudly, which is what the assertion is for. */
check('the column filter engaged, so clearing it means something',
  /Clear 4 filters$/.test(withColumn)
  && (await page.locator('.colbtn[data-on="true"]').count()) >= 1,
  `${withColumn}, ${await page.locator('.colbtn[data-on="true"]').count()} header button(s) marked`);
const narrowed = await rows();
check('the list is actually narrowed before clearing', narrowed < baseline,
  `${narrowed} < ${baseline}`);

await btn.click();
await page.waitForTimeout(700);

check('the row count returns to the baseline', (await rows()) === baseline,
  `${await rows()} vs ${baseline}`);
check('the search box is empty', ((await page.inputValue('#q')) || '') === '');
check('the All chip is pressed again',
  (await page.locator('.chip[data-kind="all"]').getAttribute('aria-pressed')) === 'true');
check('the posted-within window is any time',
  ((await page.inputValue('#freshsel')) || '') === '');
check('the freshness note is gone', await page.locator('#freshnote').isHidden());
check('no column header still shows a filter count',
  (await page.locator('.colbtn[data-on="true"]').count()) === 0,
  `${await page.locator('.colbtn[data-on="true"]').count()} still on`);
check('the button disables itself again', await btn.isDisabled(),
  ((await btn.textContent()) || '').trim());
check('and reads "Clear all filters" again',
  ((await btn.textContent()) || '').trim() === 'Clear all filters');
check('no page errors', errors.length === 0, errors.join('; '));

await browser.close();
console.log(bad
  ? `\n${bad} FAILED - the clear button does not clear everything (label with a column filter was "${withColumn}")`
  : '\nclearing puts every lens back to the whole list');
process.exitCode = bad ? 1 : 0;
