/**
 * The way out of the tour must never scroll away.
 *
 * Brian sent a screenshot of step 5 with Skip, Back and Done cut off at the
 * bottom of the popover and a scrollbar beside them. The popover scrolled as a
 * single element, so whenever its content was taller than max-height the action
 * row sat below the fold of its own box. He could see the tour and could not
 * leave it.
 *
 * I could not reproduce it from viewport height alone; it needs a zoom level or
 * a text size I did not hit headlessly. So this forces the condition directly by
 * making the body text tall, which is what zoom does to the layout. On the CSS
 * that shipped, this FAILS.
 *
 *   node tests/tour-overflow.mjs --site http://127.0.0.1:8798
 */

import { createRequire } from 'node:module';
/* Brian's machine keeps Playwright in RedAnvil; a CI runner installs its own.
   Try the local copy, fall back to a normal resolution, so the same file runs
   in both places -- and in a git WORKTREE, which has no node_modules of its
   own. A direct `import { chromium } from 'playwright'` fails there, which is
   how a delegated run reported four failures that were not its fault. */
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('C:/Users/brian/RedAnvil/node_modules/playwright')); }
catch { ({ chromium } = await import('playwright')); }

const args = process.argv.slice(2);
const siteFlag = args.indexOf('--site');
const SITE = siteFlag >= 0 ? args[siteFlag + 1] : 'http://127.0.0.1:8798';

/** Heights that leave the popover no room to grow. */
const VIEWPORTS = [{ width: 1280, height: 420 }, { width: 390, height: 460 }];

const fails = [];

/**
 * @param {boolean} pass
 * @param {string} what
 * @param {string} [detail]
 * @returns {void}
 */
function ok(pass, what, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${what.padEnd(58)} ${detail}`);
  if (!pass) fails.push(what);
}

const browser = await chromium.launch();

try {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: vp, colorScheme: 'light' });
    const page = await ctx.newPage();
    /* The tour only opens for a signed-in account that has not seen it, so the
       identity call is stubbed. This test is about layout, not auth. */
    await page.route('**/api/auth/me', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ authenticated: true, email: 'layout@example.invalid', name: 'Layout Test', avatar: null, tour_seen_at: null })
    }));
    await page.route('**/api/tour/seen', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true })
    }));

    await page.goto(SITE + '/', { waitUntil: 'networkidle' });
    await page.waitForSelector('.row', { timeout: 25000 });
    await page.waitForSelector('#tour-next', { timeout: 20000 });

    /* Force the overflow. A long body is what a zoomed-in browser produces. */
    await page.evaluate(() => {
      const body = document.querySelector('#tour-body');
      body.textContent = new Array(40).fill(
        'A profile builds a public portfolio page at its own address.'
      ).join(' ');
    });
    await page.waitForTimeout(250);

    const m = await page.evaluate(() => {
      const pop = document.querySelector('#tour-root .popover');
      const acts = document.querySelector('#tour-root .popover-actions');
      const next = document.querySelector('#tour-next');
      const pr = pop.getBoundingClientRect();
      const ar = acts.getBoundingClientRect();
      const nr = next.getBoundingClientRect();
      return {
        popTop: Math.round(pr.top), popBottom: Math.round(pr.bottom),
        actionsTop: Math.round(ar.top), actionsBottom: Math.round(ar.bottom),
        nextBottom: Math.round(nr.bottom), vh: window.innerHeight,
        /* Below the popover's own visible edge: the defect. */
        clipped: ar.bottom > pr.bottom + 1,
        offscreen: nr.bottom > window.innerHeight + 1
      };
    });

    const at = `${vp.width}x${vp.height}`;
    ok(!m.clipped, `${at}: the actions are inside the popover`,
      `actions ${m.actionsBottom} vs popover ${m.popBottom}`);
    ok(!m.offscreen, `${at}: the Next button is on screen`,
      `next ${m.nextBottom} vs viewport ${m.vh}`);

    /* The only thing that really matters: can a person leave the tour? */
    let clickable = true;
    try { await page.locator('#tour-skip').click({ timeout: 3000 }); } catch { clickable = false; }
    ok(clickable, `${at}: Skip can actually be clicked`);
    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log(fails.length
  ? `\n${fails.length} FAILED`
  : '\nthe action row stays put however tall the content gets');
process.exit(fails.length ? 1 : 0);
