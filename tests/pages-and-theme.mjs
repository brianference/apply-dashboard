/**
 * The legal pages have real content, every page carries the footer, and the
 * theme is light by default and dark on the toggle.
 *
 * Three FEATURES.md gaps in one file, all of them page-level facts that were
 * checked once by hand and then trusted.
 *
 * The legal pages are the reason this is worth automating. A set of legal
 * pages specced as "real content, no boilerplate" once shipped at 81 words,
 * because the requirement was written into a prompt and the rendered page was
 * never opened. These pages render CLIENT-SIDE, so a word count taken over the
 * raw HTML reads about five words and would happily pass a page that renders
 * nothing at all. Every count here is taken from innerText in a real browser.
 *
 * The theme is measured on painted colour, not on the attribute. Flipping
 * data-theme and asserting that data-theme flipped proves nothing about what a
 * person sees.
 *
 * Run: node tests/pages-and-theme.mjs [url]
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('C:/Users/brian/RedAnvil/node_modules/playwright')); }
catch { ({ chromium } = await import('playwright')); }

const SITE = process.argv[2] || 'https://apply-dashboard.pages.dev';

let bad = 0;
const check = (name, ok, detail) => {
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(name).padEnd(64)} ${detail || ''}`);
};

/**
 * Perceived brightness of an rgb() string, 0 to 255.
 *
 * @param {string} css
 * @returns {number|null}
 */
function luminance(css) {
  const m = String(css).match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const [r, g, b] = m[1].split(',').map((n) => Number(n.trim()));
  if ([r, g, b].some((n) => !Number.isFinite(n))) return null;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

/* ---------------------------------------------------- the four legal pages -- */

/* A floor per page rather than one number for all four: contact is naturally
   shorter than privacy, and a single floor low enough for contact would let
   privacy rot down to a stub. Each floor sits below what the page renders
   today, so this catches a page emptying out, not ordinary editing. */
const LEGAL = [
  { slug: 'about', heading: /about/i, minWords: 300, minSections: 5 },
  { slug: 'terms', heading: /terms/i, minWords: 400, minSections: 8 },
  { slug: 'privacy', heading: /privacy/i, minWords: 600, minSections: 10 },
  { slug: 'contact', heading: /contact/i, minWords: 200, minSections: 6 }
];

/* Phrases that mean the page was never written. */
const BOILERPLATE = /lorem ipsum|placeholder|coming soon|todo|tbd|your company name|\[insert/i;

for (const spec of LEGAL) {
  const url = `${SITE}/legal/${spec.slug}/`;
  const res = await page.goto(url, { waitUntil: 'networkidle' });
  check(`/legal/${spec.slug}/ answers 200`, res && res.status() === 200, res && String(res.status()));

  const seen = await page.evaluate(() => ({
    words: (document.body.innerText || '').trim().split(/\s+/).filter(Boolean).length,
    sections: document.querySelectorAll('h2').length,
    h1: (document.querySelector('h1') || {}).textContent || '',
    text: (document.body.innerText || '').slice(0, 20000)
  }));

  check(`${spec.slug} has its own heading`, spec.heading.test(seen.h1), seen.h1.trim());
  check(`${spec.slug} renders real content, not a stub`,
    seen.words >= spec.minWords, `${seen.words} words, floor ${spec.minWords}`);
  check(`${spec.slug} keeps its sections`,
    seen.sections >= spec.minSections, `${seen.sections} sections, floor ${spec.minSections}`);
  check(`${spec.slug} has no boilerplate left in it`,
    !BOILERPLATE.test(seen.text), (seen.text.match(BOILERPLATE) || [''])[0]);
}

/* --------------------------------------------------- the footer everywhere -- */

/* The footer is built by the shared header script rather than pasted into each
   page, so the thing worth checking is that every page RUNS it. */
const PAGES = ['/', '/legal/about/', '/legal/terms/', '/legal/privacy/', '/legal/contact/', '/login/'];
for (const path of PAGES) {
  await page.goto(SITE + path, { waitUntil: 'networkidle' });
  const foot = await page.evaluate(() => {
    const f = document.querySelector('footer.site-foot');
    if (!f) return null;
    return { links: f.querySelectorAll('a').length, visible: f.getBoundingClientRect().height > 0 };
  });
  check(`footer on ${path}`, foot != null && foot.links > 0 && foot.visible,
    foot ? `${foot.links} links` : 'no footer element');
}

/* ------------------------------------------------------------- the theme -- */

/* A fresh context, so nothing a previous page stored decides the answer. */
const themeCtx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
const themePage = await themeCtx.newPage();
await themePage.goto(SITE, { waitUntil: 'domcontentloaded' });
await themePage.locator('.row').first().waitFor({ state: 'visible', timeout: 25000 });

const painted = () => themePage.evaluate(() => ({
  attr: document.documentElement.getAttribute('data-theme'),
  bg: getComputedStyle(document.body).backgroundColor,
  fg: getComputedStyle(document.body).color
}));

/* Light is the default WHATEVER the operating system asks for, which is why
   this context emulates a dark OS. */
const first = await painted();
const lightBg = luminance(first.bg);
check('the page is light on a first visit even with the OS set to dark',
  lightBg != null && lightBg > 160, `${first.bg} (luminance ${lightBg && lightBg.toFixed(0)})`);
check('and its text is dark enough to read against that',
  luminance(first.fg) != null && luminance(first.fg) < 120, first.fg);

const toggle = themePage.locator('header.site button.theme').first();
check('the theme control is a button in the header', await toggle.count() > 0);

await toggle.click();
await themePage.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark', null, { timeout: 5000 });
const dark = await painted();
const darkBg = luminance(dark.bg);
/* PAINT, not the attribute. An attribute flip with no stylesheet behind it is
   exactly the failure a data-theme assertion cannot see. */
check('the toggle actually darkens what is painted',
  darkBg != null && darkBg < 80, `${dark.bg} (luminance ${darkBg && darkBg.toFixed(0)})`);
check('and the two themes are far apart rather than a slight tint',
  lightBg != null && darkBg != null && lightBg - darkBg > 100,
  `light ${lightBg && lightBg.toFixed(0)} vs dark ${darkBg && darkBg.toFixed(0)}`);
check('text stays legible in dark, so the toggle did not invert only the background',
  luminance(dark.fg) != null && luminance(dark.fg) > 140, dark.fg);

/* The choice has to survive a reload or the toggle is decoration. */
await themePage.reload({ waitUntil: 'domcontentloaded' });
await themePage.locator('.row').first().waitFor({ state: 'visible', timeout: 25000 });
const afterReload = await painted();
check('the choice survives a reload',
  afterReload.attr === 'dark' && luminance(afterReload.bg) < 80,
  `${afterReload.attr} ${afterReload.bg}`);

await toggle.click();
await themePage.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'light', null, { timeout: 5000 });
const backToLight = await painted();
check('and the toggle goes back the other way',
  luminance(backToLight.bg) > 160, backToLight.bg);

check('no console error on any page', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close();
console.log(bad
  ? `\n${bad} FAILED`
  : '\nthe legal pages carry real rendered content, every page has the footer, and the theme paints both ways');
process.exitCode = bad ? 1 : 0;
