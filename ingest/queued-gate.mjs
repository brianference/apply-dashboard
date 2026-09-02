/**
 * Re-run the whole gate over queued rows that are already in the database.
 *
 * A rule that only runs on newly ingested rows leaves yesterday's queue
 * stale. Teamworks "Senior Product Success Manager I" sat in the queue after
 * roleEligible started rejecting "product success", because nothing re-ran
 * the role rule against rows that were already there. The same is true of
 * every rule added from now on.
 *
 * Pure functions only -- `ingest/regate.mjs` is the runner that fetches rows,
 * reads descriptions and writes to D1.
 *
 * A submitted row is history and is never rewritten. An unreadable
 * description is unknown, not disqualifying: 114 queued rows currently have
 * no cached JD, and treating a missing file as a fail would empty a third
 * of the list.
 */

import { requirementsGate } from './fit-score.mjs';

const STATUS_QUEUED = 'queued';
const STATUS_SKIPPED = 'skipped';
const STATUS_SUBMITTED = 'submitted';
const BLOCKED_REASON = 'off-criteria';

/**
 * What to do with one row, given the cached description (or null if it
 * could not be read).
 *
 * The gate still runs when jd is null, because role, location, employer
 * and title-first domains do not need a description -- that is how
 * Teamworks is caught even when the JD file is missing. Description-based
 * rules simply do not fire when jd is null. What we must not do is treat
 * the missing file itself as a reason to skip.
 *
 * @param {{status?: string, dedupe_key?: string, title?: string, company?: string, work_type?: string}} row
 * @param {string|null|undefined} jd
 * @returns {{action: 'skip'|'leave', reasons: string[], excludedDomain: string|null}}
 */
export function decideQueuedGate(row, jd) {
  /* A submitted row is history. Dropping it here is what keeps it out of
     the write list; the WHERE clause also refuses it if a caller forgets. */
  if (!row || row.status !== STATUS_QUEUED) {
    return { action: 'leave', reasons: [], excludedDomain: null };
  }
  const gate = requirementsGate(row, jd || null);
  if (!gate || gate.ok) {
    return { action: 'leave', reasons: [], excludedDomain: null };
  }
  return {
    action: 'skip',
    reasons: gate.reasons || [],
    excludedDomain: gate.excludedDomain || null
  };
}

/**
 * The UPDATE that skips one queued row the whole gate now rejects.
 * Parameterised. The WHERE clause refuses a submitted row even if the
 * caller forgot to filter. rank_pct and pay_tier are cleared the way the
 * employer and domain writes do, so a ruled-out row cannot keep a number
 * that put it on the list.
 *
 * @param {{dedupe_key: string}} row
 * @param {{reasons?: string[], excludedDomain?: string|null}} decision
 * @returns {{sql: string, params: Array<string|number|null>}}
 */
export function queuedGateWrite(row, decision) {
  return {
    sql: `UPDATE jobs SET status = ?, blocked_reason = ?, blocked_detail = ?,
      excluded_domain = ?, blocked_at = ?,
      rank_pct = NULL, pay_tier = NULL
      WHERE dedupe_key = ? AND status != ?`,
    params: [
      STATUS_SKIPPED,
      BLOCKED_REASON,
      (decision.reasons || []).join('; ').slice(0, 400),
      decision.excludedDomain || null,
      new Date().toISOString(),
      row.dedupe_key,
      STATUS_SUBMITTED
    ]
  };
}
