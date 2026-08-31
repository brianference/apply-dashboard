/**
 * Skip every non-submitted row whose company is on the blocked-employer list.
 *
 * Kept as its own script, not folded into reopen-second-lane.mjs: reopen
 * selects skipped rows that failed a retired salary rule, while this selects
 * every open row at a blocked employer, including ones still queued. The
 * submitted Coinbase row is history and is never rewritten.
 *
 *   node ingest/apply-employer-block.mjs          # report only
 *   node ingest/apply-employer-block.mjs --write  # apply
 */

import { isCli, parseArgs } from './cli.mjs';
import { logInfo, logWarn } from './logger.mjs';
import {
  BLOCKED_EMPLOYERS,
  employerBlockReason,
  findBlockedEmployer
} from './blocked-employers.mjs';

const API = 'https://apply-dashboard.pages.dev/api/jobs';
const ACCOUNT = 'dd01b432f0329f87bb1cc1a3fad590ee';
const DATABASE = '10e8a6c0-1fa7-4c33-a007-2044876ce6a7';
const STATUS_SKIPPED = 'skipped';
const STATUS_SUBMITTED = 'submitted';
const BLOCKED_REASON = 'off-criteria';

/**
 * Non-submitted rows whose company matches a blocked employer.
 *
 * A submitted row is history: even if it is handed in, it is dropped here
 * so a later write cannot rewrite it.
 *
 * @param {Array<Record<string, any>>} rows
 * @param {typeof BLOCKED_EMPLOYERS} [list]
 * @returns {Array<{row: Record<string, any>, blocked: {name: string, match: string, reason: string}}>}
 */
export function rowsToBlock(rows, list = BLOCKED_EMPLOYERS) {
  const out = [];
  for (const row of rows || []) {
    if ((row && row.status) === STATUS_SUBMITTED) continue;
    const blocked = findBlockedEmployer(row && row.company, list);
    if (!blocked) continue;
    out.push({ row, blocked });
  }
  return out;
}

/**
 * The UPDATE that skips one blocked-employer row. Parameterised. The WHERE
 * clause refuses a submitted row even if the caller forgot to filter.
 *
 * @param {{dedupe_key: string}} row
 * @param {{name: string, reason: string}} blocked
 * @returns {{sql: string, params: Array<string|number|null>}}
 */
export function employerBlockWrite(row, blocked) {
  return {
    sql: `UPDATE jobs SET status = ?, blocked_reason = ?, blocked_detail = ?,
      rank_pct = NULL, pay_tier = NULL
      WHERE dedupe_key = ? AND status != ?`,
    params: [
      STATUS_SKIPPED,
      BLOCKED_REASON,
      employerBlockReason(blocked),
      row.dedupe_key,
      STATUS_SUBMITTED
    ]
  };
}

/**
 * Run one statement against D1.
 *
 * @param {string} token
 * @param {string} sql
 * @param {Array<string|number|null>} [params]
 * @returns {Promise<object>}
 */
async function d1(token, sql, params) {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(params === undefined ? { sql } : { sql, params })
    }
  );
  const json = await r.json();
  if (!json.success) throw new Error(JSON.stringify(json.errors));
  return json;
}

if (isCli(import.meta.url)) {
  const args = parseArgs();
  const doWrite = !!args.write;
  const live = await fetch(API, { headers: { 'cache-control': 'no-cache' } }).then((r) => r.json());
  const jobs = live.jobs || [];
  const submittedProtected = jobs.filter((job) =>
    job.status === STATUS_SUBMITTED && findBlockedEmployer(job.company)
  );
  const toBlock = rowsToBlock(jobs);

  logInfo('employer-block report', {
    examined: jobs.length,
    wouldSkip: toBlock.length,
    submittedLeftAlone: submittedProtected.length,
    byEmployer: toBlock.reduce((acc, item) => {
      acc[item.blocked.name] = (acc[item.blocked.name] || 0) + 1;
      return acc;
    }, {})
  });

  if (!doWrite) {
    logWarn('nothing written', { hint: 'pass --write to skip blocked-employer rows' });
  } else {
    const token = process.env.CF_D1_TOKEN || '';
    if (!token) {
      logWarn('CF_D1_TOKEN is not set', {});
      process.exit(1);
    }
    let wrote = 0;
    for (const item of toBlock) {
      const w = employerBlockWrite(item.row, item.blocked);
      await d1(token, w.sql, w.params);
      wrote += 1;
    }
    logInfo('written to D1', { skipped: wrote, submittedLeftAlone: submittedProtected.length });
  }
}
