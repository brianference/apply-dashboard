/**
 * What a ledger entry is evidence OF.
 *
 * batch.mjs blocks a posting on any recorded state it does not know to be
 * retryable. That rule is right for a verdict about the posting and wrong for
 * a rehearsal: a dry run records `dry-run-ok` and so permanently retired every
 * posting it rehearsed, including the two highest-ranked jobs in the queue on
 * 2026-08-27. Kept here so it can be imported and tested -- batch.mjs runs its
 * campaign at import time.
 */

/** States that describe a REHEARSAL rather than a decision about the posting. */
export const NOT_A_VERDICT = new Set(['dry-run-ok']);

/**
 * Is this recorded state evidence about the posting itself?
 * @param {string|null|undefined} state
 * @returns {boolean} false when the entry only records that a dry run happened
 */
export function isVerdict(state) {
  const s = String(state || '');
  return s !== '' && !NOT_A_VERDICT.has(s);
}

/**
 * Should a `needs-answers` entry be reopened?
 *
 * The form refused the submit and named the fields it still needed. That is a
 * verdict about the ANSWERS available that day, not about the posting, so it
 * has to reopen the moment the answer bank changes -- otherwise writing the
 * answer changes nothing and the row stays retired forever.
 *
 * @param {{state?:string, answers?:string}|null|undefined} entry
 * @param {string} currentHash fingerprint of the answer bank right now
 * @returns {boolean}
 */
export function reopensOnAnswers(entry, currentHash) {
  if (!entry || String(entry.state || '') !== 'needs-answers') return false;
  return entry.answers !== currentHash;
}

/**
 * Does the crash cap still apply to this posting?
 *
 * A crash is evidence about the DRIVER, not the posting -- the same reasoning
 * the wd-* states already get. On 2026-08-27 a full-page screenshot timed out
 * at the default 30s on four consecutive Ashby postings while the machine was
 * busy; each timeout threw out of the run and was recorded as `crashed`, and
 * the cap then retired Aiwyn, Teamworks and Fieldguide permanently. Three good
 * postings were lost to a slow PNG. When the driver changes, an old crash count
 * is a stale verdict and the posting gets its attempts back.
 *
 * @param {{crashCount?:number, driver?:string}|null|undefined} entry
 * @param {string} driverHash fingerprint of the driver about to run
 * @param {number} [cap] attempts allowed before a posting is retired
 * @returns {boolean} true when the posting has burned its attempts on THIS driver
 */
export function crashCapApplies(entry, driverHash, cap = 2) {
  if (!entry) return false;
  if ((entry.crashCount || 0) < cap) return false;
  return entry.driver === driverHash;
}
