/**
 * Ingest Lenny's Jobs (www.lennysjobs.com).
 *
 * The board is a TrueUp white-label: the page ships no postings in its HTML and
 * fetches them from arc.trueup.io/jobs/search, an Algolia-shaped endpoint. The
 * request was captured from a real browser session; it needs no login, and the
 * board's own Substack verification gates the UI, not the API.
 *
 * The payload carries salary_range_min / salary_range_max, which CRITERIA.md
 * records as missing from every other source in this pipeline, so the $180k
 * floor is actually checkable here.
 *
 *   node ingest/lennysjobs.mjs                       # writes ingest/out/lenny-found.json
 *   node ingest/lennysjobs.mjs --pages 20
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname)
  .replace(/^\/([A-Za-z]:)/, '$1'), '..');
const OUT_DIR = path.join(ROOT, 'ingest', 'out');
const ENDPOINT = 'https://arc.trueup.io/jobs/search';

/* Captured from the live board. x-rc rides along with the request the page
   makes; the endpoint answers without it, but sending it keeps this
   indistinguishable from the board's own traffic. */
const HEADERS = {
  'content-type': 'application/json',
  referer: 'https://www.lennysjobs.com/',
  'x-rc': '4369d1073763e670',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
};

/* Brian will not relocate, so only the two US-remote buckets and the global
   Remote bucket are worth pulling. The facet values carry the flag emoji the
   board renders them with -- they are part of the literal value. */
const LOCATIONS = [
  'job_locations_combined:\u{1F1FA}\u{1F1F8} United States (remote)',
  'job_locations_combined:\u{1F30E} Remote',
  'job_locations_combined:\u{1F1FA}\u{1F1F8} United States',
];

const args = Object.fromEntries(process.argv.slice(2)
  .map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : null)
  .filter(Boolean));
const PAGES = Number(args.pages || 20);

/**
 * Fetch one page of Product Management postings.
 * @param {number} page zero-based page index
 * @returns {Promise<{hits: object[], nbPages: number, nbHits: number}>}
 */
async function fetchPage(page) {
  const body = JSON.stringify([{
    indexName: 'job',
    params: {
      facetFilters: [['job_subcategories_all:Product Management'], LOCATIONS],
      hitsPerPage: 100,
      page,
      query: '',
      trueupRequestVersion: 2,
      trueupPartnerId: 'lenny',
    },
  }]);
  const res = await fetch(ENDPOINT, { method: 'POST', headers: HEADERS, body });
  if (!res.ok) throw new Error(`TrueUp search failed: HTTP ${res.status}`);
  const json = await res.json();
  const r = json.results?.[0];
  if (!r) throw new Error('TrueUp search returned no result block');
  return { hits: r.hits || [], nbPages: r.nbPages || 0, nbHits: r.nbHits || 0 };
}

/**
 * Map a TrueUp hit onto the row shape the rest of the pipeline uses.
 * @param {object} h
 * @returns {object}
 */
function toRow(h) {
  const company = String(h.company_name || '').trim();
  const title = String(h.title || '').replace(/\s+/g, ' ').trim();
  return {
    company,
    title,
    url: h.url,
    /* work_type is what filter-to-criteria greps for remote eligibility, so the
       location string has to land there rather than in a field it ignores. */
    work_type: String(h.location || '').replace(/\s+/g, ' ').trim(),
    posted: h.updated_at || null,
    source: 'lennysjobs',
    salary_min: h.salary_range_min ?? null,
    salary_max: h.salary_range_max ?? null,
    level: h.level ?? null,
    themes: h.themes || [],
    tags: h.description_tags || [],
    dedupe_key: `${company.toLowerCase()}|${title.toLowerCase()}`,
  };
}

const all = new Map();
let nbHits = 0;
for (let p = 0; p < PAGES; p++) {
  let got;
  try {
    got = await fetchPage(p);
  } catch (err) {
    console.error(`page ${p}: ${err.message}`);
    break;
  }
  nbHits = got.nbHits;
  for (const h of got.hits) {
    const row = toRow(h);
    if (row.url) all.set(row.url, row);
  }
  console.log(`page ${p}: ${got.hits.length} hits (${all.size} unique so far, ${got.nbHits} total matching)`);
  if (p + 1 >= got.nbPages) break;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const outFile = path.join(OUT_DIR, 'lenny-found.json');
fs.writeFileSync(outFile, JSON.stringify([...all.values()], null, 1));
console.log(`\n${all.size} unique postings written to ${outFile} (endpoint reports ${nbHits} matching)`);
