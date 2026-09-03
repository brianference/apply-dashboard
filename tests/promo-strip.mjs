/**
 * The signup invitation above the full-time table.
 *
 * It is rendered by the page's own JavaScript into the rows container, only for
 * a signed-out visitor, and only once /api/auth/me has answered. Each of those
 * three conditions is a way for it to silently not appear, so each is checked
 * rather than assumed.
 *
 *   node tests/promo-strip.mjs
 *   node tests/promo-strip.mjs --site http://127.0.0.1:8795
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
const SITE = siteFlag >= 0 ? args[siteFlag + 1] : 'https://apply-dashboard.pages.dev';

/** Desktop and the narrowest phone the product supports. */
const WIDTHS = [1440, 390];

const fails = [];

/**
 * @param {boolean} pass
 * @param {string} what
 * @param {string} [detail]
 * @returns {void}
 */
function ok(pass, what, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${what.padEnd(56)} ${detail}`);
  if (!pass) fails.push(what);
}

const browser = await chromium.launch();

try {
  for (const width of WIDTHS) {
    const ctx = await browser.newContext({
      viewport: { width, height: width === 390 ? 844 : 900 },
      colorScheme: 'light'
    });
    const page = await ctx.newPage();
    const errs = [];
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));

    await page.goto(SITE + '/', { waitUntil: 'networkidle' });
    await page.waitForSelector('.row', { timeout: 25000 });
    await page.waitForSelector('.ftpromo', { timeout: 15000 });

    const promo = page.locator('.ftpromo');
    ok(await promo.isVisible(), `${width}: the invitation is visible signed out`);

    /* Above the first row, not merely present somewhere on the page. */
    const strip = await promo.boundingBox();
    const firstRow = await page.locator('#rows-ft .row').first().boundingBox();
    ok(strip && firstRow && strip.y + strip.height <= firstRow.y + 1,
       `${width}: it sits above the first full-time row`);

    ok(await page.evaluate(() => !!document.querySelector('#rows-ft > .ftpromo')),
       `${width}: it is inside the full-time rows container`);

    const count = await promo.count();
    ok(count === 1, `${width}: exactly one on the page`, String(count));

    const hrefs = await page.locator('.ftpromo a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    ok(await page.locator('.ftpromo-cta').getAttribute('href') === '/login/?signup=1',
       `${width}: the button opens the signup form`);
    ok(hrefs.includes('/portfolio/'), `${width}: it links to the portfolio`);
    ok(hrefs.includes('/profile/'), `${width}: it links to the profile page`);

    /* The mobile layout kept flex-grow on the body text after the container
       flipped to a column, which stretched it down the box and left a dead gap
       above the button. Every other assertion passed while it looked like that,
       so the gap itself is measured. */
    if (width === 390) {
      const gap = await page.evaluate(() => {
        const text = document.querySelector('.ftpromo-b').getBoundingClientRect();
        const cta = document.querySelector('.ftpromo-cta').getBoundingClientRect();
        return Math.round(cta.top - text.bottom);
      });
      ok(gap >= 0 && gap <= 40, '390: no dead gap between the text and the button', `${gap}px`);
      ok(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)),
         '390: no horizontal overflow');
    }

    /* The button has to actually reach a working form. */
    await page.locator('.ftpromo-cta').click();
    await page.waitForLoadState('networkidle');
    ok(page.url().endsWith('/login/?signup=1'), `${width}: the button navigates to the form`, page.url());
    ok(await page.locator('#email').isVisible() && await page.locator('#password').isVisible(),
       `${width}: the form has an email and a password field`);
    const label = ((await page.locator('#submit').textContent()) || '').trim();
    ok(/create account/i.test(label), `${width}: the submit button says Create account`, JSON.stringify(label));

    ok(errs.length === 0, `${width}: console clean`, errs.slice(0, 2).join(' | '));
    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log(fails.length ? `\n${fails.length} FAILED` : '\nthe invitation renders and leads to a working form');
process.exit(fails.length ? 1 : 0);
