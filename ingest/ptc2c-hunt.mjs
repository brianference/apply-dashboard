/**
 * Fetch fully-remote, contract/part-time/fractional PM roles from verified
 * public board APIs, filtered by their own structured employment-type field
 * where one exists (Lever's `categories.commitment`), or by title/work-type
 * text otherwise. Writes ingest/out/ptc2c-found.json.
 *
 *   node ingest/ptc2c-hunt.mjs
 */

import fs from 'node:fs';

const OUT = 'ingest/out/ptc2c-found.json';
const UA = 'apply-dashboard-ingest/0.1 (+https://apply-dashboard.pages.dev)';

/** Lever boards worth checking — reused from companies known to have real postings. */
const LEVER_SLUGS = [
  'veeva', 'wealthfront', 'jobgether', 'leverdemo', 'netlify', 'ramp',
  'attentive', 'lattice', 'branch', 'clearbit', 'plaid'
];
/** Greenhouse boards to check for contract-flagged PM roles via title text. */
const GREENHOUSE_TOKENS = [
  'stripe', 'gitlab', 'anthropic', 'instacart', 'coinbase', 'fivetran',
  'samsara', 'databricks', 'reddit', 'pinterest', 'airbnb', 'figma',
  'vercel', 'dropbox', 'robinhood', 'mongodb', 'gusto', 'brex', 'intercom'
];

const PM_TITLE = /\b(product manager|product management|product owner|principal product|staff product|group product|lead product)\b/i;
const CONTRACT_TITLE = /\b(contract|contractor|c2c|corp[- ]to[- ]corp|1099|fractional|part[- ]time|freelance|temporary|interim|consult(ing|ant)|hourly|fixed[- ]term)\b/i;
const REMOTE_OK = /\b(remote|distributed|anywhere|work from home|wfh)\b/i;

/**
 * @param {string} url
 * @returns {Promise<{status:number, json:any}|null>}
 */
async function get(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 20000);
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: c.signal });
    clearTimeout(t);
    if (!r.ok) return { status: r.status, json: null };
    return { status: r.status, json: await r.json() };
  } catch {
    return null;
  }
}

const found = [];
const attempted = [];

console.log('=== Lever (structured commitment field) ===');
for (const slug of LEVER_SLUGS) {
  const r = await get(`https://api.lever.co/v0/postings/${slug}?mode=json`);
  const rows = Array.isArray(r?.json) ? r.json : [];
  attempted.push({ source: `lever:${slug}`, status: r?.status ?? 'ERR', rowCount: rows.length });
  console.log(`  ${slug.padEnd(14)} ${r?.status ?? 'ERR'}  ${rows.length} postings`);
  for (const j of rows) {
    const commitment = j.categories?.commitment || '';
    /* Real values measured from jobgether's own feed: "Full-time", "Contract",
       "Part-time", "Fixed term" - not "Contractor", which matched nothing. */
    if (!/part-time|contract|fixed term/i.test(commitment)) continue;
    if (!PM_TITLE.test(j.text || '')) continue;
    const loc = j.categories?.location || '';
    /* jobgether's remote roles are heavily EU/UK - "workplaceType: remote" alone
       does not mean US-eligible. Nine of the first ten contract PM rows were
       Netherlands/France/Ireland/UK/Spain/Germany. Require an explicit US
       mention, or no location at all (ambiguous, left for the criteria filter
       to judge), rather than trusting "remote" by itself. */
    if (j.workplaceType !== 'remote') continue;
    const US_MENTION = /\b(united states|usa|u\.s\.|\bus\b)\b/i;
    if (loc && !US_MENTION.test(loc)) continue;
    found.push({
      company: slug, title: j.text, url: j.hostedUrl,
      work_type: `${loc} | ${commitment}`, source: `lever:${slug}`,
      lane: 'ptc2c', laneReason: `Lever categories.commitment="${commitment}"`
    });
  }
  await new Promise(r2 => setTimeout(r2, 300));
}

console.log('\n=== Greenhouse (title/work-type text, no structured field) ===');
for (const token of GREENHOUSE_TOKENS) {
  const r = await get(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`);
  const rows = Array.isArray(r?.json?.jobs) ? r.json.jobs : [];
  attempted.push({ source: `greenhouse:${token}`, status: r?.status ?? 'ERR', rowCount: rows.length });
  console.log(`  ${token.padEnd(14)} ${r?.status ?? 'ERR'}  ${rows.length} postings`);
  for (const j of rows) {
    if (!PM_TITLE.test(j.title || '')) continue;
    if (!CONTRACT_TITLE.test(j.title || '')) continue;
    const loc = j.location?.name || '';
    if (!REMOTE_OK.test(loc) && !REMOTE_OK.test(j.title)) continue;
    found.push({
      company: token, title: j.title, url: j.absolute_url,
      work_type: loc, source: `greenhouse:${token}`,
      lane: 'ptc2c', laneReason: `title matched contract pattern: "${j.title}"`
    });
  }
  await new Promise(r2 => setTimeout(r2, 300));
}

console.log(`\nfound: ${found.length} candidate PT/C2C rows`);
fs.mkdirSync('ingest/out', { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(found, null, 1));
fs.writeFileSync('ingest/out/ptc2c-attempted.json', JSON.stringify(attempted, null, 1));
console.log(`wrote ${OUT}`);
