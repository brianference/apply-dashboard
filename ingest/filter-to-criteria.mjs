/**
 * Filter discovered postings down to Brian's stated criteria (CRITERIA.md).
 *
 * The discovery pass optimises for recall; this is the precision pass. It runs
 * on the ingest output and emits only rows that belong in the queue, plus a
 * report of exactly what was dropped and why, so nothing disappears silently.
 *
 *   node ingest/filter-to-criteria.mjs [--in ingest/out/jobs.json] [--out ingest/out/filtered.json]
 */

import fs from 'node:fs';
import path from 'node:path';

/** Titles that are genuinely product management. */
const PM_TITLE = /\b(product manager|product management|product owner|principal product|staff product|group product|lead product|director,? product|director of product|head of product|vp,? product|chief product)\b/i;

/** Titles containing "product" that are NOT product management. */
const NOT_PM = /\b(product marketing|product design|product designer|product support|product operations|product ops|engineering manager|software engineer|data scientist|product analyst|product specialist|sales|recruiter|customer success|solutions (architect|engineer)|technical writer|program manager|project manager)\b/i;

/** Industries Brian skips outright. */
const SKIP_INDUSTRY = /\b(healthcare|health ?care|health system|health plan|hospital|clinical|patient|payer|medicaid|medicare|telehealth|construction|architecture firm|architectural)\b/i;

/* Healthcare employers whose name never contains the word "healthcare". Matched
   against the company field only, so a generic word cannot knock out a fintech.
   Two SCAN Health rows reached the live queue before this existed. */
const SKIP_COMPANY = /\b(scan health|parsley health|oscar health|devoted health|included health|carbon health|cityblock|privia|athenahealth|teladoc|honest medical|medely)\b/i;

/** Seniority he is targeting. Junior/associate rungs are below his level. */
const TOO_JUNIOR = /\b(associate product manager|junior|intern|apprentice|entry[- ]level|apm\b|graduate)\b/i;

/** Contract / part-time indicators, for the ptc2c lane. */
const CONTRACT = /\b(contract|contractor|c2c|corp[- ]to[- ]corp|1099|fractional|part[- ]time|freelance|temporary|interim|consult(ing|ant)|hourly|fixed[- ]term)\b/i;

/** Remote-US eligibility. He is in Arizona and will not relocate. */
const REMOTE_OK = /\b(remote|distributed|anywhere|work from home|wfh)\b/i;
/* Exclusion-based, not inclusion-based. "New York, San Francisco or Remote" is a
   US-eligible posting, and an inclusion list rejected it. Only an explicit
   non-US-only restriction disqualifies. */
const NON_US_ONLY = /\b(canada[- ]?(only|remote \(on|remote \(ab)|only in canada|emea only|uk only|united kingdom only|europe only|eu only|apac only|india only|latam only|australia only)\b/i;
const NON_US_COUNTRY_ONLY = /^\s*(canada|toronto|vancouver|london|dublin|berlin|paris|amsterdam|singapore|sydney|bangalore|tel aviv|madrid|lisbon|warsaw|mexico city|são paulo|sao paulo)\b[^|]*$/i;

/**
 * @param {string[]} argv
 * @returns {Record<string,string>}
 */
function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1];
  }
  return o;
}

/**
 * @param {object} row
 * @returns {{keep:boolean, reason:string, lane:string}}
 */
export function judge(row) {
  const title = String(row.title || '');
  const company = String(row.company || '');
  const work = String(row.work_type || '');
  const hay = `${title} ${company} ${work}`;

  if (NOT_PM.test(title)) return { keep: false, reason: 'not a product-management title', lane: 'ft' };
  if (!PM_TITLE.test(title)) return { keep: false, reason: 'title is not a PM role', lane: 'ft' };
  if (TOO_JUNIOR.test(title)) return { keep: false, reason: 'below target seniority', lane: 'ft' };
  if (SKIP_INDUSTRY.test(hay)) return { keep: false, reason: 'skipped industry', lane: 'ft' };
  if (SKIP_COMPANY.test(company)) return { keep: false, reason: 'skipped industry (company name)', lane: 'ft' };
  if (!row.url) return { keep: false, reason: 'no posting URL', lane: 'ft' };

  const remote = REMOTE_OK.test(work) || REMOTE_OK.test(title);
  if (!remote) return { keep: false, reason: `not remote (${work.slice(0, 40)})`, lane: 'ft' };
  if (NON_US_ONLY.test(work) || NON_US_COUNTRY_ONLY.test(work.trim())) {
    return { keep: false, reason: `non-US only (${work.slice(0, 40)})`, lane: 'ft' };
  }

  const lane = CONTRACT.test(`${title} ${work}`) ? 'ptc2c' : 'ft';
  return { keep: true, reason: 'ok', lane };
}

const a = args(process.argv.slice(2));
const IN = a.in || 'ingest/out/jobs.json';
const OUT = a.out || 'ingest/out/filtered.json';

const raw = JSON.parse(fs.readFileSync(IN, 'utf8'));
const rows = Array.isArray(raw) ? raw : (raw.jobs || raw.rows || []);

const kept = [];
const dropped = [];
for (const r of rows) {
  const v = judge(r);
  if (v.keep) kept.push({ ...r, lane: v.lane });
  else dropped.push({ title: r.title, company: r.company, reason: v.reason });
}

const byReason = {};
for (const d of dropped) byReason[d.reason.replace(/\(.*/, '').trim()] = (byReason[d.reason.replace(/\(.*/, '').trim()] || 0) + 1;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(kept, null, 1));
fs.writeFileSync(OUT.replace(/\.json$/, '-dropped.json'), JSON.stringify(dropped, null, 1));

console.log(`in:      ${rows.length}`);
console.log(`kept:    ${kept.length}   (ft ${kept.filter(r => r.lane === 'ft').length}, ptc2c ${kept.filter(r => r.lane === 'ptc2c').length})`);
console.log(`dropped: ${dropped.length}`);
for (const [reason, n] of Object.entries(byReason).sort((x, y) => y[1] - x[1])) {
  console.log(`   ${String(n).padStart(4)}  ${reason}`);
}
console.log(`\nwrote ${OUT} and ${OUT.replace(/\.json$/, '-dropped.json')}`);
