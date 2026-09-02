/**
 * A cached board index must expire.
 *
 * `gh-index.json` maps a Greenhouse job id to its board. It was written once
 * and reused forever: on 2026-09-02 the file on Brian's machine had been built
 * on 2026-08-26, so every posting published in those seven days resolved to no
 * board, `fetchJd` returned null, and the row arrived with no description, no
 * published salary and no domain rules applied. MongoDB's Client Libraries
 * posting sat at 76% with a $126,000 start that would have ruled it out.
 *
 * CI never saw it, because `ingest/out` is gitignored and a runner rebuilds the
 * index every run. A bug that is invisible where it is checked and wrong where
 * it is used needs a test that does not depend on either.
 *
 * Run: node ingest/test-index-freshness.mjs
 */
import { indexIsFresh, GH_INDEX_MAX_AGE_MS } from './fit-score.mjs';

const failures = [];
const check = (pass, what, detail = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${what.padEnd(58)} ${detail}`);
  if (!pass) failures.push(what);
};

const NOW = Date.parse('2026-09-02T18:00:00.000Z');
const hours = (n) => n * 60 * 60 * 1000;

check(indexIsFresh(NOW - hours(1), NOW), 'an index written an hour ago is used');
check(indexIsFresh(NOW - hours(5.9), NOW), 'just inside the window is used');
check(!indexIsFresh(NOW - hours(6.1), NOW), 'just outside the window is rebuilt');

/* The real failure, to the hour. */
const AUG26 = Date.parse('2026-08-26T20:29:00.000Z');
check(!indexIsFresh(AUG26, NOW),
  'the seven-day-old index that lost MongoDB is refused',
  `${Math.round((NOW - AUG26) / hours(24))} days old`);

/* A clock that moved backwards, or a filesystem that reports nonsense, must
   not read as fresh. Rebuilding costs a minute; trusting it cost seven days. */
check(!indexIsFresh(NOW + hours(2), NOW), 'a future mtime is refused, not trusted');
check(!indexIsFresh(NaN, NOW), 'an unreadable mtime is refused');
check(!indexIsFresh(NOW - hours(1), NaN), 'an unreadable clock is refused');

check(GH_INDEX_MAX_AGE_MS < hours(12),
  'the window is shorter than the gap between scheduled runs',
  `${GH_INDEX_MAX_AGE_MS / hours(1)}h vs 12h`);

console.log(failures.length
  ? `\n${failures.length} FAILED`
  : '\na stale board index is refused, and a fresh one is used');
process.exit(failures.length ? 1 : 0);
