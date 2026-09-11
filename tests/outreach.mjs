/**
 * The outreach page: the right postings, four real searches each, no invented
 * people.
 *
 * Brian, 2026-09-11: a separate page with links to hiring managers I can
 * message for top rated new jobs.
 *
 * The failure this page had to avoid is the one it would be easiest to build:
 * printing a name. Nothing in the database knows who the hiring manager is, so
 * a name on this page would be fabricated research, which is worse than no
 * page. Every link is a SEARCH, and the cases below hold that.
 *
 * Run: node tests/outreach.mjs [url]
 */

import { createRequire } from 'node:module';
/* Brian's machine keeps Playwright in RedAnvil; a CI runner installs its own.
   Try the local copy, fall back to a normal resolution, so the same file runs
   in both places. */
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('C:/Users/brian/RedAnvil/node_modules/playwright')); }
catch { ({ chromium } = await import('playwright')); }

const SITE = process.argv[2] || 'https://apply-dashboard.pages.dev';

let bad = 0;
const check = (name, ok, detail) => {
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(name).padEnd(66)} ${detail || ''}`);
};

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`${SITE}/outreach/`, { waitUntil: 'domcontentloaded' });
/* A real ready signal: a card, or the empty state. Never a sleep. */
await page.locator('.target, .empty').first().waitFor({ state: 'visible', timeout: 25000 });

const cards = await page.locator('.target').count();
check('the page renders postings to work through', cards > 0, `${cards} cards`);

/* ------------------------------------------------------- no invented people -- */

/* Every outbound link is a linkedin SEARCH or the posting itself. A
   /in/<person> URL would mean a name had been printed. */
const hrefs = await page.locator('.target a').evaluateAll((els) =>
  els.map((a) => a.getAttribute('href') || ''));
const profiles = hrefs.filter((h) => /linkedin\.com\/in\//i.test(h));
check('no link points at an individual LinkedIn profile',
  profiles.length === 0, profiles.slice(0, 2).join(' | ') || `${hrefs.length} links checked`);

const searches = hrefs.filter((h) => /linkedin\.com\/search\/results\//i.test(h));
check('every card contributes linkedin searches',
  searches.length >= cards * 4, `${searches.length} searches for ${cards} cards`);

/* A search with no company in it would return the whole of LinkedIn. */
const unscoped = searches.filter((h) => !/keywords=%22/.test(h));
check('every search is scoped to a quoted employer name',
  unscoped.length === 0, unscoped.slice(0, 2).join(' | ') || 'all scoped');

/* The method is ordered, so the page has to present it in order. */
const firstSteps = await page.locator('.target').first().locator('.steps .step').allTextContents();
check('the four steps appear in the method\'s order',
  firstSteps.length === 4 && /^1/.test(firstSteps[0].trim()) && /^4/.test(firstSteps[3].trim()),
  firstSteps.map((t) => t.replace(/\s+/g, ' ').trim()).join(' / '));

/* The four rows share one gutter. Sized per row instead, the wider label
   ("Who has posted about the team") pushed its own why-text 73px right of the
   other three, so the method read as four ragged indents. Measured on the
   PAINTED left edge: a stylesheet grep for subgrid would pass a page that
   reintroduced the rag in any other unit. */
const whyLefts = await page.locator('.target').first().locator('.steps .why')
  .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
const spread = Math.max(...whyLefts) - Math.min(...whyLefts);
check('the four why-texts share one left edge',
  whyLefts.length === 4 && spread === 0, `spread ${spread}px of ${whyLefts.join(' ')}`);

/* ------------------------------------------------------------ the postings -- */

const ranks = await page.locator('.target .rank').allTextContents();
const numbers = ranks.map((r) => Number(String(r).replace('%', '')));
check('every card shows a rank',
  numbers.length === cards && numbers.every((n) => Number.isFinite(n)), ranks.slice(0, 3).join(' '));
/* He asked for top rated. Descending is the whole point of the ordering. */
check('cards are ordered by rank, highest first',
  numbers.every((n, i) => i === 0 || numbers[i - 1] >= n),
  `${numbers[0]}% down to ${numbers[numbers.length - 1]}%`);

/* An unpublished band says so. "Competitive" would be inventing one. */
const metas = (await page.locator('.target .meta').allTextContents()).join(' ');
check('a posting with no published band says so rather than guessing',
  !/competitive|negotiable|DOE/i.test(metas), metas.slice(0, 60));

const postings = await page.locator('.target .posting').evaluateAll((els) =>
  els.map((a) => a.getAttribute('href') || ''));
check('every card links to its own posting over http(s)',
  postings.length === cards && postings.every((h) => /^https?:\/\//.test(h)),
  `${postings.length} posting links`);

/* --------------------------------------------------------- the three shapes -- */

const shapes = await page.locator('.target').first().locator('.shapes details summary').allTextContents();
check('all three message shapes are offered',
  shapes.length === 3, shapes.join(' / '));

/* The post's own constraint: a question answerable in one sentence. A template
   without a question is the part most easily lost when it gets personalised. */
const bodies = await page.locator('.target').first().locator('.shapes .msg').allTextContents();
check('every message ends in a question',
  bodies.length === 3 && bodies.every((b) => b.trim().endsWith('?')),
  bodies.map((b) => b.trim().slice(-28)).join(' | '));

check('and each one is copyable',
  await page.locator('.target').first().locator('button.copy').count() === 3);

/* --------------------------------------------------------------- the frame -- */

check('the source post is cited on the page',
  (await page.locator('a[href*="activity:7504051227832451072"]').count()) === 1);
/* The one thing a reader must not misread. */
check('the page states that the links are searches rather than names',
  /search/i.test(await page.locator('.warn').innerText()));

const overflow = await page.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('the page does not scroll sideways', overflow <= 0, `${overflow}px`);

/* Light is the default whatever the OS asks for, as everywhere else here. */
const darkCtx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, colorScheme: 'dark' });
const darkPage = await darkCtx.newPage();
await darkPage.goto(`${SITE}/outreach/`, { waitUntil: 'domcontentloaded' });
const painted = await darkPage.evaluate(() => getComputedStyle(document.body).backgroundColor);
const light = (() => {
  const m = String(painted).match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const [r, g, b] = m[1].split(',').map((n) => Number(n.trim()));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
})();
check('the page is light with the OS set to dark, and paints a real background',
  light != null && light > 160, `${painted} (luminance ${light && light.toFixed(0)})`);
await darkCtx.close();

check('no console error', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close();
console.log(bad
  ? `\n${bad} FAILED`
  : '\nthe page ranks the right postings, scopes every search to an employer, and names nobody');
process.exitCode = bad ? 1 : 0;
