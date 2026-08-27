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
