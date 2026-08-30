/**
 * The first-run spotlight tour.
 *
 * Drives a real browser against a local server that serves this worktree, with
 * /api/auth/me and /api/jobs intercepted so the tour can open without writing
 * to D1. Each assertion names the input that would make it FAIL.
 *
 *   node tests/tour.mjs
 *   node tests/tour.mjs --site http://127.0.0.1:8795
 */

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequestPost } from '../functions/api/tour.js';

const args = process.argv.slice(2);
const siteFlag = args.indexOf('--site');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');

/** Desktop and the phone width the spec names. */
const WIDTHS = [1280, 390];

/** Selectors the tour itself uses, in step order. Must already exist in the product. */
const STEP_SELECTORS = [
  '#rows-ft .row',
  '.chips',
  '#rows-ft .row .did',
  '#site-search-input',
  'nav.tabs a[href="/portfolio/"]'
];

const fails = [];

/**
 * @param {boolean} pass
 * @param {string} what
 * @param {string} [detail]
 * @returns {void}
 */
function ok(pass, what, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${what.padEnd(64)} ${detail}`);
  if (!pass) fails.push(what);
}

/**
 * MIME type for a static path.
 * @param {string} file
 * @returns {string}
 */
function mime(file) {
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.png')) return 'image/png';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

/**
 * Resolve a URL path onto the worktree the way the deploy flatten does.
 * @param {string} urlPath
 * @returns {string|null}
 */
function fileFor(urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const trimmed = rel.replace(/^\/+/, '');
  const candidates = [
    path.join(WEB, trimmed),
    path.join(ROOT, trimmed)
  ];
  for (const full of candidates) {
    const resolved = path.resolve(full);
    const allowed = [ROOT, WEB].some((base) => {
      const root = path.resolve(base).toLowerCase();
      return resolved.toLowerCase().startsWith(root + path.sep) || resolved.toLowerCase() === root;
    });
    if (!allowed) continue;
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
    const asIndex = path.join(resolved, 'index.html');
    if (fs.existsSync(asIndex) && fs.statSync(asIndex).isFile()) return asIndex;
  }
  return null;
}

/**
 * Serve this worktree with /shared mapped to web/shared.
 * @returns {Promise<{url: string, close: () => Promise<void>}>}
 */
function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const file = fileFor(req.url || '/');
      if (!file) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': mime(file) });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('server did not bind'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((done, fail) => server.close((err) => err ? fail(err) : done()))
      });
    });
  });
}

/**
 * Job rows that survive onTheList and still show a tick.
 * @param {number} n
 * @returns {object[]}
 */
function mockJobs(n) {
  const jobs = [];
  for (let i = 0; i < n; i++) {
    jobs.push({
      dedupe_key: `tour-job-${i}`,
      company: i === 0 ? 'PeopleGrove' : `Company ${i}`,
      title: i === 0 ? 'Senior Product Manager' : `Product Manager ${i}`,
      url: `https://jobs.lever.co/example/${i}`,
      match_pct: 80 - i,
      source: 'lever',
      status: 'queued',
      lane: 'ft',
      submitted_at: null,
      work_type: 'Remote · United States',
      salary_min: 180000,
      salary_max: 220000,
      blocked_reason: null
    });
  }
  return jobs;
}

/**
 * @param {import('playwright').Page} page
 * @param {{tourSeenAt: string|null, seenPosts: string[]}} opts
 * @returns {Promise<void>}
 */
async function mockApis(page, opts) {
  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        email: 'tour.user@example.invalid',
        name: 'Tour User',
        avatar: null,
        since: '2026-01-01T00:00:00.000Z',
        tour_seen_at: opts.tourSeenAt
      })
    });
  });
  await page.route('**/api/jobs**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobs: mockJobs(24) })
    });
  });
  await page.route('**/api/tour/seen', async (route) => {
    opts.seenPosts.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true })
    });
  });
}

/**
 * Rectangles of the cutout and the popover, from the live layout.
 * @param {import('playwright').Page} page
 * @returns {Promise<{cut: object, pop: object, view: object}|null>}
 */
async function tourBoxes(page) {
  return page.evaluate(() => {
    const cutEl = document.getElementById('tour-cutout');
    const popEl = document.getElementById('tour-popover');
    if (!cutEl || !popEl) return null;
    const cut = cutEl.getBoundingClientRect();
    const pop = popEl.getBoundingClientRect();
    return {
      cut: { top: cut.top, left: cut.left, right: cut.right, bottom: cut.bottom, width: cut.width, height: cut.height },
      pop: { top: pop.top, left: pop.left, right: pop.right, bottom: pop.bottom, width: pop.width, height: pop.height },
      view: { w: window.innerWidth, h: window.innerHeight }
    };
  });
}

/**
 * Whether two viewport rects overlap. Touching edges do not count.
 * Would FAIL if the popover sat on top of the cutout (the mockup's step-2 bug).
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
function overlap(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/**
 * Run the visual/keyboard checks at one width.
 * @param {import('playwright').Browser} browser
 * @param {string} site
 * @param {number} width
 * @returns {Promise<void>}
 */
async function runViewport(browser, site, width) {
  const height = width === 390 ? 844 : 900;
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: 'light' });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errs.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));

  const seenPosts = [];
  await mockApis(page, { tourSeenAt: null, seenPosts });
  await page.goto(site + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#rows-ft .row', { timeout: 25000 });
  await page.waitForSelector('#tour-popover[data-ready="1"]', { timeout: 15000 });
  ok(await page.getByRole('dialog', { name: 'Your ranked list' }).isVisible(),
    `${width}: the tour opens for an account that has not seen it`);
  /* FAIL input: tour_seen_at set. Checked in runAlreadySeen. */

  for (let i = 0; i < STEP_SELECTORS.length; i++) {
    await page.waitForSelector(`#tour-popover[data-ready="1"][data-step="${i}"]`, { timeout: 10000 });
    const sel = STEP_SELECTORS[i];
    await page.waitForSelector(sel, { timeout: 10000 });
    const targetInView = await page.evaluate((selector) => {
      const node = document.querySelector(selector);
      if (!node) return false;
      const r = node.getBoundingClientRect();
      return r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
    }, sel);
    ok(targetInView, `${width}: step ${i + 1} target is inside the viewport`, sel);
    /* FAIL input: skip scrollIntoView and start the tour while scrolled to the
       bottom — the first row would sit above the fold. Checked after this loop
       by restarting from the menu after a scroll. */

    const boxes = await tourBoxes(page);
    ok(!!boxes, `${width}: step ${i + 1} has cutout and popover`);
    if (boxes) {
      ok(!overlap(boxes.cut, boxes.pop),
        `${width}: step ${i + 1} popover does not overlap the cutout`,
        `cut ${Math.round(boxes.cut.top)},${Math.round(boxes.cut.left)} pop ${Math.round(boxes.pop.top)},${Math.round(boxes.pop.left)}`);
      /* FAIL input: place the popover at the cutout's top/left. */
      const inScreen = boxes.pop.left >= -1 && boxes.pop.top >= -1
        && boxes.pop.right <= boxes.view.w + 1 && boxes.pop.bottom <= boxes.view.h + 1;
      ok(inScreen, `${width}: step ${i + 1} popover stays inside the viewport`,
        `pop bottom ${Math.round(boxes.pop.bottom)} vs ${boxes.view.h}`);
      /* FAIL input: no max-height, a tall popover on a 390-tall phone. */
    }

    if (i === 0) {
      await page.locator('#tour-next').focus();
      await page.keyboard.press('Tab');
      const trapped = await page.evaluate(() => {
        const pop = document.getElementById('tour-popover');
        return !!(pop && pop.contains(document.activeElement));
      });
      ok(trapped, `${width}: Tab keeps focus inside the popover`);
      /* FAIL input: no trap — Tab from Next leaves the dialog. */
    }

    if (i < STEP_SELECTORS.length - 1) {
      await page.getByRole('button', { name: 'Next' }).click();
    }
  }

  /* Scroll the list away, then restart from the menu. If scrollIntoView is a
     no-op, step 1's row is off-screen and the in-view check fails. */
  await page.getByRole('button', { name: 'Done' }).click();
  await page.locator('#tour-root').waitFor({ state: 'hidden', timeout: 10000 });
  ok(seenPosts.length >= 1, `${width}: finishing the last step marks it seen`, String(seenPosts.length));
  /* FAIL input: mark seen on open — then this would already be 1 before Done. */

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForFunction(() => window.scrollY > 100);
  await page.locator('.chip-btn').click();
  await page.getByRole('link', { name: 'Take the tour' }).click();
  await page.waitForSelector('#tour-popover[data-ready="1"][data-step="0"]', { timeout: 10000 });
  const afterScroll = await page.evaluate(() => {
    const node = document.querySelector('#rows-ft .row');
    if (!node) return false;
    const r = node.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight;
  });
  ok(afterScroll, `${width}: restarting after a scroll brings the first target into view`);

  const postsBeforeEscape = seenPosts.length;
  await page.keyboard.press('Escape');
  await page.locator('#tour-root').waitFor({ state: 'hidden', timeout: 10000 });
  const focusBack = await page.evaluate(() => {
    const el = document.activeElement;
    return !!(el && el !== document.body && (el.classList.contains('chip-btn') || el.closest('header.site')));
  });
  ok(focusBack, `${width}: Escape closes it and focus returns`);
  /* FAIL input: close without restoreFocus — activeElement is body. */
  ok(seenPosts.length === postsBeforeEscape,
    `${width}: a menu restart does not re-mark seen`,
    String(seenPosts.length));
  /* FAIL input: persist defaults to true on every startTour. */

  ok(errs.length === 0, `${width}: console clean`, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

/**
 * The tour must stay closed when tour_seen_at is already set.
 * FAIL input: startTour whenever the account is signed in.
 * @param {import('playwright').Browser} browser
 * @param {string} site
 * @returns {Promise<void>}
 */
async function runAlreadySeen(browser, site) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
  const page = await ctx.newPage();
  await mockApis(page, { tourSeenAt: '2026-04-01T00:00:00.000Z', seenPosts: [] });
  await page.goto(site + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#rows-ft .row', { timeout: 25000 });
  const appeared = await page.locator('#tour-popover').waitFor({ state: 'visible', timeout: 2500 })
    .then(() => true)
    .catch(() => false);
  ok(!appeared, 'already-seen account does not auto-open the tour');
  await ctx.close();
}

/**
 * A D1 stand-in that records the UPDATE and answers the session lookup.
 * @param {{id: string, email: string}|null} user
 * @param {Array<{sql: string, params: unknown[]}>} runs
 * @returns {{prepare: Function}}
 */
function fakeDb(user, runs) {
  return {
    prepare(sql) {
      const stmt = {
        sql,
        params: [],
        bind(...params) { stmt.params = params; return stmt; },
        async first() {
          if (/FROM sessions/i.test(sql)) {
            if (!user) return null;
            return {
              id: 'hashed',
              user_id: user.id,
              created_at: '2026-01-01T00:00:00.000Z',
              expires_at: '2099-01-01T00:00:00.000Z',
              revoked_at: null,
              email: user.email
            };
          }
          return null;
        },
        async run() {
          runs.push({ sql: stmt.sql, params: stmt.params });
          return { success: true };
        }
      };
      return stmt;
    }
  };
}

/**
 * Direct handler checks. These FAIL if origin/session/bind are skipped.
 * @returns {Promise<void>}
 */
async function runApi() {
  const origin = 'http://tour.test';
  const user = { id: 'user-uuid-1', email: 'tour.user@example.invalid' };

  const noOrigin = await onRequestPost({
    request: new Request('http://tour.test/api/tour/seen', { method: 'POST' }),
    env: { DB: fakeDb(user, []), SITE_ORIGIN: origin }
  });
  ok(noOrigin.status === 403, 'POST /api/tour/seen without Origin is 403', String(noOrigin.status));

  const badOrigin = await onRequestPost({
    request: new Request('http://tour.test/api/tour/seen', {
      method: 'POST',
      headers: { origin: 'https://evil.example' }
    }),
    env: { DB: fakeDb(user, []), SITE_ORIGIN: origin }
  });
  ok(badOrigin.status === 403, 'POST /api/tour/seen with a mismatched Origin is 403', String(badOrigin.status));

  const noSession = await onRequestPost({
    request: new Request('http://tour.test/api/tour/seen', {
      method: 'POST',
      headers: { origin }
    }),
    env: { DB: fakeDb(user, []), SITE_ORIGIN: origin }
  });
  ok(noSession.status === 401, 'POST /api/tour/seen without a session is 401', String(noSession.status));

  const runs = [];
  const okRes = await onRequestPost({
    request: new Request('http://tour.test/api/tour/seen', {
      method: 'POST',
      headers: { origin, cookie: '__Host-session=tok' }
    }),
    env: { DB: fakeDb(user, runs), SITE_ORIGIN: origin }
  });
  ok(okRes.status === 200, 'POST /api/tour/seen with a session is 200', String(okRes.status));
  const write = runs.find((r) => /UPDATE profile/i.test(r.sql));
  ok(!!write, 'it writes tour_seen_at on the profile row');
  ok(write && !write.sql.includes(user.id),
    'the user id is a bound parameter, not concatenated',
    write ? write.sql : 'no write');
  ok(write && write.params.includes(user.id),
    'the bound parameter list contains the caller id');
  ok(write && /\?2/.test(write.sql) && /COALESCE/.test(write.sql),
    'the write is idempotent (COALESCE on tour_seen_at)');

  const again = await onRequestPost({
    request: new Request('http://tour.test/api/tour/seen', {
      method: 'POST',
      headers: { origin, cookie: '__Host-session=tok' }
    }),
    env: { DB: fakeDb(user, []), SITE_ORIGIN: origin }
  });
  ok(again.status === 200, 'calling it twice is not an error', String(again.status));
}

let local = null;
const SITE = siteFlag >= 0 ? args[siteFlag + 1] : null;
if (!SITE) local = await startServer();
const site = SITE || local.url;
const browser = await chromium.launch();

try {
  await runApi();
  await runAlreadySeen(browser, site);
  for (const width of WIDTHS) {
    await runViewport(browser, site, width);
  }
} finally {
  await browser.close();
  if (local) await local.close();
}

console.log(fails.length ? `\n${fails.length} FAILED` : '\nthe tour opens, advances, and stays off the cutout');
process.exit(fails.length ? 1 : 0);
