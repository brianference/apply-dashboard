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

import fs from 'node:fs';
import { rowsToCheck, UNRESOLVED_PATH } from '../../ingest/liveness.mjs';

const API = 'https://apply-dashboard.pages.dev/api/jobs';
const OLD_DAYS = 21;
const BATCH = 80;
const RUN_MS = 12 * 3600 * 1000;

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
/* Rows on a board API are ingest/liveness.mjs's job, twice a day and without a
   browser, so the browser's 80 are spent on hosts nothing else can check, and first on
   the board rows that step could not settle this run. */
const onBoard = new Set(rowsToCheck(payload.jobs).map((entry) => entry.row.dedupe_key));
let unresolved = [];
try {
  unresolved = JSON.parse(fs.readFileSync(UNRESOLVED_PATH, 'utf8')).jobs || [];
} catch { /* the liveness step did not run or failed; the rest of the cohort still stands */ }
const queued = (payload.jobs || []).filter((r) => r && r.status === 'queued' && r.url && !onBoard.has(r.dedupe_key));

const noPay = (r) => r.salary_min == null;
const old = (r) => { const a = ageDays(r); return a !== null && a >= OLD_DAYS; };
const byAge = (a, b) => (ageDays(b) ?? 1e6) - (ageDays(a) ?? 1e6);

const ordered = [
  ...queued.filter((r) => noPay(r) && old(r)).sort(byAge),
  ...queued.filter((r) => noPay(r) && !old(r)),
  ...queued.filter((r) => !noPay(r) && old(r)).sort(byAge)
];

/* The workflow takes the first 80. A fixed order meant the same 80 every run, and
   a row further down was never opened. Starting each run one batch further on
   walks the whole list, without storing anything between runs. */
const start = ordered.length ? (Math.floor(Date.now() / RUN_MS) * BATCH) % ordered.length : 0;
const rotated = [...ordered.slice(start), ...ordered.slice(0, start)];

process.stdout.write(JSON.stringify({
  jobs: [...unresolved, ...rotated].map((r) => ({ url: r.url, dedupe_key: r.dedupe_key }))
}, null, 1));
