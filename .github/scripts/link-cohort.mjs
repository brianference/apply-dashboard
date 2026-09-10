/**
 * Emit the link-check cohort: the queued rows most likely to hold a dead URL.
 *
 * A separate file because a heredoc inside a workflow `run:` block is banned
 * here, and because the choice of cohort is a decision worth reading.
 *
 * Brian named the two groups on 2026-09-10: older jobs, and ones with no pay
 * listed. He had already found and removed three by hand. Rows with BOTH go
 * first, because a posting nobody priced and nobody refreshed is the one most
 * likely to have been pulled.
 *
 *   node .github/scripts/link-cohort.mjs > cohort.json
 */

const API = 'https://apply-dashboard.pages.dev/api/jobs';
const OLD_DAYS = 21;

/**
 * @param {{ posted: string|null }} row
 * @returns {number|null} days since publication, or null when undated
 */
function ageDays(row) {
  if (!row || !row.posted) return null;
  const then = new Date(row.posted).getTime();
  if (Number.isNaN(then)) return null;
  return Math.floor((Date.now() - then) / 86400000);
}

const payload = await (await fetch(API, { headers: { 'cache-control': 'no-cache' } })).json();
const queued = (payload.jobs || []).filter((r) => r && r.status === 'queued' && r.url);

const noPay = (r) => r.salary_min == null;
const old = (r) => { const a = ageDays(r); return a !== null && a >= OLD_DAYS; };
const byAge = (a, b) => (ageDays(b) ?? 1e6) - (ageDays(a) ?? 1e6);

const ordered = [
  ...queued.filter((r) => noPay(r) && old(r)).sort(byAge),
  ...queued.filter((r) => noPay(r) && !old(r)),
  ...queued.filter((r) => !noPay(r) && old(r)).sort(byAge)
];

process.stdout.write(JSON.stringify({
  jobs: ordered.map((r) => ({ url: r.url, dedupe_key: r.dedupe_key }))
}, null, 1));
