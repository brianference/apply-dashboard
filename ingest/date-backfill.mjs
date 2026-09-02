/**
 * Fill `posted` (first published) and `refreshed_at` (last updated) on rows
 * that are missing them, by asking the employer's board -- never by guessing
 * from the `source` label.
 *
 * 115 queued rows had no `posted` today. 64 of those URLs are greenhouse,
 * ashby or lever boards (MinIO "Sr. AI Product Manager" is source "builtin"
 * and a greenhouse URL). A 30-day stale rule cannot judge a row with no
 * posted date, so those 64 stay visible until this fills them.
 *
 * Resolves by URL via `boardRef`. In-memory board cache for this run only --
 * `gh-index.json` was reused for seven days and every Greenhouse posting
 * published in between resolved to no board. This file does not write an
 * index.
 *
 *   node ingest/date-backfill.mjs            # dry (default)
 *   node ingest/date-backfill.mjs --dry      # same
 *   node ingest/date-backfill.mjs --write    # apply
 */

import fs from 'node:fs';
import path from 'node:path';
import { isCli, parseArgs } from './cli.mjs';
import { fetchJson } from './http.mjs';
import { boardRef, indexIsFresh } from './fit-score.mjs';
import { datesFromBoardJob, findBoardJob } from './board-dates.mjs';
import { ensurePayColumns } from './pay-columns.mjs';

const API = 'https://apply-dashboard.pages.dev/api/jobs';
const ACCOUNT = 'dd01b432f0329f87bb1cc1a3fad590ee';
const DATABASE = '10e8a6c0-1fa7-4c33-a007-2044876ce6a7';
const ON_THE_LIST = new Set(['queued', 'pending-review']);
const DATED_ATS = new Set(['greenhouse', 'ashby', 'lever']);

const BOARD_URL = {
  greenhouse: (token) =>
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs`,
  ashby: (token) =>
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}`,
  lever: (token) =>
    `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`
};

/**
 * True when this row is missing posted or refreshed_at and its URL is a
 * board we can read. Token-less greenhouse (`?gh_jid=` with no board in
 * the path) is still a candidate: the CLI resolves the token from the
 * existing 6-hour index if that file is fresh. This module does not
 * write an index of its own.
 *
 * @param {Record<string, any>|null|undefined} row
 * @returns {boolean}
 */
export function needsDates(row) {
  if (!row || !ON_THE_LIST.has(row.status)) return false;
  const missingPosted = row.posted == null || String(row.posted).trim() === '';
  const missingRefresh = row.refreshed_at == null || String(row.refreshed_at).trim() === '';
  if (!missingPosted && !missingRefresh) return false;
  const ref = boardRef(row.url);
  if (!ref || !DATED_ATS.has(ref.ats)) return false;
  if (!ref.token && ref.ats !== 'greenhouse') return false;
  return true;
}

/**
 * Read the existing Greenhouse id-to-board index if it is still fresh.
 * Returns null rather than rebuilding -- writing ingest/out is how a
 * seven-day-old index quietly became the source of truth last time.
 *
 * @param {string} cacheDir
 * @returns {Record<string, string>|null}
 */
export function readFreshGreenhouseIndex(cacheDir) {
  const idxFile = path.join(cacheDir, 'gh-index.json');
  if (!fs.existsSync(idxFile)) return null;
  try {
    if (!indexIsFresh(fs.statSync(idxFile).mtimeMs, Date.now())) return null;
    const parsed = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Fill only the blanks. Never overwrite an existing `posted` with a refresh
 * date -- those two answer different questions, and a 103-day-old role
 * refreshed yesterday has to keep both numbers.
 *
 * @param {Record<string, any>} row
 * @param {{ posted: string|null, refreshed_at: string|null }} dates
 * @returns {{ posted: string|null, refreshed_at: string|null, postedFilled: boolean, refreshFilled: boolean }}
 */
export function mergeDates(row, dates) {
  const missingPosted = row.posted == null || String(row.posted).trim() === '';
  const missingRefresh = row.refreshed_at == null || String(row.refreshed_at).trim() === '';
  const posted = missingPosted ? (dates && dates.posted) || null : row.posted;
  const refreshed_at = missingRefresh ? (dates && dates.refreshed_at) || null : row.refreshed_at;
  return {
    posted,
    refreshed_at,
    postedFilled: missingPosted && posted != null,
    refreshFilled: missingRefresh && refreshed_at != null
  };
}

/**
 * Fetch one board list. Failures return null so a single unreachable board
 * cannot abort the rest of the walk.
 *
 * @param {string} ats
 * @param {string} token
 * @returns {Promise<unknown|null>}
 */
export async function fetchBoardPayload(ats, token) {
  const build = BOARD_URL[ats];
  if (!build) return null;
  try {
    return await fetchJson(build(token));
  } catch {
    return null;
  }
}

if (isCli(import.meta.url)) {
  const args = parseArgs();
  const doWrite = !!args.write;
  const token = process.env.CF_D1_TOKEN || '';
  if (doWrite && !token) {
    process.stdout.write('CF_D1_TOKEN is not set, so --write would change nothing.\n');
    process.exit(1);
  }

  const live = await (await fetch(API, { headers: { 'cache-control': 'no-cache' } })).json();
  const rows = live.jobs || [];
  const queued = rows.filter((r) => r.status === 'queued');
  const missingPosted = queued.filter((r) => r.posted == null || String(r.posted).trim() === '');
  const candidates = rows.filter(needsDates);

  const byAts = { greenhouse: 0, ashby: 0, lever: 0 };
  for (const row of candidates) {
    const ref = boardRef(row.url);
    if (ref && byAts[ref.ats] != null) byAts[ref.ats] += 1;
  }

  process.stdout.write(`queued rows: ${queued.length}\n`);
  process.stdout.write(`queued with no posted: ${missingPosted.length}\n`);
  process.stdout.write(
    `candidates (on the list, URL is greenhouse/ashby/lever, missing posted or refreshed_at): ${candidates.length}\n`
  );
  process.stdout.write(
    `  greenhouse ${byAts.greenhouse}  ashby ${byAts.ashby}  lever ${byAts.lever}\n`
  );

  const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname)
    .replace(/^\/([A-Za-z]:)/, '$1'), '..');
  const ghIndex = readFreshGreenhouseIndex(path.join(ROOT, 'ingest', 'out', 'jd-cache'));
  const cache = new Map();
  const summary = {
    filledPosted: 0,
    filledRefresh: 0,
    boardHadNoDate: 0,
    boardMiss: 0,
    fetchFailed: 0,
    unchanged: 0,
    noToken: 0
  };
  /** @type {Array<{dedupe_key: string, posted: string|null, refreshed_at: string|null}>} */
  const writes = [];

  for (const row of candidates) {
    const ref = boardRef(row.url);
    if (ref.ats === 'greenhouse' && !ref.token) {
      ref.token = (ghIndex && ghIndex[ref.id]) || null;
    }
    if (!ref.token) {
      summary.noToken += 1;
      continue;
    }
    const key = `${ref.ats}::${ref.token}`;
    let payload;
    if (cache.has(key)) {
      payload = cache.get(key);
    } else {
      payload = await fetchBoardPayload(ref.ats, ref.token);
      cache.set(key, payload);
    }
    if (payload == null) {
      summary.fetchFailed += 1;
      continue;
    }
    const job = findBoardJob(ref.ats, payload, ref.id);
    if (!job) {
      summary.boardMiss += 1;
      continue;
    }
    const dates = datesFromBoardJob(ref.ats, job);
    const merged = mergeDates(row, dates);
    if (!merged.postedFilled && !merged.refreshFilled) {
      if ((dates.posted == null) && (dates.refreshed_at == null)) summary.boardHadNoDate += 1;
      else summary.unchanged += 1;
      continue;
    }
    if (merged.postedFilled) summary.filledPosted += 1;
    if (merged.refreshFilled) summary.filledRefresh += 1;
    writes.push({
      dedupe_key: row.dedupe_key,
      posted: merged.posted,
      refreshed_at: merged.refreshed_at
    });
  }

  process.stdout.write(`would fill posted: ${summary.filledPosted}\n`);
  process.stdout.write(`would fill refreshed_at: ${summary.filledRefresh}\n`);
  process.stdout.write(`board had the job but published no date: ${summary.boardHadNoDate}\n`);
  process.stdout.write(`job id not on the board: ${summary.boardMiss}\n`);
  process.stdout.write(`board fetch failed: ${summary.fetchFailed}\n`);
  process.stdout.write(`already had the dates the board sent: ${summary.unchanged}\n`);
  process.stdout.write(`greenhouse URL had no board token and no fresh index: ${summary.noToken}\n`);
  process.stdout.write(`rows to write: ${writes.length}\n`);

  if (!doWrite) {
    process.stdout.write('\nDRY RUN. Nothing written. Re-run with --write to apply.\n');
  } else {
    /** @param {string} sql @param {Array<string|number|null>} [params] */
    const run = async (sql, params = []) => {
      const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ sql, params })
      });
      const j = await r.json();
      if (!j.success) throw new Error(JSON.stringify(j.errors));
      return j;
    };
    await ensurePayColumns(run);
    let wrote = 0;
    for (const row of writes) {
      await run(
        'UPDATE jobs SET posted = ?, refreshed_at = ? WHERE dedupe_key = ? AND submitted_at IS NULL',
        [row.posted, row.refreshed_at, row.dedupe_key]
      );
      wrote += 1;
    }
    process.stdout.write(`wrote ${wrote} rows to D1\n`);
  }
}
