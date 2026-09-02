/**
 * Brian's freshness rule, 2026-09-02: hide a posting when it is over 30 days
 * old AND its employer refresh is over 30 days.
 *
 * A literal 30-day cut on `posted` throws away live jobs. Pinterest "Product
 * Manager II, Content Compliance" was first published 103 days ago and
 * refreshed one day ago. GitLab "Principal Product Manager, AI Custom Models"
 * is 97 days old, refreshed yesterday. Cohere "Product Manager, Platform
 * Experience" is 174 days old, refreshed yesterday. Those must stay.
 *
 * This is a LENS over the list, the way meetsFloor / Under $180k already
 * work, not a gate that clears rank_pct. A stale posting is still a real
 * posting Brian might want to see; the employer may refresh it next week.
 *
 *   import { STALE_AFTER_DAYS, isStale } from './stale.mjs'
 */

/**
 * Whole days after which a posting is stale, if its refresh is also older.
 *
 * One named constant so the page, the tests and the chip cannot disagree
 * about "30". An off-by-one on a boundary nobody wrote down is how these
 * rules rot.
 *
 * @type {number}
 */
export const STALE_AFTER_DAYS = 30;

/**
 * Whole calendar days between an ISO / date-only value and local midnight
 * of `now`. Same rules as the Posted column: date-only strings are local
 * dates (Date.parse would treat them as UTC and shift a day west of UTC),
 * a future value clamps to 0, missing or unparseable returns null.
 *
 * @param {unknown} value
 * @param {Date} [now]
 * @returns {number|null}
 */
export function daysSince(value, now = new Date()) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  if (!raw) return null;
  let valueMidnight;
  const dayOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (dayOnly) {
    valueMidnight = new Date(+dayOnly[1], +dayOnly[2] - 1, +dayOnly[3]).getTime();
  } else {
    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) return null;
    const d = new Date(parsed);
    valueMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }
  if (!Number.isFinite(valueMidnight)) return null;
  const nowMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = Math.round((nowMidnight - valueMidnight) / 86400000);
  if (days < 0) return 0;
  return days;
}

/**
 * Is this posting stale under Brian's rule?
 *
 * Stale means posted age is OVER STALE_AFTER_DAYS and refresh age is also
 * over that threshold. Exactly 30 days is not over 30, so it stays -- the
 * boundary is `>`, not `>=`.
 *
 * An unknown refresh keeps the row. Dropping a row because our own ingest
 * lacks a field is the mistake that lost 36 published salaries today, and
 * it must not be repeated as a feature. "No refresh date" is distinguishable
 * from "refreshed long ago" the same way salary_checked_at distinguishes
 * "never checked" from "checked, publishes nothing".
 *
 * A row with no `posted` date at all cannot be judged and stays.
 *
 * @param {Record<string, unknown>|null|undefined} job
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isStale(job, now = new Date()) {
  const postedAge = daysSince(job && job.posted, now);
  if (postedAge == null) return false;
  if (postedAge <= STALE_AFTER_DAYS) return false;
  const refreshAge = daysSince(job && job.refreshed_at, now);
  /* Unknown refresh keeps the row. Our ingest missing a field is not a
     reason to hide a posting -- that is how 36 published salaries vanished
     today, and this rule must not repeat it. */
  if (refreshAge == null) return false;
  return refreshAge > STALE_AFTER_DAYS;
}

/**
 * True when the row is on the default list only because the employer
 * refreshed it -- posted age is over the threshold, refresh is not.
 * Used for the Posted column title so "103d ago" is not read as dead.
 *
 * @param {Record<string, unknown>|null|undefined} job
 * @param {Date} [now]
 * @returns {boolean}
 */
export function keptBecauseRefreshed(job, now = new Date()) {
  const postedAge = daysSince(job && job.posted, now);
  if (postedAge == null || postedAge <= STALE_AFTER_DAYS) return false;
  const refreshAge = daysSince(job && job.refreshed_at, now);
  return refreshAge != null && refreshAge <= STALE_AFTER_DAYS;
}
