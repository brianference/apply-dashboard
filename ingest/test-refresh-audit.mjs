/**
 * The refresh audit has to be able to FAIL.
 *
 * A Greenhouse URL with no refreshed_at is the whole reason the audit
 * exists. If this file only ever saw rows that already had a refresh date,
 * an ingest that never wrote the column would still look green, and the
 * stale lens would keep every old row because refresh is "unknown".
 *
 *   node ingest/test-refresh-audit.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { missingRefresh, hasRefreshDate } from './refresh-audit.mjs';

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

const GH = {
  status: 'queued',
  company: 'MinIO',
  title: 'Sr. AI Product Manager',
  url: 'https://job-boards.greenhouse.io/minio/jobs/5239488008',
  refreshed_at: null,
  posted: null
};

const ASHBY = {
  status: 'queued',
  company: 'Tremendous',
  title: 'Senior Product Manager - Special Projects',
  url: 'https://jobs.ashbyhq.com/tremendous/9be1cf09-1eb7-4aa7-8bc4-4848cc124fb8',
  refreshed_at: null
};

const LEVER = {
  status: 'queued',
  company: 'airSlate',
  title: 'AI Product Manager',
  url: 'https://jobs.lever.co/airslate/5e6dec30-136f-4d26-91f4-ff2ac33ea167',
  refreshed_at: null
};

const LINKEDIN = {
  status: 'queued',
  company: 'Acme',
  title: 'Product Manager',
  url: 'https://www.linkedin.com/jobs/view/123',
  refreshed_at: null
};

check('FAILS when a greenhouse URL on the list has no refreshed_at',
  missingRefresh([GH]).length === 1 && missingRefresh([GH])[0].url === GH.url,
  `n=${missingRefresh([GH]).length}`);

check('FAILS for an ashby URL with no refreshed_at',
  missingRefresh([ASHBY]).length === 1);

/* Lever is NOT audited, and that is the point of this case rather than an
   omission. Its public posting API returns `createdAt` and nothing else --
   verified 2026-09-02 against Filevine 916bb302 and Binance 89632468, both
   HTTP 200 with `createdAt` as their only date field. The spec that produced
   this audit asserted Lever published `updatedAt`. It does not, and demanding
   a field the board never sends makes a lane that can only ever be red. If
   Lever ever adds one, this case is what has to change first. */
check('a lever URL is not audited: the board publishes createdAt only',
  missingRefresh([LEVER]).length === 0);

check('a LinkedIn URL with no refresh is not this audit -- we cannot store what the board does not publish',
  missingRefresh([LINKEDIN]).length === 0);

check('PASSES when refreshed_at is stored',
  missingRefresh([{ ...GH, refreshed_at: '2026-09-01T00:00:00.000Z' }]).length === 0);

check('a skipped greenhouse row is off the list, so a missing refresh there is not this audit',
  missingRefresh([{ ...GH, status: 'skipped' }]).length === 0);

check('pending-review is on the list and is audited',
  missingRefresh([{ ...GH, status: 'pending-review' }]).length === 1);

check('source label is ignored: a builtin-labelled greenhouse URL is still audited',
  missingRefresh([{ ...GH, source: 'builtin' }]).length === 1);

check('hasRefreshDate treats empty string as missing, not stored',
  hasRefreshDate({ refreshed_at: '' }) === false);
check('hasRefreshDate treats whitespace as missing',
  hasRefreshDate({ refreshed_at: '  ' }) === false);
check('hasRefreshDate({refreshed_at: iso}) is true',
  hasRefreshDate({ refreshed_at: '2026-09-01T00:00:00.000Z' }) === true);

const src = fs.readFileSync(
  path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), 'refresh-audit.mjs'),
  'utf8'
);
check('the audit CLI calls process.exit(1) when any row is missing a refresh date',
  /if\s*\(\s*lost\.length\s*\)/.test(src) && /process\.exit\(\s*1\s*\)/.test(src));


/* ---- the board check itself ----------------------------------------------
   Added after the audit was made to ask the board before failing. Without
   these cases the board check was an unverified branch deciding whether CI
   goes red, which is the shape of every green-forever check this repo has
   found. The fetcher is injected so no network call is involved. */
const { stillOnTheBoard } = await import('./refresh-audit.mjs');

const GH_LIVE = { status: 'queued', company: 'A', title: 'a',
  url: 'https://job-boards.greenhouse.io/acme/jobs/111' };
const GH_GONE = { status: 'queued', company: 'B', title: 'b',
  url: 'https://job-boards.greenhouse.io/acme/jobs/999' };
const GH_DEAD_BOARD = { status: 'queued', company: 'C', title: 'c',
  url: 'https://job-boards.greenhouse.io/nosuch/jobs/222' };

const fakeBoard = async (ats, token) => {
  if (token === 'nosuch') throw new Error('board fetch failed');
  return { jobs: [{ id: 111, updated_at: '2026-09-01T00:00:00-04:00' }] };
};

const live = await stillOnTheBoard([GH_LIVE], fakeBoard);
check('a row the board still lists WITH a date is a real failure',
  live.fillable.length === 1 && live.delisted === 0,
  `fillable=${live.fillable.length}`);

const gone = await stillOnTheBoard([GH_GONE], fakeBoard);
check('a row the board no longer lists is not a failure',
  gone.fillable.length === 0 && gone.delisted === 1,
  `delisted=${gone.delisted}`);

const dead = await stillOnTheBoard([GH_DEAD_BOARD], fakeBoard);
check('an unreachable board is not a failure, and is counted separately',
  dead.fillable.length === 0 && dead.unreachable === 1,
  `unreachable=${dead.unreachable}`);

const mixed = await stillOnTheBoard([GH_LIVE, GH_GONE, GH_DEAD_BOARD], fakeBoard);
check('the three outcomes account for every row, with none double-counted',
  mixed.fillable.length + mixed.delisted + mixed.unreachable === 3,
  `${mixed.fillable.length}+${mixed.delisted}+${mixed.unreachable}`);

console.log(bad
  ? `\n${bad} FAILED`
  : '\nthe audit fails when a greenhouse/ashby/lever row would go out with no refreshed_at, and only then');
process.exitCode = bad ? 1 : 0;
