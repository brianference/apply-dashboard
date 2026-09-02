/**
 * First-published vs last-updated, per board.
 *
 * `posted` is when the employer FIRST published the requisition. `refreshed_at`
 * is when they last touched it. Collapsing those into one field is how a
 * Pinterest role first published 103 days ago and refreshed yesterday would
 * look like a 1-day-old posting, or -- if we kept only first-published --
 * like a dead one. Brian needs to see both.
 *
 * A source that does not publish a refresh date writes nothing rather than
 * guessing. Null is "unknown", not "refreshed long ago".
 */

import { isoFromUnknown } from './jobs.mjs';

/**
 * Greenhouse list-jobs entry: first_published stays on `posted`, updated_at
 * becomes `refreshed_at`. Do not fall back posted to updated_at -- that is
 * how the two questions used to get mixed.
 *
 * @param {Record<string, unknown>|null|undefined} job
 * @returns {{ posted: string|null, refreshed_at: string|null }}
 */
export function datesFromGreenhouse(job) {
  return {
    posted: isoFromUnknown(job && job.first_published),
    refreshed_at: isoFromUnknown(job && job.updated_at)
  };
}

/**
 * Ashby job-board entry: publishedAt is first published. updatedAt is the
 * refresh, falling back to publishedAt when the board omits a separate
 * update field -- that fallback is a date the board actually sent, not a
 * guess.
 *
 * @param {Record<string, unknown>|null|undefined} job
 * @returns {{ posted: string|null, refreshed_at: string|null }}
 */
export function datesFromAshby(job) {
  const posted = isoFromUnknown(job && job.publishedAt);
  const refreshed = isoFromUnknown(job && job.updatedAt);
  return {
    posted,
    refreshed_at: refreshed || posted
  };
}

/**
 * Lever posting: createdAt is first published (epoch milliseconds).
 * updatedAt is the refresh, also epoch milliseconds. isoFromUnknown
 * already converts both. No fallback -- a Lever row with no updatedAt
 * keeps refreshed_at null.
 *
 * @param {Record<string, unknown>|null|undefined} job
 * @returns {{ posted: string|null, refreshed_at: string|null }}
 */
export function datesFromLever(job) {
  return {
    posted: isoFromUnknown(job && job.createdAt),
    refreshed_at: isoFromUnknown(job && job.updatedAt)
  };
}

/**
 * Dates from a raw board job, once we know which ATS it is.
 *
 * @param {'greenhouse'|'ashby'|'lever'|string} ats
 * @param {Record<string, unknown>|null|undefined} job
 * @returns {{ posted: string|null, refreshed_at: string|null }}
 */
export function datesFromBoardJob(ats, job) {
  if (ats === 'greenhouse') return datesFromGreenhouse(job);
  if (ats === 'ashby') return datesFromAshby(job);
  if (ats === 'lever') return datesFromLever(job);
  return { posted: null, refreshed_at: null };
}

/**
 * Pull the job id the board itself published, for matching a URL's boardRef.
 *
 * @param {'greenhouse'|'ashby'|'lever'|string} ats
 * @param {Record<string, unknown>|null|undefined} job
 * @returns {string|null}
 */
export function boardJobId(ats, job) {
  if (!job || job.id == null) return null;
  return String(job.id);
}

/**
 * Jobs array from a board list payload, per ATS shape.
 *
 * @param {'greenhouse'|'ashby'|'lever'|string} ats
 * @param {unknown} payload
 * @returns {Array<Record<string, unknown>>}
 */
export function jobsFromBoardPayload(ats, payload) {
  if (ats === 'greenhouse' || ats === 'ashby') {
    const jobs = payload && /** @type {{jobs?: unknown}} */ (payload).jobs;
    return Array.isArray(jobs) ? jobs : [];
  }
  if (ats === 'lever') {
    return Array.isArray(payload) ? payload : [];
  }
  return [];
}

/**
 * Find one job on a board payload by the id in the posting URL.
 *
 * @param {'greenhouse'|'ashby'|'lever'|string} ats
 * @param {unknown} payload
 * @param {string} id
 * @returns {Record<string, unknown>|null}
 */
export function findBoardJob(ats, payload, id) {
  const want = String(id || '');
  if (!want) return null;
  for (const job of jobsFromBoardPayload(ats, payload)) {
    if (boardJobId(ats, job) === want) return job;
  }
  return null;
}
