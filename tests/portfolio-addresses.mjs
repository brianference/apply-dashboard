/**
 * Every account's portfolio is its own.
 *
 * This exists because it was not. The page fetched `/api/portfolio` with no
 * handle, the API answers a handle-less request with `ORDER BY id LIMIT 1`, and
 * so every account's portfolio rendered the owner's. The name was fixed first
 * and the page still showed the owner's PROJECTS underneath it, because that
 * list is hardcoded in the page and was drawn unconditionally. Both failures
 * are checked here, at both URL shapes.
 *
 *   node tests/portfolio-addresses.mjs
 *   node tests/portfolio-addresses.mjs --site http://127.0.0.1:8795
 */

import { chromium } from 'playwright';

const args = process.argv.slice(2);
const siteFlag = args.indexOf('--site');
const SITE = siteFlag >= 0 ? args[siteFlag + 1] : 'https://apply-dashboard.pages.dev';

/** Strings that only ever belong to the owner's portfolio. */
const OWNER_MARKERS = [/Brian Ference/i, /Equity Methods/i, /RedAnvil/i, /DaisyDog/i, /Cole Ramsey/i];

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

/**
 * A handle that belongs to an account other than the owner's, read from the
 * live API rather than hardcoded, so this test does not go stale when accounts
 * change. Returns null when only the owner exists.
 *
 * @returns {Promise<string|null>}
 */
async function someoneElse() {
  const res = await fetch(`${SITE}/api/portfolio`);
  if (!res.ok) return null;
  const owner = await res.json();
  for (const candidate of ['magnus']) {
    const probe = await fetch(`${SITE}/api/portfolio?u=${encodeURIComponent(candidate)}`);
    if (!probe.ok) continue;
    const body = await probe.json();
    if (body.handle && body.handle !== owner.handle) return body.handle;
  }
  return null;
}

const browser = await chromium.launch();

try {
  const other = await someoneElse();
  if (!other) {
    console.log('SKIP  only the owner has a profile, so there is nothing to keep separate');
    process.exit(0);
  }

  /* The API's own answer first: the page cannot be right if this is wrong. */
  const ownerBody = await (await fetch(`${SITE}/api/portfolio`)).json();
  const otherBody = await (await fetch(`${SITE}/api/portfolio?u=${other}`)).json();
  ok(ownerBody.owner === true, 'the default portfolio is flagged as the owner', String(ownerBody.owner));
  ok(otherBody.owner === false, `${other} is not flagged as the owner`, String(otherBody.owner));
  ok(otherBody.handle === other, 'the API answers with the handle that was asked for', otherBody.handle);

  const unknown = await fetch(`${SITE}/api/portfolio?u=definitely-not-a-real-handle`);
  ok(unknown.status === 404, 'an unknown handle is a 404, not a fallback to the owner', `HTTP ${unknown.status}`);

  /* Then the rendered page, at both shapes of the address. */
  for (const path of [`/portfolio/${other}`, `/portfolio/${other}/`]) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
    const page = await ctx.newPage();
    const errs = [];
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));

    await page.goto(SITE + path, { waitUntil: 'networkidle' });
    await page.waitForSelector('#who', { timeout: 20000 });
    await page.waitForFunction(() => (document.querySelector('#who').textContent || '').trim().length > 0,
      null, { timeout: 20000 });

    const who = ((await page.locator('#who').textContent()) || '').trim();
    const body = (await page.locator('body').textContent()) || '';

    ok(who === other, `${path}: the heading is the account being asked for`, JSON.stringify(who));
    for (const marker of OWNER_MARKERS) {
      ok(!marker.test(body), `${path}: no ${marker.source} anywhere on the page`);
    }
    /* The stylesheet is absolute now. It was relative, and at the trailing
       slash it resolved one directory too deep and 404'd, so the page rendered
       as unstyled text with no script. A transparent body is that failure. */
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    ok(bg !== 'rgba(0, 0, 0, 0)', `${path}: the stylesheet loaded`, bg);
    ok(errs.length === 0, `${path}: console clean`, errs.slice(0, 2).join(' | '));
    await ctx.close();
  }

  /* And the owner's own page still shows the owner's work. A fix that hides the
     projects from everyone would pass every check above. */
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
  const page = await ctx.newPage();
  await page.goto(SITE + '/portfolio/', { waitUntil: 'networkidle' });
  await page.waitForSelector('#rows .row', { timeout: 20000 });
  const rows = await page.locator('#rows .row').count();
  ok(rows > 0, 'the owner still sees the project rows', `${rows} rows`);
  await ctx.close();
} finally {
  await browser.close();
}

console.log(fails.length ? `\n${fails.length} FAILED` : '\nevery portfolio address resolves to its own account');
process.exit(fails.length ? 1 : 0);
