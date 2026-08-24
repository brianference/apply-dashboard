/**
 * Read the pay range off each posting itself and write it onto the queue.
 *
 * The first attempt asked TrueUp for every company and got HTTP 401 after a
 * burst -- its x-rc token is short lived, and 158 lookups exhausted it. The
 * posting page is a better source anyway: US pay-transparency law makes most
 * employers publish the band on the posting, so this is the employer's own
 * number rather than a third party's estimate of it.
 *
 * Nothing is guessed. A posting with no band is left NULL and counted as
 * unpriced; it is never assumed to clear or miss the floor.
 *
 *   node ingest/salary-from-posting.mjs            # all queued rows
 *   node ingest/salary-from-posting.mjs --limit 25
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname)
  .replace(/^\/([A-Za-z]:)/, '$1'), '..');
const OUT_DIR = path.join(ROOT, 'ingest', 'out');
const API = 'https://apply-dashboard.pages.dev/api/jobs';
const FLOOR = 180000;
const SECOND = 160000;   /* Brian, 2026-08-24: 160-180k is a second lane, not a reject. */
const CONCURRENCY = 6;

const argv = process.argv.slice(2);
const LIMIT = Number(argv[argv.indexOf('--limit') + 1]) || Infinity;

/**
 * Pull every dollar figure that reads like an annual salary out of page text.
 * Handles "$180,000 - $220,000", "$180K-$220K" and "USD 180,000".
 * @param {string} text
 * @returns {number[]} plausible annual figures, ascending
 */
function figures(text) {
  const out = [];
  const re = /\$\s?([0-9]{2,3}(?:,[0-9]{3})+|[0-9]{2,3}(?:\.[0-9])?\s?[kK])/g;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[1].replace(/[,\s]/g, '');
    const n = /[kK]$/.test(raw) ? Math.round(parseFloat(raw) * 1000) : Number(raw);
    /* An hourly rate or an equity figure is not a salary band. Keep the window
       wide enough for a real PM band and narrow enough to exclude both. */
    if (n >= 50000 && n <= 800000) out.push(n);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * Find an ADJACENT pair of figures written as a range.
 *
 * Taking the lowest and highest figure anywhere on the page is wrong on an
 * aggregator: weworkremotely renders other listings alongside this one, so
 * Ethos Life came back $75,000-228,000 and Great Minds $75,000-170,000 -- in
 * both cases the $75,000 belongs to a different job on the same page. A real
 * band is written as two figures joined by a dash, "to", or "up to".
 *
 * @param {string} text
 * @returns {{min:number|null,max:number|null}}
 */
function rangePair(text) {
  /* Written as one literal so the escapes cannot be mangled by a build or an
     editor round-trip: two dollar figures joined by a dash, "to", or "up to". */
  const re = /\$\s?([0-9]{2,3}(?:,[0-9]{3})+|[0-9]{2,3}(?:\.[0-9])?\s?[kK])\s*(?:-|–|—|to|through|up to)\s*\$?\s?([0-9]{2,3}(?:,[0-9]{3})+|[0-9]{2,3}(?:\.[0-9])?\s?[kK])/gi;
  const toN = (raw) => {
    const r = String(raw).replace(/[,\s]/g, '');
    return /[kK]$/.test(r) ? Math.round(parseFloat(r) * 1000) : Number(r);
  };
  let m;
  while ((m = re.exec(text))) {
    const a = toN(m[1]);
    const b = toN(m[2]);
    /* Working Nomads renders a salary FILTER widget on every posting whose
       options read "$75,000 - $99,999", "$100,000 - $124,999" and so on. Seven
       rows came back as exactly 75000-99999, which is the widget, not the job.
       A real band does not end at 999, so drop those and keep looking. */
    if (b % 1000 === 999) continue;
    if (a >= 50000 && b <= 800000 && b > a) return { min: a, max: b };
  }
  return { min: null, max: null };
}

/**
 * @param {string} url
 * @returns {Promise<{min:number|null,max:number|null}>}
 */
async function priceOf(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36' },
    });
    if (!res.ok) return { min: null, max: null };
    const html = await res.text();
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
    /* An explicit range is the only trustworthy read. A page with figures but
       no range is reported unpriced rather than guessed at from the extremes. */
    const pair = rangePair(text);
    if (pair.min) return pair;
    const f = figures(text);
    return { min: null, max: null, seen: f.length };
  } catch {
    return { min: null, max: null };
  } finally {
    clearTimeout(t);
  }
}

const live = await fetch(API, { headers: { 'cache-control': 'no-cache' } }).then(r => r.json());
const queued = live.jobs.filter(j => j.status === 'queued').slice(0, LIMIT);
console.log(`reading pay bands off ${queued.length} postings, ${CONCURRENCY} at a time\n`);

const priced = [];
const unpriced = [];
let i = 0;
let done = 0;

async function worker() {
  while (i < queued.length) {
    const row = queued[i++];
    const { min, max } = await priceOf(row.url);
    if (min) priced.push({ ...row, salary_min: min, salary_max: max });
    else unpriced.push(row);
    if (++done % 25 === 0) console.log(`  ...${done}/${queued.length}, ${priced.length} priced`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const top = (p) => Number(p.salary_max ?? p.salary_min);
const over = priced.filter(p => top(p) >= FLOOR);
const tier2 = priced.filter(p => top(p) >= SECOND && top(p) < FLOOR);
const under = priced.filter(p => top(p) < SECOND);

const esc = (s) => String(s).replace(/'/g, "''");
const sql = [
  ...priced.map(p => `UPDATE jobs SET salary_min=${p.salary_min}, salary_max=${p.salary_max ?? 'NULL'}, `
    + `salary_source='posting' WHERE dedupe_key='${esc(p.dedupe_key)}';`),
  ...tier2.map(p => `UPDATE jobs SET status='tier2', blocked_reason='second-priority-salary', `
    + `blocked_detail='posted band tops out at ${top(p)}, between 160000 and the 180000 floor' `
    + `WHERE dedupe_key='${esc(p.dedupe_key)}';`),
  ...under.map(p => `UPDATE jobs SET status='skipped', blocked_reason='under-salary-floor', `
    + `blocked_detail='posted band tops out at ${top(p)}, under the 160000 second-priority line' `
    + `WHERE dedupe_key='${esc(p.dedupe_key)}';`),
];

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'salary-posting.sql'), sql.join('\n') + '\n');
fs.writeFileSync(path.join(OUT_DIR, 'salary-posting.json'), JSON.stringify({ priced, unpriced }, null, 1));

console.log(`\npriced from the posting: ${priced.length}`);
console.log(`  at or above $${FLOOR}: ${over.length}`);
console.log(`  ${SECOND}-${FLOOR} kept as tier2: ${tier2.length}`);
console.log(`  under ${SECOND} (skipped): ${under.length}`);
console.log(`no band published, left NULL: ${unpriced.length}`);
console.log(`\n${sql.length} statements -> ingest/out/salary-posting.sql`);
console.log('\n--- under 160k, being skipped');
for (const p of under) console.log(`  ${p.company} | ${p.title} | $${p.salary_min}-${p.salary_max}`);
console.log('\n--- 160k-180k, second priority');
for (const p of tier2) console.log(`  ${p.company} | ${p.title} | $${p.salary_min}-${p.salary_max}`);
