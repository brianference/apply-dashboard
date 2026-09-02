/**
 * Every number on the page must equal the rows it claims to count.
 *
 * The FULL-TIME tile once read 510 over a list of 237, because the rows hid
 * ruled-out postings and the tile counted them. Toggling All against Full-time
 * changed nothing visible for the same reason: the two numbers were answering
 * different questions under the same label.
 *
 * This drives the real page and compares each count against the rows actually
 * rendered when that filter is selected. It is the enforcement, not the fix --
 * the fix is one shared onTheList() predicate, and this is what fails when
 * somebody writes a second one.
 *
 * Run: node apply/test-counts.local.mjs
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

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(SITE, { waitUntil: 'domcontentloaded' });
await page.locator('.row').first().waitFor({ state: 'visible', timeout: 25000 });
await page.waitForTimeout(800);

const num = async (sel) => Number((await page.locator(sel).textContent()).replace(/[^\d]/g, '')) || 0;
const rows = async () => page.locator('.row').count();

/* Each chip's count against the rows that chip actually shows. */
const cases = [
  ['Full-time', '#s-ft', 'ft'],
  ['PT / C2C', '#s-pt', 'ptc2c'],
  ['Applied', '#s-sub', 'submitted'],
];
for (const [label, tile, kind] of cases) {
  const claimed = await num(tile);
  await page.locator(`.chip[data-kind="${kind}"]`).click();
  await page.waitForTimeout(500);
  const shown = await rows();
  check(`${label} tile equals the rows it filters to`, claimed === shown, `tile ${claimed}, rows ${shown}`);
}

/* Chips that carry their own number must equal the rows they reveal. The
   number and the rows are written in two different places in render(), which
   is exactly the shape that once put 510 over a list of 237. */
for (const [label, chip, badge] of [
  ['Over $180k', 'over', '#nover'],
  ['Apply direct', 'direct', '#ndirect'],
  ['Needs you', 'manual', '#nmanual'],
  ['Over 30 days', 'stale', '#nstale']
]) {
  await page.locator('.chip[data-kind="all"]').click();
  await page.waitForTimeout(400);
  const claimed = Number(((await page.locator(badge).textContent()) || '').replace(/[^\d]/g, '')) || 0;
  await page.locator(`.chip[data-kind="${chip}"]`).click();
  await page.waitForTimeout(500);
  const shown = await rows();
  check(`${label} chip equals the rows it reveals`, claimed === shown,
    `chip ${claimed}, rows ${shown}`);
}

/* All must equal full-time plus PT/C2C, or one of the three is lying. */
await page.locator('.chip[data-kind="all"]').click();
await page.waitForTimeout(500);
const all = await rows();
const ft = await num('#s-ft');
const pt = await num('#s-pt');
check('All equals full-time plus PT/C2C', all === ft + pt, `all ${all}, ft ${ft} + pt ${pt} = ${ft + pt}`);

/* The toggle has to actually do something, or the counts are wrong somewhere. */
await page.locator('.chip[data-kind="ft"]').click();
await page.waitForTimeout(500);
const ftRows = await rows();
check('switching All to Full-time changes the list', ftRows !== all || pt === 0,
  `all ${all} -> full-time ${ftRows} (PT/C2C ${pt})`);

/* Nothing ruled out may be counted anywhere. */
const leaked = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('.row').forEach(r => {
    const why = (r.querySelector('.why') || {}).textContent || '';
    if (/location not eligible|posting closed|off-criteria|duplicate/i.test(why)) out.push(why.trim().slice(0, 40));
  });
  return out;
});
check('no ruled-out posting is on the list', leaked.length === 0, leaked.slice(0, 3).join(' | '));

check('no page errors', errors.length === 0, errors.join('; '));

await browser.close();
console.log(bad ? `\n${bad} FAILED - a count disagrees with the rows` : '\nevery count equals the rows it claims');
process.exitCode = bad ? 1 : 0;
