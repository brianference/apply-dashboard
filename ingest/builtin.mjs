/**
 * Pull remote product-manager roles from Built In's public search, then follow
 * each posting to recover the employer's REAL application URL.
 *
 * Built In is an aggregator: applying on builtin.com is not the same as applying
 * on the company's ATS, and the runner can only complete a real ATS form. Each
 * posting page carries an "Apply" link that points at the underlying Greenhouse
 * / Lever / Ashby posting, so that is what gets stored.
 *
 *   node ingest/builtin.mjs [--pages 8]
 */

import fs from 'node:fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';
const OUT = 'ingest/out/builtin-found.json';
const PAGES = Number((process.argv.find(a => a.startsWith('--pages=')) || '--pages=8').split('=')[1]);

const ATS = /ashbyhq\.com|greenhouse\.io|lever\.co|workable\.com|smartrecruiters\.com|myworkdayjobs\.com|icims\.com|breezy\.hr|recruitee\.com|teamtailor\.com|applytojob\.com/i;

/**
 * @param {string} url
 * @returns {Promise<string|null>}
 */
async function get(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 25000);
    const r = await fetch(url, { headers: { 'user-agent': UA }, signal: c.signal, redirect: 'follow' });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
}

/** @param {string} s @returns {string} */
const decode = (s) => s
  .replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim();

const slugs = new Set();
for (let p = 1; p <= PAGES; p++) {
  /* Brian's own Built In search: AI Product Manager, all locations, updated in
     the last 3 days. The preference_id form of this URL needs his login, but
     the same filters work unauthenticated as query params. */
  const html = await get('https://builtin.com/jobs?search=AI+Product+Manager'
    + '&city=Phoenix&state=Arizona&country=USA&allLocations=true'
    + `&page=${p}`);
  if (!html) { console.log(`page ${p}: fetch failed`); continue; }
  const found = [...html.matchAll(/href="\/job\/([^"]+)"/g)].map(m => m[1]);
  found.forEach(s => slugs.add(s));
  console.log(`page ${p}: ${found.length} links (${slugs.size} unique so far)`);
  await new Promise(r => setTimeout(r, 400));
}

console.log(`\nresolving ${slugs.size} postings to their real ATS URL...`);
const rows = [];
let checked = 0;
for (const slug of slugs) {
  checked++;
  const html = await get(`https://builtin.com/job/${slug}`);
  if (!html) continue;

  const title = decode((html.match(/<title>([^<]{5,140})<\/title>/i) || [])[1] || '')
    .replace(/\s*\|\s*Built ?In.*$/i, '').trim();
  const company = decode((html.match(/"hiringOrganization"\s*:\s*\{[^}]*?"name"\s*:\s*"([^"]{2,60})"/i) || [])[1]
    || (html.match(/data-company-name="([^"]{2,60})"/i) || [])[1] || '');

  /* the employer's own posting, not the builtin.com wrapper */
  const urls = [...html.matchAll(/https?:\/\/[^\s"'<>\\]{10,200}/g)].map(m => m[0]);
  const apply = urls.find(u => ATS.test(u));
  if (!apply) continue;

  const loc = decode((html.match(/"jobLocationType"\s*:\s*"([^"]+)"/i) || [])[1] || 'Remote');
  rows.push({
    company: company || slug.split('/')[0],
    title: title || slug.replace(/-/g, ' '),
    url: apply.replace(/[),.]+$/, ''),
    work_type: loc,
    source: 'builtin',
    lane: 'ft'
  });
  if (checked % 10 === 0) console.log(`  ${checked}/${slugs.size} checked, ${rows.length} with a real ATS link`);
  await new Promise(r => setTimeout(r, 300));
}

fs.mkdirSync('ingest/out', { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(rows, null, 1));
console.log(`\n${rows.length} postings resolved to a real ATS form -> ${OUT}`);
