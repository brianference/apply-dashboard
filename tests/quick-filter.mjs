/**
 * The quick filter: $165k+, posted within seven days, ranked.
 *
 * Brian, 2026-09-03, asked for one control at the top that does all three. Each
 * of the three can fail on its own and the other two would still look right,
 * so each is checked against the rows rather than against the button's label.
 *
 * The sort is the part most likely to be got wrong. "Best match" orders by pay
 * LANE first and only then by score, so a confirmed-band 32% sits above an
 * unpriced 74% under it. He asked for rank descending, which is the column
 * sort on the score. A test that only asserted "something is sorted" would pass
 * either way.
 *
 * Run: node tests/quick-filter.mjs [url]
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
const MIN_START = 165000;
const WINDOW_DAYS = 7;

let bad = 0;
const check = (name, ok, detail) => {
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(name).padEnd(56)} ${detail || ''}`);
};

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(SITE, { waitUntil: 'domcontentloaded' });
await page.locator('.row').first().waitFor({ state: 'visible', timeout: 25000 });
await page.waitForTimeout(800);

const btn = page.locator('#quick');
check('the quick filter exists', await btn.count() === 1);
check('it is the first control in the toolbar',
  await page.evaluate(() => {
    const t = document.querySelector('.toolbar');
    return t && t.firstElementChild && t.firstElementChild.id === 'quick';
  }), '');

const before = await page.locator('.rows:not([hidden]) .row').count();
const claimed = Number(((await page.locator('#nquick').textContent()) || '').replace(/[^\d]/g, '')) || 0;

await btn.click();
await page.waitForTimeout(700);

const rows = await page.evaluate(() => [...document.querySelectorAll('.rows:not([hidden]) .row')].map((r) => ({
  pct: Number((r.querySelector('.pct').textContent || '').replace('%', '')) || 0,
  pay: (r.querySelector('.pay').textContent || '').trim(),
  posted: (r.querySelector('.posted').textContent || '').trim()
})));

check('the count on the button equals the rows it reveals', rows.length === claimed,
  `${rows.length} rows vs ${claimed} on the button`);
check('it narrows the list', rows.length < before, `${rows.length} < ${before}`);
/* A preset that matches nothing looks identical to one that is wired wrong. */
check('it is not silently empty', rows.length > 0, `${rows.length} rows`);

/* ---- each of the three, separately ---- */
const lowPay = rows.filter((r) => {
  const m = /^\$(\d+)k/.exec(r.pay);
  return !m || Number(m[1]) * 1000 < MIN_START;
});
check(`every row starts at $${MIN_START / 1000}k or above`, lowPay.length === 0,
  lowPay.slice(0, 3).map((r) => r.pay || '(blank)').join(' | ') || `${rows.length} bands checked`);

const tooOld = rows.filter((r) => {
  if (r.posted === 'today') return false;
  const m = /^(\d+)d ago$/.exec(r.posted);
  return !m || Number(m[1]) > WINDOW_DAYS;
});
check(`every row was posted within ${WINDOW_DAYS} days`, tooOld.length === 0,
  tooOld.slice(0, 3).map((r) => r.posted || '(blank)').join(' | ') || `${rows.length} dates checked`);

const pcts = rows.map((r) => r.pct);
check('the rows are in descending rank order',
  pcts.every((v, i) => i === 0 || pcts[i - 1] >= v), pcts.slice(0, 6).join(','));

/* The distinguishing assertion. Under "Best match" the order is pay lane then
   score, so the sequence would break at a lane boundary. Requiring the FIRST
   row to hold the highest score in the set catches that. */
check('the top row holds the highest score in the set',
  rows.length > 0 && pcts[0] === Math.max.apply(null, pcts),
  `top ${pcts[0]}, max ${Math.max.apply(null, pcts)}`);

check('the sort control shows it is sorted by a column',
  (await page.inputValue('#sort')) === '__col', await page.inputValue('#sort'));
check('the posted-within window is set to a week',
  (await page.inputValue('#freshsel')) === String(WINDOW_DAYS), await page.inputValue('#freshsel'));
check('the button reads as pressed',
  (await btn.getAttribute('aria-pressed')) === 'true');

/* ---- and clearing it puts everything back ---- */
await page.locator('#clearall').click();
await page.waitForTimeout(700);
check('clearing restores the full list',
  (await page.locator('.rows:not([hidden]) .row').count()) === before,
  `${await page.locator('.rows:not([hidden]) .row').count()} vs ${before}`);
check('clearing releases the preset sort too',
  (await page.inputValue('#sort')) !== '__col', await page.inputValue('#sort'));
check('clearing clears the window', (await page.inputValue('#freshsel')) === '');
check('the button is no longer pressed',
  (await btn.getAttribute('aria-pressed')) === 'false');

check('no page errors', errors.length === 0, errors.join('; '));

await browser.close();
console.log(bad
  ? `\n${bad} FAILED - the quick filter does not do all three`
  : '\n$165k+, posted within a week, highest rank first');
process.exitCode = bad ? 1 : 0;
