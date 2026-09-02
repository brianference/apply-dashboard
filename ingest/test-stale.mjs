/**
 * The 30-day stale lens has to be able to FAIL.
 *
 * A posting 103 days old that the employer refreshed yesterday is a live
 * job (Pinterest "Product Manager II, Content Compliance"). A cut on
 * `posted` alone throws it away. Each case below is an input chosen to
 * fail one specific branch; a suite that only ever saw fresh jobs would
 * still pass if isStale always returned false.
 *
 *   node ingest/test-stale.mjs
 */

import { STALE_AFTER_DAYS, daysSince, isStale, keptBecauseRefreshed } from './stale.mjs';

let bad = 0;
/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(name, ok, detail) {
  if (!ok) bad += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(name).padEnd(72)} ${detail || ''}`);
}

/* Fixed "today" so a suite run near midnight cannot flip a boundary. */
const NOW = new Date(2026, 8, 2, 15, 0, 0); /* 2026-09-02 local */

/**
 * Date-only string `n` whole days before NOW. Date-only so daysSince does
 * not depend on the timezone Date.parse would assume for a full ISO stamp.
 *
 * @param {number} n
 * @returns {string}
 */
function daysAgo(n) {
  const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - n);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

check('STALE_AFTER_DAYS is 30, not inlined in the cases', STALE_AFTER_DAYS === 30, String(STALE_AFTER_DAYS));

check('daysSince(31d) is 31', daysSince(daysAgo(31), NOW) === 31, String(daysSince(daysAgo(31), NOW)));
check('daysSince(30d) is 30', daysSince(daysAgo(30), NOW) === 30, String(daysSince(daysAgo(30), NOW)));
check('daysSince(missing) is null', daysSince(null, NOW) === null);
check('daysSince("") is null', daysSince('', NOW) === null);

const pinterest = { posted: daysAgo(31), refreshed_at: daysAgo(2) };
check('31 days old, refreshed 2 days ago: KEPT (the Pinterest case)',
  isStale(pinterest, NOW) === false,
  `isStale=${isStale(pinterest, NOW)}`);
check('that Pinterest row is kept because it was refreshed, not because it is new',
  keptBecauseRefreshed(pinterest, NOW) === true);

const dead = { posted: daysAgo(31), refreshed_at: daysAgo(40) };
check('31 days old, refreshed 40 days ago: HIDDEN',
  isStale(dead, NOW) === true,
  `isStale=${isStale(dead, NOW)}`);
check('a hidden row is not "kept because refreshed"',
  keptBecauseRefreshed(dead, NOW) === false);

const unknown = { posted: daysAgo(31), refreshed_at: null };
check('31 days old, refresh unknown: KEPT -- ingest missing a field must not hide the row',
  isStale(unknown, NOW) === false,
  `isStale=${isStale(unknown, NOW)}`);
check('unknown refresh is not "kept because refreshed" -- we never saw a refresh',
  keptBecauseRefreshed(unknown, NOW) === false);

const unknownEmpty = { posted: daysAgo(31), refreshed_at: '' };
check('31 days old, refresh empty string: KEPT, same as missing -- not "refreshed long ago"',
  isStale(unknownEmpty, NOW) === false);

const fresh = { posted: daysAgo(10), refreshed_at: null };
check('10 days old, no refresh: KEPT',
  isStale(fresh, NOW) === false);

const noPosted = { posted: null, refreshed_at: daysAgo(40) };
check('no posted date at all: KEPT -- cannot be judged',
  isStale(noPosted, NOW) === false);

const noPostedNoRefresh = { posted: null, refreshed_at: null };
check('no posted and no refresh: KEPT',
  isStale(noPostedNoRefresh, NOW) === false);

/* Exactly 30 days is not over 30. The rule is age > STALE_AFTER_DAYS, not
   >= . An off-by-one on a boundary nobody wrote down is how these rules rot. */
const onBoundary = { posted: daysAgo(30), refreshed_at: daysAgo(40) };
check('exactly 30 days old, even with a 40-day refresh: KEPT (over 30, not >= 30)',
  isStale(onBoundary, NOW) === false,
  `postedAge=${daysSince(onBoundary.posted, NOW)} isStale=${isStale(onBoundary, NOW)}`);
check('exactly 30 days of refresh, with a 31-day posted age: KEPT (refresh is not over 30)',
  isStale({ posted: daysAgo(31), refreshed_at: daysAgo(30) }, NOW) === false);

const evergreen = { posted: daysAgo(1972), refreshed_at: daysAgo(500) };
check('Binance-class evergreen (1972d posted, 500d refresh): HIDDEN',
  isStale(evergreen, NOW) === true);

check('isStale({}) is false, not a throw', isStale({}, NOW) === false);
check('isStale(null) is false, not a throw', isStale(null, NOW) === false);

console.log(bad
  ? `\n${bad} FAILED`
  : '\nstale lens keeps a 31d posting refreshed 2d ago, hides one refreshed 40d ago, and keeps unknown refresh');
process.exitCode = bad ? 1 : 0;
