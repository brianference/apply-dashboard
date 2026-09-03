/**
 * Role and Company are two columns, and both can be resized.
 *
 * They were one 1fr cell labelled "Role / Company". The flexible column carries
 * no grip, so Brian could not widen it: the two values shared whatever space
 * was left after the fixed columns. He asked for two columns on 2026-09-03.
 *
 * A split like this fails quietly in three ways, so each is asserted: the header
 * count stops matching the cells per row and the grid silently shifts every
 * column left; the company text ends up in both places; or the new column
 * renders but has no grip and is exactly as unwidenable as before.
 *
 * Run: node tests/column-split.mjs [url]
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
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(name).padEnd(54)} ${detail || ''}`);
};

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(SITE, { waitUntil: 'domcontentloaded' });
await page.locator('.rows:not([hidden]) .row').first().waitFor({ state: 'visible', timeout: 25000 });
await page.waitForTimeout(800);

/* ---- the header ---- */
const labels = (await page.locator('.rows:not([hidden]) .colhead .colbtn .lbl').allTextContents())
  .map((t) => t.trim().replace(/\s*\(\d+\)$/, ''));
check('the header names Role and Company separately',
  labels.some((t) => /^ROLE$/i.test(t)) && labels.some((t) => /^COMPANY$/i.test(t)),
  labels.join(' | '));
check('the old combined label is gone',
  !labels.some((t) => /role\s*\/\s*company/i.test(t)), labels.join(' | '));

/* ---- the grid lines up ----
   A grid whose header has a different number of items than each row shifts
   every column sideways, and nothing throws. */
const geom = await page.evaluate(() => {
  const head = document.querySelector('.rows:not([hidden]) .colhead');
  const row = document.querySelector('.rows:not([hidden]) .row');
  const cols = (el) => getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/).length;
  const centres = (el) => [...el.children].map((c) => Math.round(c.getBoundingClientRect().left));
  return {
    headCols: cols(head), rowCols: cols(row),
    headKids: head.children.length,
    headLeft: centres(head), rowLeft: centres(row)
  };
});
check('the header and the rows use the same grid',
  geom.headCols === geom.rowCols, `${geom.headCols} vs ${geom.rowCols} tracks`);
check('the header has one item per track plus the action spacer',
  geom.headKids === geom.headCols, `${geom.headKids} items, ${geom.headCols} tracks`);

/* ---- the cells ---- */
const cells = await page.evaluate(() => {
  const r = document.querySelector('.rows:not([hidden]) .row');
  const t = r.querySelector('.ttl');
  const c = r.querySelector('.cocol');
  return {
    title: t ? t.textContent.trim() : null,
    company: c ? c.textContent.trim() : null,
    companyLeft: c ? Math.round(c.getBoundingClientRect().left) : null,
    titleLeft: t ? Math.round(t.getBoundingClientRect().left) : null,
    inMain: !!r.querySelector('.main .co')
  };
});
check('the row has a company cell of its own', !!cells.company, JSON.stringify(cells.company));
check('the company is not also inside the role cell', cells.inMain === false);
check('company sits to the right of the role',
  cells.companyLeft > cells.titleLeft, `${cells.titleLeft} -> ${cells.companyLeft}`);

/* ---- and it can actually be resized ----
   This is the whole point. A new column with no grip is exactly as unwidenable
   as the 1fr cell it replaced. */
const grip = page.locator('.rows:not([hidden]) .colgrip[data-grip="company"]').first();
check('the company column has a resize grip', await grip.count() > 0);

if (await grip.count()) {
  const before = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--w-co').trim());
  const box = await grip.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const after = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--w-co').trim());
  check('dragging the grip widens the company column',
    parseFloat(after) > parseFloat(before) + 20, `${before} -> ${after}`);
}

/* ---- mobile keeps the two-line row ---- */
await page.setViewportSize({ width: 375, height: 800 });
await page.waitForTimeout(400);
const mob = await page.evaluate(() => {
  const r = document.querySelector('.rows:not([hidden]) .row');
  const c = r.querySelector('.cocol');
  const conly = r.querySelector('.conly');
  return {
    cocolShown: c ? getComputedStyle(c).display !== 'none' : null,
    conlyText: conly ? conly.textContent.trim() : null,
    overflows: document.documentElement.scrollWidth > innerWidth
  };
});
check('375px: the company column is hidden', mob.cocolShown === false);
check('375px: the company still shows on the meta line', !!mob.conlyText, mob.conlyText);
check('375px: the page does not scroll sideways', mob.overflows === false);

check('no page errors', errors.length === 0, errors.join('; '));

await browser.close();
console.log(bad
  ? `\n${bad} FAILED - the column split is wrong`
  : '\nRole and Company are separate, aligned, and the company column resizes');
process.exitCode = bad ? 1 : 0;
