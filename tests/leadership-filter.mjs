/**
 * Director and above is off the main list and behind its own pill.
 *
 * Brian, 2026-09-02: he is less confident about director of product or head of
 * product roles because they ask for more experience than he has.
 *
 * The first version of the rule went into index.html through a shell heredoc,
 * which turned every \b into a literal backspace character. The pattern still
 * read correctly in an editor, matched almost nothing, and the pill counted 3
 * rows where 32 were expected. Nothing threw, no count disagreed with its own
 * rows, and the page looked fine. So this asserts against real titles and
 * against a floor on the count, because a rule that silently matches nothing
 * is the failure this exists to catch.
 *
 * Run: node tests/leadership-filter.mjs [url]
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

/* Written out independently of the page's own pattern on purpose. A test that
   imports the regex it is checking cannot notice that the regex is wrong. */
const LEADERSHIP = /\bdirector\b|head of product|\bvp\b|vice president|chief product officer|\bcpo\b/i;

let bad = 0;
const check = (name, ok, detail) => {
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(name).padEnd(54)} ${detail || ''}`);
};

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(SITE, { waitUntil: 'domcontentloaded' });
await page.locator('.row').first().waitFor({ state: 'visible', timeout: 25000 });
await page.waitForTimeout(800);

const titles = async () =>
  (await page.locator('.rows:not([hidden]) .row .ttl').allTextContents()).map((t) => t.trim());

/* ---- the default list ---- */
const defaultTitles = await titles();
const leaked = defaultTitles.filter((t) => LEADERSHIP.test(t));
check('no director-level title is on the default list', leaked.length === 0,
  leaked.slice(0, 3).join(' | ') || `${defaultTitles.length} titles checked`);

check('senior individual-contributor titles are still there',
  defaultTitles.some((t) => /\b(principal|staff|senior|group) product manager\b/i.test(t)),
  defaultTitles.filter((t) => /\b(principal|staff) product manager\b/i.test(t)).length + ' principal/staff rows');

/* ---- the pill ---- */
const pill = page.locator('.chip[data-kind="leadership"]');
check('the pill exists', await pill.count() === 1);

const claimed = Number(((await page.locator('#nlead').textContent()) || '').replace(/[^\d]/g, '')) || 0;
/* The floor. A pattern whose escapes were eaten matches nothing, every count
   agrees with its own empty row set, and only this assertion notices. */
check('the pill count is not silently zero or near-zero', claimed >= 5,
  `pill reads ${claimed}`);

await pill.click();
await page.waitForTimeout(600);
const shown = await titles();
check('the pill count equals the rows it reveals', shown.length === claimed,
  `${shown.length} rows vs ${claimed} on the pill`);

const wrong = shown.filter((t) => !LEADERSHIP.test(t));
check('every row behind the pill is director level', wrong.length === 0,
  wrong.slice(0, 3).join(' | ') || `${shown.length} rows checked`);

/* ---- and back ---- */
await page.locator('#clearall').click();
await page.waitForTimeout(600);
const afterClear = await titles();
check('clearing returns the list without them', afterClear.length === defaultTitles.length
  && afterClear.filter((t) => LEADERSHIP.test(t)).length === 0,
  `${afterClear.length} vs ${defaultTitles.length}`);

check('no page errors', errors.length === 0, errors.join('; '));

await browser.close();
console.log(bad
  ? `\n${bad} FAILED - the leadership lens is wrong`
  : '\ndirector level is hidden by default and complete behind the pill');
process.exitCode = bad ? 1 : 0;
