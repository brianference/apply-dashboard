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

const hrefs = await page.locator('.target a').evaluateAll((els) =>
  els.map((a) => a.getAttribute('href') || ''));

/* THE RULE THIS PAGE EXISTS UNDER.
 *
 * A profile link is allowed ONLY when the person published that exact URL
 * somewhere public and it was recorded, with its source, in contacts.json.
 * Anything else means a slug was guessed from a name, and a guessed slug is
 * either a 404 or a stranger's profile presented as the hiring manager.
 *
 * So the test does not ban /in/ links any more, which would have banned the
 * real ones too. It reads the data file and requires every rendered profile
 * link to appear in it verbatim. That is the difference between a link with a
 * provenance and a link that looks the same and has none. */
const dataRes = await fetch(`${SITE}/outreach/data/contacts.json`);
const data = dataRes.ok ? await dataRes.json() : { companies: {} };
const declared = new Set();
for (const co of Object.values(data.companies || {})) {
  for (const person of co.people || []) if (person.profile) declared.add(person.profile);
}
const rendered = hrefs.filter((h) => /linkedin\.com\/in\//i.test(h));
const undeclared = rendered.filter((h) => !declared.has(h));
check('every profile link traces to a recorded source, none is a guessed slug',
  undeclared.length === 0,
  undeclared.slice(0, 2).join(' | ') || `${rendered.length} profile links, all declared`);

/* And a name with no source is indistinguishable from an invented one. */
const unsourced = await page.locator('.people .src.none').count();
const sourced = await page.locator('.people a.src').count();
/* Counting only the unsourced would pass a page rendering no people at all. */
check('every named person carries the source the name was read on',
  sourced > 0 && unsourced === 0, `${sourced} sourced, ${unsourced} without`);

/* Each named person's link must be about THAT person: either the profile URL
   they published, or a search with their own name quoted in it. A link that is
   neither is a link to somebody else under their name. */
/* This selector said `.people li` for one run after the roster turned the people
   into table rows: it matched nothing, reported "0 people checked" and PASSED.
   A filter over an empty list is always empty, so length === 0 means both
   "nothing wrong" and "nothing examined". The non-zero count is what separates
   them. */
const peopleLinks = await page.locator('.people tr[data-person]').evaluateAll((els) => els.map((row) => ({
  name: (row.querySelector('.person')?.textContent || '').trim(),
  href: row.querySelector('.person')?.getAttribute('href') || ''
})));
const mismatched = peopleLinks.filter(({ name, href }) => {
  if (!name) return true;
  const decoded = decodeURIComponent(href);
  if (declared.has(href)) return false;
  return !decoded.includes('"' + name + '"');
});
check('each link is that person\'s published profile or a search for their name',
  peopleLinks.length > 0 && mismatched.length === 0,
  mismatched.slice(0, 2).map((m) => m.name).join(' | ') || peopleLinks.length + ' people checked');

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

/* The reasons live in one expander per card now, not beside all four chips:
   the same four sentences on every card is noise the tenth time. They still
   have to line up, and a collapsed element has no painted box, so the expander
   is opened before measuring. Measured on the PAINTED left edge, because a
   stylesheet grep would pass a layout that went ragged in any other unit.

   The previous version of this check measured `.steps .why`, which the chip
   redesign removed. It reported a spread of -Infinity over an empty list rather
   than failing, which is what a check measuring nothing looks like. Requiring
   exactly four is what turns that into a failure. */
const firstCard = page.locator('.target').first();
await firstCard.locator('.reasons summary').click();
const whyLefts = await firstCard.locator('.reasonlist .why')
  .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
const spread = whyLefts.length ? Math.max(...whyLefts) - Math.min(...whyLefts) : null;
check('all four search reasons share one left edge',
  whyLefts.length === 4 && spread === 0,
  `${whyLefts.length} reasons, spread ${spread}px of ${whyLefts.join(' ')}`);

/* ----------------------------------------------------------- the addresses -- */

/* Read once, used by the checks below and by the evidence check. */
const ledes = await page.locator('.contacts-lede').allTextContents();
const ledesWithConvention = ledes.filter((t) => /not verified/i.test(t));
const silent = ledes.filter((t) => !/not verified|No address convention/i.test(t));
check('each contacts block states whether a convention exists',
  silent.length === 0, silent.slice(0, 1).join('') || `${ledes.length} blocks`);


/* An address on this page is DERIVED from an employer's convention, never
 * looked up. Two things must therefore hold, and the second is the one that
 * would quietly do damage: an address must belong to the employer whose card it
 * is on, and no address may appear at all for an employer whose convention the
 * evidence could not establish. Showing a plausible address for a company
 * nobody measured is the email version of a guessed profile slug. */
const mails = await page.locator('.target').evaluateAll((cards) => cards.map((card) => ({
  company: (card.querySelector('.co')?.textContent || '').trim().split(String.fromCharCode(10))[0].trim(),
  addresses: [...card.querySelectorAll('.people .mail code')].map((c) => c.textContent.trim()),
  labels: [...card.querySelectorAll('.people .mail-why')].map((c) => c.textContent.trim())
})));

/* Map every declared convention by its cleaned employer name. */
const conventions = new Map();
for (const [key, co] of Object.entries(data.companies || {})) {
  const name = key.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  conventions.set(name, co.email || null);
}
const conventionFor = (company) => {
  const want = String(company || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  for (const [name, rule] of conventions) {
    if (name === want || name.startsWith(want) || want.startsWith(name)) return rule;
  }
  return null;
};

const wrongDomain = [];
const noConvention = [];
for (const card of mails) {
  if (!card.addresses.length) continue;
  const rule = conventionFor(card.company);
  if (!rule || !rule.shape) { noConvention.push(`${card.company} (${card.addresses[0]})`); continue; }
  for (const address of card.addresses) {
    if (!address.toLowerCase().endsWith(`@${String(rule.domain).toLowerCase()}`)) {
      wrongDomain.push(`${card.company}: ${address}`);
    }
  }
}
const shown = mails.reduce((n, c) => n + c.addresses.length, 0);
check('no address is shown for an employer whose convention was never established',
  noConvention.length === 0, noConvention.slice(0, 2).join(' | ') || `${shown} addresses shown`);
check('every address sits on the domain its own employer declared',
  wrongDomain.length === 0, wrongDomain.slice(0, 2).join(' | ') || 'all on their own domain');

/* The label is the only thing stopping a derived address reading as a verified
   one, so it has to carry the evidence rather than a reassuring word. */
/* Two checks where there used to be one. The share and the sample size are
   stated once per card, in the lede, because the convention belongs to the
   employer and printing it nine times was 9 identical lines of noise. Each row
   still has to be marked derived, and the full evidence has to be reachable
   without a mouse being required to learn the numbers exist. */
const allLabels = mails.flatMap((c) => c.labels);
const badLabels = allLabels.filter((l) => !/derived/i.test(l));
check('every address is marked derived', badLabels.length === 0,
  badLabels.slice(0, 2).join(' | ') || `${allLabels.length} marked`);

const titles = await page.locator('.people .mail-why').evaluateAll((els) =>
  els.map((e) => e.getAttribute('title') || ''));
const thinTitles = titles.filter((t) => !/derived from \S+, \d+% of \d+/.test(t));
check('and carries the share and sample size in full',
  titles.length > 0 && thinTitles.length === 0,
  thinTitles.slice(0, 1).join('') || `${titles.length} carry the evidence`);

/* The numbers must be VISIBLE somewhere on the card, not only in a title. */
const ledeNumbers = ledesWithConvention.filter((t) => /\d+ of \d+ unique/.test(t));
check('the card states the evidence in words a reader can see',
  ledesWithConvention.length === 0 || ledeNumbers.length === ledesWithConvention.length,
  `${ledeNumbers.length} of ${ledesWithConvention.length} conventions state their counts`);

/* And an employer with no convention must SAY so rather than stay silent, or a
   reader cannot tell "no evidence" from "not looked at". */

/* ------------------------------------------------------------ the postings -- */

const ranks = await page.locator('.target .rank').allTextContents();
const numbers = ranks.map((r) => Number(String(r).replace('%', '')));
check('every card shows a rank',
  numbers.length === cards && numbers.every((n) => Number.isFinite(n)), ranks.slice(0, 3).join(' '));

/* Ordering is per GROUP now, not across the page: three groups each sorted by
   rank means the global sequence legitimately jumps back up at each heading.
   Asserting the old global rule here would fail a correct page. */
const groups = await page.locator('h2.group').allTextContents();
check('the three groups are present and named',
  groups.length === 3 && /last 7 days/i.test(groups[0]) && /applied/i.test(groups[1])
    && /no posted date/i.test(groups[2]),
  groups.join(' | '));

const perGroup = await page.evaluate(() => {
  const out = [];
  let current = null;
  for (const el of document.querySelectorAll('#targets > *')) {
    if (el.matches('h2.group')) { current = { name: el.textContent.trim(), ranks: [] }; out.push(current); }
    else if (el.matches('.target') && current) {
      current.ranks.push(Number((el.querySelector('.rank')?.textContent || '').replace('%', '')));
    }
  }
  return out;
});
const badOrder = perGroup.filter((g) => !g.ranks.every((n, i) => i === 0 || g.ranks[i - 1] >= n));
check('each group is ordered by rank, highest first',
  perGroup.length === 3 && badOrder.length === 0,
  perGroup.map((g) => `${g.ranks[0]}>${g.ranks[g.ranks.length - 1]}`).join(' / '));

/* Each group has exactly one predicate, so a row must not sit in the wrong one. */
const appliedGroup = perGroup.findIndex((g) => /applied/i.test(g.name));
const misplaced = await page.evaluate(() => {
  const out = { appliedOutside: 0, datedInUndated: 0 };
  let name = '';
  for (const el of document.querySelectorAll('#targets > *')) {
    if (el.matches('h2.group')) { name = el.textContent.trim(); continue; }
    if (!el.matches('.target')) continue;
    const isApplied = !!el.querySelector('.meta.applied');
    const text = el.querySelector('.who')?.textContent || '';
    if (isApplied && !/applied/i.test(name)) out.appliedOutside++;
    if (/no posted date/i.test(name) && !/no posted date/.test(text)) out.datedInUndated++;
  }
  return out;
});
check('applied rows sit only in the applied group',
  misplaced.appliedOutside === 0 && appliedGroup === 1, JSON.stringify(misplaced));
check('every card in the undated group really has no date',
  misplaced.datedInUndated === 0, `${misplaced.datedInUndated} dated rows in it`);

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
check('all four openers are offered',
  shapes.length === 4, shapes.join(' / '));

/* The post's own constraint: a question answerable in one sentence. A template
   without a question is the part most easily lost when it gets personalised. */
const bodies = await page.locator('.target').first().locator('.shapes .msg').allTextContents();
check('every opener ends in a question',
  bodies.length === 4 && bodies.every((b) => b.trim().endsWith('?')),
  bodies.map((b) => b.trim().slice(-28)).join(' | '));

check('and each one is copyable',
  await page.locator('.target').first().locator('.shapes button.copy').count() === 4);

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
