/**
 * The sign-in panel must stay inside the viewport.
 *
 * At 320px the header wraps and .tools sits in a ~126px row on the left.
 * The panel was position:absolute; right:0 against that row, so a 296px
 * panel started at a negative x -- Brian's screenshot showed only its
 * right half. Anchoring it to .top is the fix; this is what fails if
 * someone puts position:relative back on .tools.
 *
 * Run: node tests/header-panel.mjs [url]
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

/** Widths that wrap (320) and widths that do not, plus desktop. */
const WIDTHS = [320, 360, 390, 412, 1280];

/**
 * True when a box sits fully inside the layout viewport on the x axis.
 * A panel whose box fits while a field hangs off is the same bug, so
 * each control is checked with this, not only the panel itself.
 * @param {{x: number, width: number}|null} box
 * @param {number} innerWidth
 * @returns {{ok: boolean, detail: string}}
 */
function fitsX(box, innerWidth) {
  if (!box || !(box.width > 0)) {
    return { ok: false, detail: box ? `x=${box.x} w=${box.width} vw=${innerWidth}` : 'no box' };
  }
  const ok = box.x >= 0 && box.x + box.width <= innerWidth;
  return { ok, detail: `x=${box.x.toFixed(2)} w=${box.width.toFixed(2)} vw=${innerWidth}` };
}

const browser = await chromium.launch({ headless: true });

for (const width of WIDTHS) {
  const height = width === 1280 ? 900 : 844;
  const ctx = await browser.newContext({
    viewport: { width, height },
    colorScheme: 'dark'
  });
  /* The app reads apply-theme from localStorage, not prefers-color-scheme.
     colorScheme alone would leave the page light. */
  await ctx.addInitScript(() => {
    try { localStorage.setItem('apply-theme', 'dark'); } catch { /* private mode */ }
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(SITE, { waitUntil: 'domcontentloaded' });
  const signin = page.locator('header.site button.signin');
  await signin.waitFor({ state: 'visible', timeout: 25000 });
  await signin.click();
  const panel = page.locator('header.site .panel');
  await panel.waitFor({ state: 'visible', timeout: 5000 });

  const innerWidth = await page.evaluate(() => window.innerWidth);
  const panelFit = fitsX(await panel.boundingBox(), innerWidth);
  check(`${width}: panel inside viewport`, panelFit.ok, panelFit.detail);

  const emailFit = fitsX(await page.locator('#nav-email').boundingBox(), innerWidth);
  check(`${width}: email field inside viewport`, emailFit.ok, emailFit.detail);

  const passwordFit = fitsX(await page.locator('#nav-password').boundingBox(), innerWidth);
  check(`${width}: password field inside viewport`, passwordFit.ok, passwordFit.detail);

  const toggleFit = fitsX(await page.locator('header.site .pw-toggle').boundingBox(), innerWidth);
  check(`${width}: Show toggle inside viewport`, toggleFit.ok, toggleFit.detail);

  const submitFit = fitsX(await page.locator('header.site .panel .submit').boundingBox(), innerWidth);
  check(`${width}: submit inside viewport`, submitFit.ok, submitFit.detail);

  const overflow = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    iw: window.innerWidth
  }));
  check(`${width}: no horizontal overflow`, overflow.sw <= overflow.iw,
    `scrollWidth ${overflow.sw} innerWidth ${overflow.iw}`);

  check(`${width}: no console or page errors`, errors.length === 0, errors.join('; '));
  await ctx.close();
}

await browser.close();
console.log(bad ? `\n${bad} FAILED - the panel or a control hangs off the viewport` : '\npanel stays inside the viewport at every width');
process.exitCode = bad ? 1 : 0;
