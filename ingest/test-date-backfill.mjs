/**
 * The date backfill has to refuse to overwrite posted, and has to resolve
 * by URL rather than the source label.
 *
 *   node ingest/test-date-backfill.mjs
 */

import { needsDates, mergeDates, readFreshGreenhouseIndex } from './date-backfill.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

const MINIO = {
  status: 'queued',
  source: 'builtin',
  url: 'https://job-boards.greenhouse.io/minio/jobs/5239488008',
  posted: null,
  refreshed_at: null
};

check('a builtin-labelled greenhouse URL is a candidate -- resolve by URL, not source',
  needsDates(MINIO) === true);

check('a LinkedIn URL is not a candidate even when dates are missing',
  needsDates({
    status: 'queued',
    url: 'https://www.linkedin.com/jobs/view/1',
    posted: null,
    refreshed_at: null
  }) === false);

check('a greenhouse URL that already has both dates is not a candidate',
  needsDates({ ...MINIO, posted: '2026-01-01', refreshed_at: '2026-09-01' }) === false);

check('a greenhouse URL missing only refreshed_at is a candidate',
  needsDates({ ...MINIO, posted: '2026-01-01', refreshed_at: null }) === true);

check('a skipped row is not a candidate',
  needsDates({ ...MINIO, status: 'skipped' }) === false);

check('a greenhouse URL with only ?gh_jid= is still a candidate -- the CLI may resolve the token from the existing index',
  needsDates({
    status: 'queued',
    url: 'https://www.mongodb.com/careers/job/?gh_jid=8143805',
    posted: null,
    refreshed_at: null
  }) === true);

const idxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-idx-'));
try {
  fs.writeFileSync(path.join(idxDir, 'gh-index.json'), '{"8143805":"mongodb"}');
  const recent = Date.now() - 60 * 60 * 1000;
  fs.utimesSync(path.join(idxDir, 'gh-index.json'), new Date(recent), new Date(recent));
  const idx = readFreshGreenhouseIndex(idxDir);
  check('a one-hour-old index is read, not rebuilt',
    idx != null && idx['8143805'] === 'mongodb');
} finally {
  fs.rmSync(idxDir, { recursive: true, force: true });
}
const missingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-idx-miss-'));
try {
  check('a missing index is null, not invented',
    readFreshGreenhouseIndex(missingDir) === null);
} finally {
  fs.rmSync(missingDir, { recursive: true, force: true });
}

const merged = mergeDates(
  { posted: '2026-05-22T12:00:00.000Z', refreshed_at: null },
  { posted: '2026-09-01T12:00:00.000Z', refreshed_at: '2026-09-01T12:00:00.000Z' }
);
check('mergeDates does not overwrite an existing posted with the refresh date',
  merged.posted === '2026-05-22T12:00:00.000Z' && merged.postedFilled === false,
  `posted=${merged.posted}`);
check('mergeDates fills a missing refreshed_at',
  merged.refreshed_at === '2026-09-01T12:00:00.000Z' && merged.refreshFilled === true);

const both = mergeDates(
  { posted: null, refreshed_at: null },
  { posted: '2026-05-22T12:00:00.000Z', refreshed_at: '2026-09-01T12:00:00.000Z' }
);
check('mergeDates fills both when both are missing',
  both.postedFilled && both.refreshFilled
    && both.posted === '2026-05-22T12:00:00.000Z'
    && both.refreshed_at === '2026-09-01T12:00:00.000Z');

const emptyBoard = mergeDates(
  { posted: null, refreshed_at: null },
  { posted: null, refreshed_at: null }
);
check('a board that publishes no date leaves both null, not a guess',
  emptyBoard.posted === null && emptyBoard.refreshed_at === null
    && emptyBoard.postedFilled === false && emptyBoard.refreshFilled === false);

console.log(bad
  ? `\n${bad} FAILED`
  : '\nbackfill resolves by URL, fills blanks, and will not overwrite posted');
process.exitCode = bad ? 1 : 0;
