/**
 * Careers sites that refuse a plain fetch and need a real browser.
 *
 * Brian, 2026-09-06: these companies must now hire US citizens, so watch
 * Cognizant, Infosys, TCS, HCL and IBM and rank what they post.
 *
 * None of the five runs Greenhouse, Lever, Ashby or Workday, so the existing
 * pipeline could not reach any of them. Measured on 2026-09-08, each one
 * refuses a server-side fetch in its own way:
 *
 *   Cognizant  403 on the listing AND on every job page, even with a complete
 *              set of browser headers. Renders 10 jobs per page in a browser.
 *   IBM        202 with an empty body -- an Akamai challenge -- on
 *              careers.ibm.com. Its Avature list renders in a browser.
 *
 * So this source drives Chromium. That is the whole reason it exists, and it
 * is why it does NOT live in upsert.mjs's SOURCE_LOADERS: daily.mjs runs in a
 * plain Node step with no browser, and a source that throws there would take
 * the whole run down. It is collected by ingest/browser-sweep.mjs instead, in
 * the workflow step that has Chromium installed.
 *
 * Two sites are deliberately absent:
 *   Infosys    career.infosys.com answers a plain fetch with 1648 jobs and
 *              needs no browser -- but its sourcelist covers India, China and
 *              Manila only, so it publishes no US roles at all.
 *   TCS        no reachable host found. careers.tcs.com redirects to
 *              www.tcs.com/careers, which answers 403; ibegin.tcs.com and
 *              jobs.tcs.com resolve but accept no connection.
 *
 * A missing Playwright is not an error. It returns nothing and says so, because
 * this has to be safe to import from a step that may not have a browser.
 */

import { createRequire } from 'node:module';
import { filterJobs, joinWorkType } from '../jobs.mjs';
import { logInfo, logWarn } from '../logger.mjs';

export const meta = {
  id: 'browser-boards',
  name: 'Enterprise careers sites that require a browser',
  homepage: 'https://careers.cognizant.com/global-en/jobs/',
  kind: 'scrape',
  license: 'public postings; robots.txt allows /'
};

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Pages to walk per site. Each page is a real page load, so this is time. */
export const MAX_PAGES = 6;

/**
 * Each adapter owns one site: how to address a results page, and how to read
 * one row out of the DOM. `extract` runs INSIDE the page.
 */
export const ADAPTERS = [
  {
    id: 'cognizant',
    company: 'Cognizant',
    /* The keyword goes in the query string. A `location` parameter alongside it
       redirects to a marketing page with no jobs on it, so location is left to
       the shared eligibility rules instead. */
    listUrl: (query, page) =>
      'https://careers.cognizant.com/global-en/jobs/?keyword='
      + encodeURIComponent(query) + '&page=' + page + '&pagesize=10',
    /* Real selectors, read off the rendered card. The first version walked up
       from the anchor and used the card's whole innerText, which produced
       "Manager Save Singapore, SG" as a LOCATION -- the Save button's label
       and a title fragment glued to a city. A heuristic over card text cannot
       tell a control from an address. */
    extract: () => {
      const rows = [];
      for (const card of document.querySelectorAll('.card-body')) {
        const link = card.querySelector('h2.card-title a[href]');
        if (!link) continue;
        const meta = card.querySelector('ul.job-meta li');
        rows.push({
          title: (link.textContent || '').trim(),
          url: new URL(link.getAttribute('href'), location.origin).href,
          location: meta ? (meta.textContent || '').replace(/\s+/g, ' ').trim() : ''
        });
      }
      return rows;
    }
  },
  {
    id: 'ibm',
    company: 'IBM',
    listUrl: (query, page) =>
      'https://careers.ibm.com/en_US/careers/OpenJobs/?jobRecordsPerPage=24&jobOffset='
      + ((page - 1) * 24) + '&search=' + encodeURIComponent(query),
    /* One article per posting. IBM wraps four anchors around the same job --
       a pretitle, the title, the subtitle and a footer button -- so reading
       anchors instead of articles returned every posting four times, each with
       a different fragment of its name. */
    extract: () => {
      const rows = [];
      for (const card of document.querySelectorAll('article.article--card')) {
        const link = card.querySelector('h3.article__header__text__title a[href]');
        if (!link) continue;
        const place = card.querySelector('span.card-item-location');
        rows.push({
          title: (link.textContent || '').replace(/\s+/g, ' ').trim(),
          url: new URL(link.getAttribute('href'), location.origin).href,
          location: place ? (place.textContent || '').replace(/\s+/g, ' ').trim() : ''
        });
      }
      return rows;
    }
  }
];

/**
 * Tidy the location an adapter read out of its own location element.
 *
 * Both sites repeat themselves: Cognizant writes "Singapore,SG, Singapore,
 * Singapore" and IBM lists every office a role covers. The text is passed
 * through nearly whole, because the location rules read it and already know
 * how to judge Remote, a US state and a foreign country.
 *
 * Empty means NULL, never a guess. work_type decides whether Brian ever sees a
 * row, so an invented location is worse than an admitted blank.
 *
 * This replaced a regex over the card's whole innerText, which returned
 * "Manager Save Singapore, SG" -- a button's label and a title fragment glued
 * to a city. A heuristic over card text cannot tell a control from an address,
 * which is why each adapter now names its own location element.
 *
 * @param {string} place
 * @returns {string|null}
 */
export function locationFromCard(place) {
  const text = String(place || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const parts = [];
  for (const piece of text.split(',')) {
    const clean = piece.trim();
    if (!clean) continue;
    if (parts.some((seen) => seen.toLowerCase() === clean.toLowerCase())) continue;
    parts.push(clean);
  }
  const joined = parts.join(', ').slice(0, 180).trim();
  return joined || null;
}

/**
 * The title, cleaned of the decorations a card puts around it.
 *
 * @param {string} raw
 * @returns {string}
 */
export function cleanTitle(raw) {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .replace(/^(new|featured|hot)\s+/i, '')
    .trim()
    .slice(0, 200);
}

/**
 * Turn one adapter's raw rows into the shared posting shape.
 *
 * @param {Array<{title: string, url: string, card: string}>} rows
 * @param {{ company: string, id: string }} adapter
 * @returns {Array<object>}
 */
export function normalizeRows(rows, adapter) {
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    const url = String(row && row.url || '').trim();
    const title = cleanTitle(row && row.title);
    if (!url || !title) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      company: adapter.company,
      title,
      url,
      source: adapter.id,
      work_type: joinWorkType(locationFromCard(row.location)),
      /* Neither site states a posted date on its list. A guessed date would
         make every row look new to the freshness filter, which is the one
         thing that column must never do. */
      posted: null,
      refreshed_at: null
    });
  }
  return out;
}

/**
 * Load Playwright from wherever it lives, or null.
 *
 * @returns {{ chromium: object }|null}
 */
export function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try {
    return require('C:/Users/brian/RedAnvil/node_modules/playwright');
  } catch { /* not this machine */ }
  try {
    return require('playwright');
  } catch {
    return null;
  }
}

/**
 * Walk every adapter and return the postings found.
 *
 * @param {{ query?: string, limit?: number, pages?: number, playwright?: object, adapters?: object[] }} [options]
 * @returns {Promise<Array<object>>}
 */
export async function fetchJobs(options = {}) {
  const pw = options.playwright || loadPlaywright();
  if (!pw || !pw.chromium) {
    /* Said out loud, not swallowed. A silent empty result here would look
       exactly like "these employers posted nothing today". */
    logWarn('browser-boards skipped: playwright is not installed in this step', {});
    return [];
  }

  const adapters = options.adapters || ADAPTERS;
  const query = options.query || 'product manager';
  const pages = Number.isFinite(options.pages) ? options.pages : MAX_PAGES;
  const collected = [];

  const browser = await pw.chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ userAgent: BROWSER_UA });
    const page = await context.newPage();
    for (const adapter of adapters) {
      let found = 0;
      for (let n = 1; n <= pages; n++) {
        let rows = [];
        try {
          await page.goto(adapter.listUrl(query, n), { waitUntil: 'domcontentloaded', timeout: 45000 });
          await page.waitForTimeout(3500);
          rows = await page.evaluate(adapter.extract);
        } catch (error) {
          /* One bad page must not cost the other site. */
          logWarn('browser-boards page failed', {
            source: adapter.id, page: n, error: String(error && error.message || error).slice(0, 120)
          });
          break;
        }
        const normalized = normalizeRows(rows, adapter);
        collected.push(...normalized);
        found += normalized.length;
        /* A short page is the last page. */
        if (normalized.length === 0) break;
      }
      logInfo('browser-boards read a site', { source: adapter.id, rows: found });
    }
    await context.close();
  } finally {
    await browser.close();
  }

  /* The QUERY is a search term for the SITE, not a post-filter. Passing it on
     to filterJobs made every word mandatory in the title, so a search for
     "product manager remote" threw away "Facets Product Consultant (Remote)"
     for lacking the word manager -- the site had already matched it and the
     filter then un-matched it. Only the limit is passed. What is or is not a
     product role is decide()'s job, and it applies the same rule to every
     source. */
  return filterJobs(collected, { limit: options.limit });
}
