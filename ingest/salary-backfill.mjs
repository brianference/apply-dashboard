/**
 * Backfill salary ranges onto the live queue, so the $180k floor in CRITERIA.md
 * can actually be enforced.
 *
 * CRITERIA.md records the gap plainly: "the jobs table has no salary column at
 * all, so the $180k floor cannot be recorded, filtered, or enforced." Twenty-nine
 * applications went out before this existed. The column now exists; this fills it.
 *
 * Source is the same TrueUp index that backs Lenny's Jobs (arc.trueup.io), which
 * publishes salary_range_min / salary_range_max per posting. One query per
 * company, matched back to the queue on a normalised title.
 *
 * Nothing is invented: a posting TrueUp does not price is left NULL and reported
 * as unpriced, never assumed to clear or miss the floor.
 *
 *   node ingest/salary-backfill.mjs                 # writes ingest/out/salary-backfill.json + .sql
 *   node ingest/salary-backfill.mjs --limit 20      # try a slice first
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname)
  .replace(/^\/([A-Za-z]:)/, '$1'), '..');
const OUT_DIR = path.join(ROOT, 'ingest', 'out');
const API = 'https://apply-dashboard.pages.dev/api/jobs';
const ENDPOINT = 'https://arc.trueup.io/jobs/search';
const FLOOR = 180000;

const HEADERS = {
  'content-type': 'application/json',
  referer: 'https://www.lennysjobs.com/',
  'x-rc': '4369d1073763e670',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
};

const argv = process.argv.slice(2);
const LIMIT = Number((argv[argv.indexOf('--limit') + 1]) || 0) || Infinity;

/** @param {string} s @returns {string} comparable title */
const norm = (s) => String(s || '').toLowerCase()
  .replace(/\(.*?\)/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\b(sr|snr)\b/g, 'senior')
  .replace(/\b(jr)\b/g, 'junior')
  .trim();

/**
 * Ask TrueUp for everything it has under one company name.
 * @param {string} company
 * @returns {Promise<object[]>}
 */
async function searchCompany(company) {
  const body = JSON.stringify([{
    indexName: 'job',
    params: { query: company, hitsPerPage: 100, page: 0, trueupRequestVersion: 2, trueupPartnerId: 'lenny' },
  }]);
  const res = await fetch(ENDPOINT, { method: 'POST', headers: HEADERS, body });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return json.results?.[0]?.hits || [];
}

const live = await fetch(API, { headers: { 'cache-control': 'no-cache' } }).then(r => r.json());
const queued = live.jobs.filter(j => j.status === 'queued');
const companies = [...new Set(queued.map(j => j.company))].slice(0, LIMIT);

console.log(`${queued.length} queued rows across ${companies.length} companies\n`);

const priced = [];
const unpriced = [];
let done = 0;

for (const company of companies) {
  let hits = [];
  try {
    hits = await searchCompany(company);
  } catch (err) {
    console.log(`  ${company}: lookup failed (${err.message})`);
  }
  /* Only hits whose own company field really is this company. A bare text query
     also returns postings that merely mention the name in their description. */
  const mine = hits.filter(h => norm(h.company_name) === norm(company));
  const byTitle = new Map(mine.map(h => [norm(h.title), h]));

  for (const row of queued.filter(j => j.company === company)) {
    const hit = byTitle.get(norm(row.title));
    const min = hit ? hit.salary_range_min : null;
    const max = hit ? hit.salary_range_max : null;
    if (min || max) priced.push({ ...row, salary_min: min ?? null, salary_max: max ?? null });
    else unpriced.push(row);
  }
  done++;
  if (done % 20 === 0) console.log(`  ...${done}/${companies.length} companies, ${priced.length} priced so far`);
  await new Promise(r => setTimeout(r, 120));
}

/* Brian's call, 2026-08-24: 160-180k is not a reject, it is a second lane. It
   stays reachable as status 'tier2' instead of being skipped, so the main run
   works the at-or-above-floor roles first and these are still there afterwards. */
const SECOND = 160000;
const top = (p) => Number(p.salary_max ?? p.salary_min);
const over = priced.filter(p => top(p) >= FLOOR);
const tier2 = priced.filter(p => top(p) >= SECOND && top(p) < FLOOR);
const under = priced.filter(p => top(p) < SECOND);

const esc = (s) => String(s).replace(/'/g, "''");
const sql = [
  ...priced.map(p => `UPDATE jobs SET salary_min=${p.salary_min ?? 'NULL'}, salary_max=${p.salary_max ?? 'NULL'}, `
    + `salary_source='trueup' WHERE dedupe_key='${esc(p.dedupe_key)}';`),
  ...tier2.map(p => `UPDATE jobs SET status='tier2', blocked_reason='second-priority-salary', `
    + `blocked_detail='TrueUp range tops out at ${top(p)} - between 160000 and the 180000 floor, kept as second priority' `
    + `WHERE dedupe_key='${esc(p.dedupe_key)}';`),
  ...under.map(p => `UPDATE jobs SET status='skipped', blocked_reason='under-salary-floor', `
    + `blocked_detail='TrueUp range tops out at ${top(p)}, under the 160000 second-priority line' `
    + `WHERE dedupe_key='${esc(p.dedupe_key)}';`),
];

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'salary-backfill.sql'), sql.join('\n') + '\n');
fs.writeFileSync(path.join(OUT_DIR, 'salary-backfill.json'),
  JSON.stringify({ priced, unpriced: unpriced.map(u => ({ company: u.company, title: u.title })) }, null, 1));

console.log(`\npriced by TrueUp: ${priced.length}`);
console.log(`  at or above $${FLOOR}: ${over.length}`);
console.log(`  160k-180k, kept as tier2 (second priority): ${tier2.length}`);
console.log(`  under 160k (skipped): ${under.length}`);
console.log(`no published range, left NULL: ${unpriced.length}`);
console.log(`\n${sql.length} statements -> ingest/out/salary-backfill.sql`);
console.log('\n--- below the floor');
for (const p of under) console.log(`  ${p.company} | ${p.title} | $${p.salary_min}-${p.salary_max}`);
