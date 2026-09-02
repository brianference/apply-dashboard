/**
 * Fail the daily run if a Greenhouse, Ashby or Lever posting is about to go
 * out with no employer refresh date.
 *
 * Without `refreshed_at`, the stale lens treats every row as "refresh
 * unknown" and keeps it. Unknown refresh then becomes the normal case and
 * the 30-day rule quietly stops hiding anything -- the same failure mode as
 * a published salary that ingest never stored. 40 of 72 older queued rows
 * could not be judged today for exactly this reason: we store no refresh
 * date for anything.
 *
 * Resolved by URL (`boardRef`), never by the `source` label. MinIO's
 * "Sr. AI Product Manager" is source "builtin" and a Greenhouse URL.
 *
 *   node ingest/refresh-audit.mjs
 */

import { isCli } from './cli.mjs';
import { boardRef } from './fit-score.mjs';

const API = 'https://apply-dashboard.pages.dev/api/jobs';
const ON_THE_LIST = new Set(['queued', 'pending-review']);
const DATED_ATS = new Set(['greenhouse', 'ashby', 'lever']);

/**
 * Does this row already carry an employer refresh date?
 *
 * Failing input: refreshed_at = "" used to look stored. Empty is unknown,
 * the same as null -- that is the distinction salary_checked_at exists
 * to preserve.
 *
 * @param {Record<string, any>|null|undefined} row
 * @returns {boolean}
 */
export function hasRefreshDate(row) {
  const value = row && row.refreshed_at;
  return value != null && String(value).trim() !== '';
}

/**
 * Rows on the list whose URL is a Greenhouse, Ashby or Lever board and that
 * do not carry refreshed_at. Empty means the ingest is writing what it
 * should. A LinkedIn / Workday / aggregator URL is not a failure -- those
 * boards do not publish a refresh date we can store.
 *
 * @param {Array<Record<string, any>>} rows
 * @returns {Array<Record<string, any>>}
 */
export function missingRefresh(rows) {
  const lost = [];
  for (const row of rows || []) {
    if (!ON_THE_LIST.has(row && row.status)) continue;
    const ref = boardRef(row.url);
    if (!ref || !DATED_ATS.has(ref.ats)) continue;
    if (hasRefreshDate(row)) continue;
    lost.push(row);
  }
  return lost;
}

if (isCli(import.meta.url)) {
  const live = await (await fetch(API, { headers: { 'cache-control': 'no-cache' } })).json();
  const rows = live.jobs || [];
  const lost = missingRefresh(rows);
  const examined = rows.filter((r) => {
    if (!ON_THE_LIST.has(r.status)) return false;
    const ref = boardRef(r.url);
    return ref && DATED_ATS.has(ref.ats);
  }).length;
  if (lost.length) {
    process.stdout.write(
      `FAIL  ${lost.length} greenhouse/ashby/lever row(s) on the list have no refreshed_at `
      + `(${examined} dated-board rows on the list)\n`
    );
    for (const row of lost.slice(0, 25)) {
      process.stdout.write(
        `  ${row.company} | ${row.title} | ${row.url}\n`
      );
    }
    if (lost.length > 25) {
      process.stdout.write(`  ... and ${lost.length - 25} more\n`);
    }
    process.exit(1);
  }
  process.stdout.write(
    `ok    ${examined} greenhouse/ashby/lever rows on the list, all carry refreshed_at\n`
  );
}
