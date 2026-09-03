/**
 * The column-filter popup has to be usable where Brian actually uses it.
 *
 * He browses on a phone in DESKTOP MODE, so the viewport is wide enough for the
 * column header to render but short enough that a popup anchored under a header
 * button runs off the bottom. On 2026-09-03 he opened the Posted filter there,
 * the on-screen keyboard came up over it, and neither the checkboxes nor the
 * Apply button could be reached. Escape discards, so a selection made in a
 * popup whose Apply cannot be clicked is simply lost.
 *
 * Three things were wrong and each has a case here: left was clamped against
 * the right edge only, nothing kept the popup inside the viewport vertically,
 * and the search field grabbed focus unconditionally.
 *
 * Run: node tests/column-menu.mjs [url]
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
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(name).padEnd(56)} ${detail || ''}`);
};

const browser = await chromium.launch({ headless: true });

/* 980x520 is a phone in desktop mode: wide enough for .colhead, short enough
   that a popup under the header would overflow. 1440x1000 is a real desktop. */
for (const [w, h, touch, label] of [
  [980, 520, true, 'phone in desktop mode'],
  [1440, 1000, false, 'desktop']
]) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    hasTouch: touch,
    isMobile: false
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(SITE, { waitUntil: 'domcontentloaded' });
  await page.locator('.row').first().waitFor({ state: 'visible', timeout: 25000 });
  await page.waitForTimeout(700);

  /* The Posted column is the one he was using, and it is the rightmost
     filterable header, so it is also the worst case for the left clamp. */
  await page.locator('.colbtn[data-col="posted"] .fun').first().click();
  await page.locator('.fmenu').waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(250);

  const box = await page.evaluate(() => {
    const m = document.querySelector('.fmenu');
    const b = m.getBoundingClientRect();
    const apply = m.querySelector('button.ok').getBoundingClientRect();
    const first = m.querySelector('.flist label input[type="checkbox"]').getBoundingClientRect();
    return {
      x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
      applyTop: Math.round(apply.top), applyBottom: Math.round(apply.bottom),
      firstTop: Math.round(first.top), firstBottom: Math.round(first.bottom),
      vw: innerWidth, vh: innerHeight,
      focused: document.activeElement && document.activeElement.className
    };
  });

  check(`${label}: the popup is inside the viewport horizontally`,
    box.x >= 0 && box.x + box.w <= box.vw, `x=${box.x} w=${box.w} vw=${box.vw}`);
  check(`${label}: the popup is inside the viewport vertically`,
    box.y >= 0 && box.y + box.h <= box.vh, `y=${box.y} h=${box.h} vh=${box.vh}`);
  check(`${label}: the Apply button is on screen`,
    box.applyTop >= 0 && box.applyBottom <= box.vh,
    `${box.applyTop}-${box.applyBottom} in ${box.vh}`);
  check(`${label}: the first checkbox is on screen`,
    box.firstTop >= 0 && box.firstBottom <= box.vh,
    `${box.firstTop}-${box.firstBottom} in ${box.vh}`);

  /* The keyboard is what covered it. Playwright cannot raise one, but it is
     raised by the focus, so the focus is what gets asserted. */
  const searchFocused = String(box.focused || '').indexOf('fsearch') !== -1;
  check(`${label}: search ${touch ? 'does NOT' : 'does'} steal focus`,
    touch ? !searchFocused : searchFocused, `activeElement=${box.focused}`);

  /* And it still works: tick a value, Apply, and the filter engages. */
  await page.locator('.fmenu .flist label input[type="checkbox"]').first().uncheck();
  await page.locator('.fmenu button.ok').click();
  await page.waitForTimeout(500);
  check(`${label}: applying from the popup engages the filter`,
    (await page.locator('.colbtn[data-on="true"]').count()) >= 1,
    `${await page.locator('.colbtn[data-on="true"]').count()} header button(s) marked`);

  check(`${label}: no page errors`, errors.length === 0, errors.join('; '));
  await ctx.close();
}

await browser.close();
console.log(bad
  ? `\n${bad} FAILED - the column popup is unreachable somewhere`
  : '\nthe column popup stays on screen and keeps its keyboard down on touch');
process.exitCode = bad ? 1 : 0;
