/**
 * Collapse a middleman's relisting onto the employer's own posting.
 *
 * Brian, 2026-09-18: collapse any Jobgether row whose title matches.
 *
 * Jobgether republishes other employers' postings on its own Lever board as
 * "Jobgether (anonymized partner employer)". The three duplicate checks in
 * decide() cannot see these: the company differs and the URL is
 * jobs.lever.co/jobgether. Measured on 2026-09-18, 50 live rows were Jobgether
 * relistings and 18 carried a title identical to a row under the real
 * employer, Upstart, Veeva, CodePath and Headway among them. Eight
 * applications went in through Jobgether, and one of those also went in
 * directly to Tremendous on the same day, which is the double application the
 * duplicate rule exists to prevent.
 *
 * WHAT COLLAPSES. A queued Jobgether row whose normalised title equals the
 * normalised title of a live (queued or submitted) row under a named
 * employer. It is marked the way dedupe-repair marks a duplicate,
 * blocked_reason 'duplicate-posting', so the dashboard's existing label and
 * filter apply, and blocked_detail names the employer it collapsed onto.
 *
 * WHAT DOES NOT. A submitted Jobgether row is history and is never rewritten;
 * it is reported so Brian can see it. A Jobgether row with no matching title
 * stays, because the employer behind it may not be in the queue at all, and
 * removing it would lose a real posting. Those keep their existing flag.
 *
 * Title equality is deliberately strict. sameJob()'s looser matching exists
 * for two boards spelling one employer two ways; here the employer name is
 * unknown by design, so the title is the only signal, and a fuzzy title match
 * would collapse "Senior Product Manager" at one employer onto "Senior
 * Product Manager" at another. Only rows whose full title matches AND whose
 * twin is a single employer are collapsed; a title shared by two named
 * employers is ambiguous and is reported, not written.
 *
 *   node ingest/collapse-relistings.mjs           # report
 *   node ingest/collapse-relistings.mjs --write   # apply
 */

import { isCli, parseArgs } from './cli.mjs';
import { DUPLICATE_REASON } from './dedupe-repair.mjs';

const ACCOUNT = 'dd01b432f0329f87bb1cc1a3fad590ee';
const DATABASE = '10e8a6c0-1fa7-4c33-a007-2044876ce6a7';
const READ_API = 'https://apply-dashboard.pages.dev/api/jobs';

/** The middlemen this applies to, matched on the stored company name. */
export const RELISTERS = [/^jobgether\b/i];

/** @param {string} s @returns {string} */
export const normTitle = (s) => String(s || '').toLowerCase()
  .replace(/\s*[-–—|]\s*(jobgether|remote)\s*$/i, '')
  .replace(/\(remote\)|\bremote\b/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

/**
 * Plan the collapse from a set of rows. Pure, so it can be tested on fixtures.
 *
 * @param {Array<Record<string, any>>} rows
 * @returns {{ collapse: Array<{row: any, onto: any}>, ambiguous: Array<{row: any, twins: any[]}>, submitted: Array<{row: any, onto: any}>, kept: any[] }}
 */
export function planCollapse(rows) {
  const live = rows.filter((r) => r && (r.status === 'queued' || r.status === 'submitted'));
  const isRelister = (r) => RELISTERS.some((re) => re.test(String(r.company || '')));
  const named = live.filter((r) => !isRelister(r));
  const byTitle = new Map();
  for (const r of named) {
    const t = normTitle(r.title);
    if (!t) continue;
    if (!byTitle.has(t)) byTitle.set(t, []);
    byTitle.get(t).push(r);
  }
  const out = { collapse: [], ambiguous: [], submitted: [], kept: [] };
  for (const r of live.filter(isRelister)) {
    const twins = byTitle.get(normTitle(r.title)) || [];
    const employers = [...new Set(twins.map((t) => String(t.company).toLowerCase()))];
    if (!twins.length) { out.kept.push(r); continue; }
    if (employers.length > 1) { out.ambiguous.push({ row: r, twins }); continue; }
    /* Prefer the submitted twin as the thing collapsed onto, then the ranked one. */
    const onto = twins.sort((a, b) => (b.status === 'submitted') - (a.status === 'submitted') || (b.rank_pct || 0) - (a.rank_pct || 0))[0];
    if (r.status === 'submitted') out.submitted.push({ row: r, onto });
    else out.collapse.push({ row: r, onto });
  }
  return out;
}

if (isCli(import.meta.url)) {
  const args = parseArgs();
  const write = !!args.write;
  const token = process.env.CF_D1_TOKEN || '';
  const rows = (await (await fetch(READ_API, { headers: { 'cache-control': 'no-cache' } })).json()).jobs || [];
  const plan = planCollapse(rows);

  console.log(`relistings live: ${plan.collapse.length + plan.ambiguous.length + plan.submitted.length + plan.kept.length}`);
  console.log(`  collapse (queued, one named twin): ${plan.collapse.length}`);
  for (const { row, onto } of plan.collapse) {
    console.log(`    ${String(row.rank_pct).padStart(4)}%  ${String(row.title).slice(0, 46).padEnd(46)} -> ${onto.company} (${onto.status}${onto.rank_pct != null ? ' ' + onto.rank_pct + '%' : ''})`);
  }
  console.log(`  ambiguous (title shared by several employers), reported only: ${plan.ambiguous.length}`);
  for (const { row, twins } of plan.ambiguous) {
    console.log(`    ${String(row.title).slice(0, 46).padEnd(46)} ~ ${[...new Set(twins.map((t) => t.company))].join(', ')}`);
  }
  console.log(`  submitted through the middleman, left as history: ${plan.submitted.length}`);
  for (const { row, onto } of plan.submitted) {
    console.log(`    ${String(row.submitted_at).slice(0, 10)}  ${String(row.title).slice(0, 46).padEnd(46)} = ${onto.company} (${onto.status})`);
  }
  console.log(`  kept, no named twin in the queue: ${plan.kept.length}`);

  if (write) {
    if (!token) { console.log('\nCF_D1_TOKEN is not set. Nothing written.'); process.exit(1); }
    let n = 0;
    for (const { row, onto } of plan.collapse) {
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          sql: `UPDATE jobs SET status = 'skipped', blocked_reason = ?, blocked_detail = ?, blocked_at = ?,
                rank_pct = NULL, pay_tier = NULL WHERE dedupe_key = ? AND status = 'queued'`,
          params: [DUPLICATE_REASON, `Jobgether relisting of ${onto.company}: ${onto.url}`.slice(0, 400), new Date().toISOString(), row.dedupe_key]
        })
      });
      const out = await res.json();
      if (out.success) n++; else console.log('    D1 error:', out.errors?.[0]?.message);
    }
    console.log(`\ncollapsed ${n} relisting(s)`);
  } else {
    console.log('\nDRY RUN. Nothing written. Add --write.');
  }
}
