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
import { fetchBoardPayload } from './date-backfill.mjs';
import { findBoardJob, datesFromBoardJob } from './board-dates.mjs';

const API = 'https://apply-dashboard.pages.dev/api/jobs';
const ON_THE_LIST = new Set(['queued', 'pending-review']);
/* Boards that actually publish a LAST-UPDATED date.
 *
 * Lever is deliberately absent. Its public posting API
 * (api.lever.co/v0/postings/<board>/<id>) returns `createdAt` and nothing
 * else -- verified 2026-09-02 against Filevine 916bb302 and Binance 89632468,
 * both HTTP 200, both carrying `createdAt` as their only date field. The spec
 * that produced this audit asserted Lever had `updatedAt`; it does not, and an
 * audit demanding a field the board never sends is a lane that can only ever
 * be red. `posted` still comes from Lever's createdAt, so a Lever row is aged
 * normally and simply never counts as refreshed. */
const DATED_ATS = new Set(['greenhouse', 'ashby']);

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

/**
 * Of the rows with no refresh date, the ones the board STILL LISTS.
 *
 * A posting the employer has taken down cannot be filled by any backfill, and
 * failing the run for it makes a lane that is red for a reason nobody can act
 * on. That is how a red lane stops being read. This asks the board, so the
 * audit fails only where the date is genuinely gettable and was not got.
 *
 * @param {Array<Record<string, any>>} lost rows already known to lack a date
 * @param {(ats: string, token: string) => Promise<any>} [fetchPayload] injectable so
 *   the classification can be tested without a network call
 * @returns {Promise<{fillable: Array<Record<string, any>>, delisted: number, unreachable: number}>}
 */
export async function stillOnTheBoard(lost, fetchPayload = fetchBoardPayload) {
  const payloads = new Map();
  const fillable = [];
  let delisted = 0;
  let unreachable = 0;
  for (const row of lost) {
    const ref = boardRef(row.url);
    if (!ref || !ref.token) { unreachable += 1; continue; }
    const key = `${ref.ats}:${ref.token}`;
    if (!payloads.has(key)) {
      try { payloads.set(key, await fetchPayload(ref.ats, ref.token)); }
      catch { payloads.set(key, null); }
    }
    const payload = payloads.get(key);
    if (!payload) { unreachable += 1; continue; }
    const job = findBoardJob(ref.ats, payload, ref.id);
    if (!job) { delisted += 1; continue; }
    const dates = datesFromBoardJob(ref.ats, job);
    if (dates && dates.refreshed_at) fillable.push(row);
    else delisted += 1;
  }
  return { fillable, delisted, unreachable };
}

if (isCli(import.meta.url)) {
  const live = await (await fetch(API, { headers: { 'cache-control': 'no-cache' } })).json();
  const rows = live.jobs || [];
  const candidates = missingRefresh(rows);
  const { fillable, delisted, unreachable } = await stillOnTheBoard(candidates);
  const lost = fillable;
  process.stdout.write(
    `info  ${candidates.length} row(s) carry no refreshed_at: `
    + `${fillable.length} still on the board and fillable, `
    + `${delisted} no longer listed or undated, ${unreachable} board unreachable
`
  );
  const examined = rows.filter((r) => {
    if (!ON_THE_LIST.has(r.status)) return false;
    const ref = boardRef(r.url);
    return ref && DATED_ATS.has(ref.ats);
  }).length;
  if (lost.length) {
    process.stdout.write(
      `FAIL  ${lost.length} greenhouse/ashby row(s) on the list have no refreshed_at `
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
    `ok    ${examined} greenhouse/ashby rows on the list, all carry refreshed_at\n`
  );
}
