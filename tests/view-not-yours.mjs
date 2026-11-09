/**
 * The page says so when the list it shows is not the reader's own.
 *
 * 2026-11-08: the $165k+ button showed 20 rows and 18 had already been applied
 * to. /api/jobs had served the shared statuses -- no session reached it -- and
 * nothing on screen said so, because a legacy write token in localStorage made
 * the page believe it was signed in. /api/jobs now reports `viewer`, and the
 * banner is driven by that answer rather than by the page's own guess.
 *
 * Each case stubs only the `viewer` field onto the real production rows, so the
 * list itself is genuine. The legacy-token + "public" case is the one the old
 * page fails: its banner stayed hidden.
 *
 * Run: node tests/view-not-yours.mjs [url]   (a local build: node tests/serve-local.mjs)
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('C:/Users/brian/RedAnvil/node_modules/playwright')); }
catch { ({ chromium } = await import('playwright')); }

const SITE = process.argv[2] || 'https://apply-dashboard.pages.dev';
const ROW_TIMEOUT_MS = 25000;
const BANNER_TIMEOUT_MS = 5000;

let bad = 0;
const check = (name, ok, detail) => {
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(name).padEnd(60)} ${detail || ''}`);
};

const browser = await chromium.launch({ headless: true });

/**
 * Load the page with /api/jobs answering `viewer`, optionally holding a legacy token.
 * @param {string|undefined} viewer
 * @param {boolean} legacyToken
 * @returns {Promise<{text: string, visible: boolean, errors: string[]}>}
 */
async function bannerFor(viewer, legacyToken) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  if (legacyToken) await ctx.addInitScript(() => { try { localStorage.setItem('apply-token', 'legacy-test-token'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/jobs**', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    if (viewer === undefined) delete body.viewer; else body.viewer = viewer;
    await route.fulfill({ response: res, body: JSON.stringify(body) });
  });
  await page.goto(SITE, { waitUntil: 'domcontentloaded' });
  await page.locator('.row').first().waitFor({ state: 'visible', timeout: ROW_TIMEOUT_MS });
  const banner = page.locator('#stale');
  let visible = true;
  try { await banner.waitFor({ state: 'visible', timeout: BANNER_TIMEOUT_MS }); } catch { visible = false; }
  const text = visible ? ((await banner.textContent()) || '').trim() : '';
  await ctx.close();
  return { text, visible, errors };
}

const SHOWING = 'Jobs you applied to are showing';

let r = await bannerFor('public', true);
check('signed out + legacy token: the banner is up', r.visible, r.text.slice(0, 70));
check('  and it says applied jobs are showing', r.text.includes(SHOWING) && r.text.includes('not signed in'));

r = await bannerFor('overlay-failed', true);
check('signed in, marks failed to load: the banner is up', r.visible && r.text.includes(SHOWING) && r.text.includes('could not be loaded'), r.text.slice(0, 70));

r = await bannerFor('public', false);
check('signed out, no token: the banner says applied jobs are not hidden', r.visible && r.text.includes('jobs you applied to are not hidden'), r.text.slice(0, 70));

r = await bannerFor('account', true);
check('own list: no "applied jobs are showing" banner', !r.text.includes(SHOWING), r.visible ? r.text.slice(0, 70) : 'hidden');

r = await bannerFor(undefined, true);
check('older server without viewer: no false alarm', !r.text.includes(SHOWING), r.visible ? r.text.slice(0, 70) : 'hidden');
check('no page errors in the last case', r.errors.length === 0, r.errors.join('; '));

await browser.close();
console.log(bad ? `\n${bad} FAILED` : '\nthe banner follows whose list /api/jobs served');
process.exitCode = bad ? 1 : 0;
