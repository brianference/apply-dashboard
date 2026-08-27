/**
 * The order the applier works the queue in.
 *
 * This lived inline in batch.mjs and broke on 2026-08-27, silently. The
 * dashboard was rebuilt to rank on `rank_pct` -- a score that reads the real
 * job description and Brian's actual record -- and `match_pct`, the old title
 * keyword count that had never read either, was retired from the page. The
 * applier kept sorting on `match_pct`. Measured against the live queue that
 * morning, the top ten the applier would work and the top ten the page shows
 * shared ONE posting, and seven of the applier's ten had `rank_pct` null:
 * their description was never fetched, so no salary, location or role rule was
 * ever checked against it. The applier was preferring exactly the postings
 * nothing had verified.
 *
 * It is a separate module because batch.mjs runs its campaign at import time;
 * a comparator that cannot be imported cannot be tested, and this one was
 * wrong for a day with every test green.
 */

/**
 * How likely a posting's ATS is to actually complete a submission.
 *
 * Measured, not guessed: Ashby and Greenhouse produced 22 of the first 24
 * confirmed submissions, and Workday and iCIMS produced none.
 * @param {string} url
 * @returns {number} lower is worked first
 */
export function familyRank(url) {
  const u = String(url || '');
  if (/ashbyhq/i.test(u)) return 0;
  if (/greenhouse/i.test(u)) return 1;
  if (/lever\.co/i.test(u)) return 2;
  if (/workable|smartrecruiters/i.test(u)) return 3;
  return 4;
}

/**
 * Compare two postings for the apply queue.
 *
 * Family first, then the ranked postings in `rank_pct` order, then the
 * unranked ones. An unranked posting is not a low-scoring posting: it is one
 * whose description was never read, so it goes BEHIND every ranked posting
 * however high its old keyword score was. `match_pct` only breaks ties among
 * postings that are equally unranked, purely so the order is deterministic.
 *
 * @param {{url?:string, rank_pct?:number|null, match_pct?:number|null}} a
 * @param {{url?:string, rank_pct?:number|null, match_pct?:number|null}} b
 * @returns {number}
 */
export function compareCandidates(a, b) {
  const f = familyRank(a.url) - familyRank(b.url);
  if (f) return f;
  const ar = a.rank_pct == null ? null : Number(a.rank_pct);
  const br = b.rank_pct == null ? null : Number(b.rank_pct);
  if (ar == null && br != null) return 1;
  if (br == null && ar != null) return -1;
  if (ar != null && br != null && ar !== br) return br - ar;
  return (Number(b.match_pct) || 0) - (Number(a.match_pct) || 0);
}
