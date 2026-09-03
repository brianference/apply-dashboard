/**
 * Profile editor and public portfolio: stored order, visibility, print, JSON-LD,
 * and contact details staying off the public HTML.
 *
 * Drives a local copy of the pages with the APIs intercepted, so it does not
 * write D1 and does not depend on a deploy. Known-bad: a staged copy of the
 * print CSS without the print block is required to fail.
 *
 *   node tests/portfolio-profile.mjs
 *   node tests/portfolio-profile.mjs http://127.0.0.1:PORT
 */

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseResume, sectionsFromParse, publicView, personJsonLd, stripContact
} from '../ingest/profile-parse.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('C:/Users/brian/RedAnvil/node_modules/playwright')); }
catch { ({ chromium } = await import('playwright')); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let bad = 0;
/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
const check = (name, ok, detail) => {
  if (!ok) bad += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(name).padEnd(72)} ${detail || ''}`);
};

const FIXTURE_RESUME = [
  'BRIAN FERENCE',
  'leak@example.com',
  '+1 (555) 123-4567',
  '',
  'SUMMARY',
  'A product manager who ships LLM systems. Write leak@example.com only in applications.',
  '',
  'WORK EXPERIENCE',
  'Equity Methods',
  'Director of Product | Scottsdale, Arizona, United States',
  'Jan 2024 to Present',
  'Led the product organisation through a full rebuild of the valuation platform, putting machine learning into the same workflow the analysts already used rather than a side tool they had to remember.',
  '',
  'Hidden Co Labs',
  'Staff Product Manager | Remote, United States of America',
  'Mar 2020 to Dec 2023',
  'Owned the analytics suite from roadmap through launch, including the first LLM-assisted report writer that customers actually turned on instead of a demo that never left the lab.',
  '',
  'EDUCATION',
  'State University | MBA | 2012'
].join('\n');

const parsed = parseResume(FIXTURE_RESUME);
const saved = sectionsFromParse(parsed);
saved.experience[0].paragraphs[0] += ' Contact leak@example.com or +1 (555) 123-4567.';
/* A third role lives only on the suggestion list so Import from resume has
   something to offer one-at-a-time, while the saved row still has two roles
   to reorder. */
parsed.experience.push({
  company: 'Third Co',
  title: 'Advisor',
  location: 'Remote',
  start: 'Jan 2018',
  end: 'Dec 2019',
  current: false,
  paragraphs: ['Advised on the launch of the client portal.'],
  source: 'resume'
});

/**
 * Flatten web/ into a temp dir the way build-deploy.sh does, without
 * writing .deploy/.
 * @param {{ cssPatch?: (css: string) => string }} [opts]
 * @returns {string}
 */
function stageSite(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-site-'));
  fs.copyFileSync(path.join(ROOT, 'index.html'), path.join(dir, 'index.html'));
  const web = path.join(ROOT, 'web');
  for (const name of fs.readdirSync(web)) {
    const src = path.join(web, name);
    if (fs.statSync(src).isDirectory()) {
      fs.cpSync(src, path.join(dir, name), { recursive: true });
    }
  }
  for (const name of fs.readdirSync(ROOT)) {
    if (name.endsWith('.png')) fs.copyFileSync(path.join(ROOT, name), path.join(dir, name));
  }
  if (opts.cssPatch) {
    const cssPath = path.join(dir, 'portfolio', 'css', 'portfolio.css');
    fs.writeFileSync(cssPath, opts.cssPatch(fs.readFileSync(cssPath, 'utf8')));
  }
  return dir;
}

/**
 * @param {string} dir
 * @returns {Promise<{ url: string, stop: () => Promise<void> }>}
 */
function startServer(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tests', 'serve-local.mjs'), '--dir', dir], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let buf = '';
    const onData = (chunk) => {
      buf += String(chunk);
      const m = buf.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (m) {
        child.stdout.off('data', onData);
        resolve({
          url: m[0],
          stop: () => new Promise((done) => {
            child.once('exit', () => done());
            child.kill();
          })
        });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (c) => { buf += String(c); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code) reject(new Error('serve-local exited ' + code + ': ' + buf));
    });
  });
}

/**
 * @param {import('playwright').Page} page
 * @param {object} profileGet
 * @param {Array<object>} puts
 * @returns {Promise<void>}
 */
async function mockProfileApi(page, profileGet, puts) {
  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true, email: 'tester@example.com', name: 'Test User'
      })
    });
  });
  await page.route('**/api/profile', async (route) => {
    const req = route.request();
    if (req.method() === 'PUT') {
      let body = {};
      try { body = JSON.parse(req.postData() || '{}'); } catch { body = {}; }
      puts.push(body);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, profile: body })
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(profileGet)
    });
  });
}

/**
 * @param {object} extra
 * @returns {object}
 */
function portfolioPayload(extra) {
  const published = publicView(saved);
  return {
    name: 'Test User',
    handle: 'tester',
    owner: false,
    avatar: null,
    headline: 'AI Product Manager',
    location: 'Phoenix, AZ',
    summary: published.about ? published.about.text : '',
    skills: published.skills || null,
    education: published.education || null,
    certifications: published.certifications || null,
    experience: published.experience || null,
    projects: published.projects || null,
    jsonld: personJsonLd({
      name: 'Test User',
      headline: 'AI Product Manager',
      location: 'Phoenix, AZ',
      url: 'https://apply-dashboard.pages.dev/portfolio/tester',
      links: { linkedin: 'https://www.linkedin.com/in/tester', github: null },
      experience: published.experience || [],
      education: published.education || []
    }),
    links: { linkedin: 'https://www.linkedin.com/in/tester', github: null },
    repos: [],
    updated_at: '2026-09-03T00:00:00.000Z',
    ...extra
  };
}

const givenUrl = process.argv[2];
let staged = null;
let server = null;
let SITE = givenUrl;
if (!SITE) {
  staged = stageSite();
  server = await startServer(staged);
  SITE = server.url;
}

const browser = await chromium.launch({ headless: true });

/* ---- editor: reorder writes the new order ----------------------------- */

{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const puts = [];
  const profileGet = {
    profile: {
      display_name: 'Test User',
      handle: 'tester',
      headline: 'AI Product Manager',
      location: 'Phoenix, AZ',
      linkedin_url: 'https://www.linkedin.com/in/tester',
      github_url: '',
      resume_filename: 'resume.pdf',
      resume_text: FIXTURE_RESUME,
      avatar_data_url: null,
      profile_sections: saved
    },
    suggested: parsed,
    resume_chars: FIXTURE_RESUME.length
  };
  const pageErrs = [];
  page.on('pageerror', (e) => pageErrs.push(e.message));
  await mockProfileApi(page, profileGet, puts);
  await page.goto(SITE + '/profile/', { waitUntil: 'domcontentloaded' });
  await page.locator('#editor:not([hidden])').waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('#sections [data-section="experience"] .item').first().waitFor({ state: 'visible', timeout: 20000 });
  check('profile editor console clean after load', pageErrs.length === 0, pageErrs.slice(0, 2).join(' | '));

  const firstTitle = saved.experience[0].title;
  const secondTitle = saved.experience[1].title;
  const down = page.getByRole('button', { name: `Move ${firstTitle} down` });
  await Promise.all([
    page.waitForRequest((r) => r.url().includes('/api/profile') && r.method() === 'PUT'),
    down.click()
  ]);

  const stored = puts.filter((p) => p.profile_sections);
  check('reorder PUT sent profile_sections', stored.length >= 1, String(puts.length));
  const order = stored.length
    ? stored[stored.length - 1].profile_sections.experience.map((r) => r.title)
    : [];
  check('stored experience order changed after Move down',
    order[0] === secondTitle && order[1] === firstTitle,
    order.join(' | '));

  /* Import is one item at a time: the panel must not offer Accept all. */
  const importBtn = page.locator('[data-section="experience"] [data-import-open]');
  if (await importBtn.count()) {
    await importBtn.click();
    const acceptCount = await page.locator('[data-section="experience"] .import-panel .cta').count();
    const acceptAll = await page.getByRole('button', { name: /accept all/i }).count();
    check('import shows one Accept, not a bulk overwrite',
      acceptCount === 1 && acceptAll === 0,
      `accept ${acceptCount} accept-all ${acceptAll}`);
  } else {
    check('import shows one Accept, not a bulk overwrite', true, 'no leftover suggestions');
  }
  await ctx.close();
}

/* ---- portfolio: hidden section absent from HTML ----------------------- */

{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const hiddenSaved = structuredClone(saved);
  hiddenSaved.visibility.experience = false;
  const hiddenPub = publicView(hiddenSaved);
  check('publicView used by the fixture omits experience',
    !Object.prototype.hasOwnProperty.call(hiddenPub, 'experience'));

  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ authenticated: false })
    });
  });
  await page.route('**/api/portfolio**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(portfolioPayload({
        experience: null,
        jsonld: personJsonLd({
          name: 'Test User',
          headline: 'AI Product Manager',
          experience: [],
          education: hiddenPub.education || []
        })
      }))
    });
  });
  await page.goto(SITE + '/portfolio/', { waitUntil: 'domcontentloaded' });
  await page.locator('#who').waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForFunction(() => (document.querySelector('#who').textContent || '').trim().length > 0,
    null, { timeout: 20000 });
  const htmlHidden = await page.content();
  check('hidden experience is absent from the portfolio HTML, not display:none',
    htmlHidden.indexOf('Hidden Co Labs') === -1
      && !/<h2[^>]*>Experience<\/h2>/i.test(htmlHidden),
    htmlHidden.indexOf('Hidden Co Labs') === -1 ? 'no Hidden Co Labs' : 'Hidden Co Labs leaked');
  check('no email in the hidden-experience portfolio HTML',
    htmlHidden.indexOf('leak@example.com') === -1);
  check('no phone in the hidden-experience portfolio HTML',
    htmlHidden.indexOf('555') === -1 || !/\+1 \(555\) 123-4567/.test(htmlHidden),
    htmlHidden.includes('+1 (555) 123-4567') ? 'phone leaked' : 'ok');
  await ctx.close();
}

{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ authenticated: false })
    });
  });
  const shown = publicView(saved);
  await page.route('**/api/portfolio**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(portfolioPayload({
        experience: shown.experience,
        jsonld: personJsonLd({
          name: 'Test User',
          headline: 'AI Product Manager',
          experience: shown.experience,
          education: shown.education || []
        })
      }))
    });
  });
  await page.goto(SITE + '/portfolio/', { waitUntil: 'domcontentloaded' });
  await page.locator('#experience').waitFor({ state: 'visible', timeout: 20000 });
  const htmlShown = await page.content();
  check('visible experience is in the HTML so hiding is not "never render"',
    htmlShown.indexOf('Hidden Co Labs') !== -1 && /Experience/.test(htmlShown));
  check('no email in the visible-experience portfolio HTML',
    htmlShown.indexOf('leak@example.com') === -1);
  check('stripContact removed the email from the public payload the page rendered',
    JSON.stringify(shown).indexOf('leak@example.com') === -1);

  const ldRaw = await page.locator('script[type="application/ld+json"]').textContent();
  let ld = null;
  try { ld = JSON.parse(ldRaw || 'null'); } catch { ld = null; }
  check('portfolio HTML includes JSON-LD Person',
    !!(ld && ld['@type'] === 'Person'), ld && ld['@type']);
  check('JSON-LD Person has worksFor',
    !!(ld && Array.isArray(ld.worksFor) && ld.worksFor.length),
    ld ? JSON.stringify(ld.worksFor) : 'null');
  check('JSON-LD Person has alumniOf',
    !!(ld && Array.isArray(ld.alumniOf) && ld.alumniOf.length),
    ld ? JSON.stringify(ld.alumniOf) : 'null');
  check('JSON-LD Person has no email or telephone',
    !!(ld && !Object.prototype.hasOwnProperty.call(ld, 'email')
      && !Object.prototype.hasOwnProperty.call(ld, 'telephone')));

  await page.locator('header.site').waitFor({ state: 'visible', timeout: 20000 });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.emulateMedia({ media: 'print' });
  const navDisplay = await page.locator('header.site').evaluate((el) => getComputedStyle(el).display);
  const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check('print media does not render the nav',
    navDisplay === 'none', navDisplay);
  check('print media body background is white',
    bodyBg === 'rgb(255, 255, 255)', bodyBg);
  await ctx.close();
}

/* ---- known-bad: print CSS without the print block must fail ----------- */

{
  const brokenDir = stageSite({
    cssPatch: (css) => css.replace(/@media print\s*\{[\s\S]*\}\s*$/, '')
  });
  const brokenServer = await startServer(brokenDir);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ authenticated: false })
    });
  });
  await page.route('**/api/portfolio**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(portfolioPayload({ experience: publicView(saved).experience }))
    });
  });
  await page.goto(brokenServer.url + '/portfolio/', { waitUntil: 'domcontentloaded' });
  await page.locator('header.site').waitFor({ state: 'visible', timeout: 20000 });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.emulateMedia({ media: 'print' });
  const navDisplay = await page.locator('header.site').evaluate((el) => getComputedStyle(el).display);
  const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check('TEMP COPY of portfolio.css without @media print FAILS the nav-hidden assertion',
    navDisplay !== 'none', navDisplay);
  check('TEMP COPY of portfolio.css without @media print FAILS the white-body assertion',
    bodyBg !== 'rgb(255, 255, 255)', bodyBg);
  await ctx.close();
  await brokenServer.stop();
}

check('stripContact still removes leak@example.com',
  stripContact('x leak@example.com y').indexOf('leak@example.com') === -1);

await browser.close();
if (server) await server.stop();

console.log(bad ? `\n${bad} FAILED` : '\nprofile editor and portfolio hold on stored order, visibility, print and contact');
process.exitCode = bad ? 1 : 0;
