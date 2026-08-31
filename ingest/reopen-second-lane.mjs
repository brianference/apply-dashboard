/**
 * Deciding which rows the retired $180k-top rule should give back.
 *
 * Pure functions only -- `ingest/regate.mjs` is the runner that fetches rows,
 * reads descriptions and writes to D1. Splitting it this way is what lets the
 * dangerous part be tested: a reopen is a REVERSAL, and reversing a rejection
 * by re-checking only the rule that changed silently reverses everything that
 * rule cannot see. `decideReopen` therefore takes a gate VERDICT, never a
 * salary figure, so a caller cannot pass it a salary-only check by accident.
 */

/** Reasons the retired top-under-$180k rule used to write into blocked_detail. */
export const RETIRED_SALARY_REASONS = [
  'under the $180k floor (second tier)',
  'below the $160k second tier'
];

const STATUS_SKIPPED = 'skipped';
const STATUS_QUEUED = 'queued';

/**
 * Was this skip written by the rule Brian retired on 2026-08-31?
 *
 * @param {string|null|undefined} blockedDetail
 * @returns {boolean}
 */
export function matchesRetiredSalarySkip(blockedDetail) {
  const detail = String(blockedDetail || '');
  return RETIRED_SALARY_REASONS.some((r) => detail.includes(r));
}

/**
 * What to do with one candidate row, given the verdict of the FULL gate.
 *
 * @param {{status?: string, dedupe_key: string}} row
 * @param {{ok: boolean, reasons?: string[]}} gate the whole gate, not the salary rule
 * @returns {{action: 'reopen'|'keep-skip'|'leave', reasons: string[]}}
 */
export function decideReopen(row, gate) {
  /* A submitted row is history. Re-queueing one would rewrite what happened. */
  if (!row || row.status !== STATUS_SKIPPED) return { action: 'leave', reasons: [] };
  if (gate && gate.ok) return { action: 'reopen', reasons: [] };
  return { action: 'keep-skip', reasons: (gate && gate.reasons) || [] };
}

/**
 * Put a row back on the queue. rank_pct stays NULL so the next ranking pass
 * scores it fresh rather than restoring a number computed under the old rule.
 *
 * @param {{dedupe_key: string}} row
 * @returns {{sql: string, params: Array<string|number|null>}}
 */
export function reopenWrite(row) {
  return {
    sql: `UPDATE jobs SET status = ?, blocked_reason = NULL, blocked_detail = NULL,
      blocked_at = NULL, rank_pct = NULL, pay_tier = NULL
      WHERE dedupe_key = ? AND status = ?`,
    params: [STATUS_QUEUED, row.dedupe_key, STATUS_SKIPPED]
  };
}

/**
 * Keep a row skipped, but record why it is STILL out under today's rules
 * rather than leaving the retired reason on it.
 *
 * @param {{dedupe_key: string}} row
 * @param {string[]} reasons
 * @returns {{sql: string, params: Array<string|number|null>}}
 */
export function stillRejectedWrite(row, reasons) {
  return {
    sql: 'UPDATE jobs SET blocked_detail = ? WHERE dedupe_key = ? AND status = ?',
    params: [(reasons || []).join('; ').slice(0, 400), row.dedupe_key, STATUS_SKIPPED]
  };
}
