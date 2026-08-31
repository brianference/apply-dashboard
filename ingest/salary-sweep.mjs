/**
 * Read the pay band off the destination posting for EVERY row, and rule out
 * anything whose published band starts below the floor.
 *
 * This exists because of a job Brian caught himself. "Sr. Product Manager -
 * Skylar Analytics" sat at the top of his list at 83 percent with no salary
 * recorded, and its Lever posting says, in the description the pipeline had
 * already downloaded and scored against:
 *
 *     Base salary: $135,000-$155,000 annually.
 *
 * Twenty-five thousand under the floor. The row carried `jd_read: yes`, so the
 * text was in hand; the extractor in salary-from-posting.mjs parses that exact
 * string correctly; and 184 of 201 clear queued rows had no band at all. The
 * extractor existed, the text existed, and no code connected them - salary
 * extraction lived in a separate script nobody ran, while the ranking pass read
 * the same description for a different purpose and threw the pay line away.
 *
 * A missing band is treated as UNKNOWN, never as acceptable. That rule is
 * correct and stays; what was wrong is how often the band was missing when the
 * posting published one.
 *
 *   node ingest/salary-sweep.mjs                  # report only
 *   node ingest/salary-sweep.mjs --write          # write bands and rule-outs
 *   node ingest/salary-sweep.mjs --limit 50
 *   node ingest/salary-sweep.mjs --refetch        # ignore the JD cache
 */

import fs from 'node:fs';
import path from 'node:path';
import { isCli, parseArgs } from './cli.mjs';
import { logInfo, logWarn } from './logger.mjs';
import { fetchJd, payTier } from './fit-score.mjs';
import { salaryFromText } from './salary-from-posting.mjs';
import { ensurePayColumns } from './pay-columns.mjs';

/* Re-exported so existing importers keep working; the definition lives in
   pay-columns.mjs because fit-score needs it too and cannot import this. */
export { ensurePayColumns } from './pay-columns.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname)
  .replace(/^\/([A-Za-z]:)/, '$1'), '..');
const API = 'https://apply-dashboard.pages.dev/api/jobs';
const ACCOUNT = 'dd01b432f0329f87bb1cc1a3fad590ee';
const DATABASE = '10e8a6c0-1fa7-4c33-a007-2044876ce6a7';

/** Brian's floor. A band whose START is under this fails, however high its top. */
export const FLOOR = 160000;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Board API bodies shorter than this are not treated as the posting. */
const BOARD_TEXT_MIN = 200;

/** `via` values that mean we actually read a posting. */
const FETCH_OK_VIA = ['page', 'board-api'];



/**
 * Strip tags and collapse whitespace, so a band split across markup still reads
 * as one line to the extractor.
 * @param {string} html
 * @returns {string}
 */
export function textOf(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Is this band acceptable?
 *
 * Null is UNKNOWN, not acceptable and not a failure - it is a gap in what we
 * know, and the row stays with a flag rather than being silently dropped or
 * silently kept as though it had cleared.
 *
 * @param {{min: number|null, max: number|null}} band
 * @param {number} [floor]
 * @returns {"ok"|"below-floor"|"unknown"}
 */
export function judgeBand(band, floor = FLOOR) {
  if (!band || band.min == null) return 'unknown';
  return band.min < floor ? 'below-floor' : 'ok';
}

/**
 * Does this board-API body already contain a published start, so the page
 * fetch can be skipped?
 *
 * @param {string|null} text
 * @returns {boolean}
 */
export function boardTextHasBand(text) {
  if (!text || String(text).length <= BOARD_TEXT_MIN) return false;
  const band = salaryFromText(text);
  return !!(band && band.min != null);
}

/**
 * Did this fetch actually reach a posting, so salary_checked_at can be stamped.
 * A 404 is not a check; a page that loaded and published no band is.
 *
 * Allowlist, not denylist. Failing inputs: `page-502`, `page-429`, `page-400`,
 * `page-408` and an empty `via` used to stamp salary_checked_at because the
 * old suffix list never named them.
 *
 * `via: 'board-api'` is also returned when the page fetch fails but a
 * band-less board body exists (`postingText`). That is a board-API read,
 * which IS a real check, so the allowlist keeps it -- it reads like a page
 * check that never happened.
 *
 * @param {string} via
 * @returns {boolean}
 */
export function fetchSucceeded(via) {
  return FETCH_OK_VIA.includes(String(via || ''));
}

/**
 * How many rows a D1 statement actually changed.
 *
 * Failing input: an UPDATE against a missing `dedupe_key` returns success
 * with `meta.changes = 0` and must not increment wroteBands.
 *
 * @param {any} response
 * @returns {number}
 */
export function d1Changes(response) {
  const meta = (response && response.result && response.result[0] && response.result[0].meta)
    || (response && response.meta)
    || null;
  const n = meta && meta.changes;
  return Number.isFinite(Number(n)) ? Number(n) : 0;
}

/**
 * The UPDATE that records a published band. If the row already has a rank,
 * recompute its pay lane from the NEW band in the same statement. An
 * unranked row has no lane -- `pay_tier` is left as-is when `rank_pct`
 * is NULL.
 *
 * Failing input: a ranked row whose sweep finds $190,000-$220,000 must
 * write pay_tier = 1, not leave pay_tier = 2.
 *
 * @param {{band: {min: number, max: number|null}, via: string, dedupe_key: string}} r
 * @param {string} checkedAt
 * @returns {{sql: string, params: Array<string|number|null>}}
 */
export function bandWrite(r, checkedAt) {
  const lane = payTier({ salary_min: r.band.min, salary_max: r.band.max });
  return {
    sql: `UPDATE jobs SET salary_min = ?, salary_max = ?, salary_source = ?, salary_checked_at = ?,
      pay_tier = CASE WHEN rank_pct IS NOT NULL THEN ? ELSE pay_tier END
      WHERE dedupe_key = ?`,
    params: [r.band.min, r.band.max, 'posting:' + r.via, checkedAt, lane, r.dedupe_key]
  };
}

/**
 * Stamp salary_checked_at on a successful fetch that published no band.
 *
 * @param {{dedupe_key: string}} r
 * @param {string} checkedAt
 * @returns {{sql: string, params: Array<string|number|null>}}
 */
export function checkedWrite(r, checkedAt) {
  return {
    sql: 'UPDATE jobs SET salary_checked_at = ? WHERE dedupe_key = ?',
    params: [checkedAt, r.dedupe_key]
  };
}

/**
 * The UPDATE that rules a below-floor row out. Matches rankWrite's gate-fail
 * branch: status skipped, rank_pct NULL, pay_tier NULL. A submitted row is
 * history and is never passed here.
 *
 * Failing input: a ranked row whose sweep finds $135,000-$155,000 must not
 * keep its old rank_pct and pay_tier.
 *
 * @param {{band: {min: number}, dedupe_key: string}} r
 * @returns {{sql: string, params: Array<string|number|null>}}
 */
export function belowFloorWrite(r) {
  return {
    sql: `UPDATE jobs SET blocked_reason = ?, blocked_detail = ?,
      status = ?, rank_pct = NULL, pay_tier = NULL
      WHERE dedupe_key = ?`,
    params: [
      'off-criteria',
      `published band starts at $${r.band.min}, under the $${FLOOR} floor`,
      'skipped',
      r.dedupe_key
    ]
  };
}


/**
 * The posting text for a row: the board API when it is a board we can read
 * AND that text already has a published band; otherwise the destination page.
 *
 * Board-API-first used to return as soon as the board body was long enough,
 * even when it contained no pay line. The page often has the band the board
 * API stripped. The page is not fetched when the board text already produced
 * a band.
 *
 * @param {{url: string}} job
 * @param {boolean} refetch
 * @returns {Promise<{text: string|null, via: string}>}
 */
export async function postingText(job, refetch = false) {
  let boardText = null;
  if (!refetch) {
    boardText = await fetchJd(job.url).catch(() => null);
    if (boardTextHasBand(boardText)) return { text: boardText, via: 'board-api' };
  }
  try {
    const res = await fetch(job.url, {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(25000)
    });
    if (!res.ok) {
      if (boardText && boardText.length > BOARD_TEXT_MIN) return { text: boardText, via: 'board-api' };
      return { text: null, via: `page-${res.status}` };
    }
    const body = await res.text();
    return { text: textOf(body), via: 'page' };
  } catch (error) {
    if (boardText && boardText.length > BOARD_TEXT_MIN) return { text: boardText, via: 'board-api' };
    return { text: null, via: 'page-error' };
  }
}

if (isCli(import.meta.url)) {
  const args = parseArgs();
  const limit = args.limit === undefined || args.limit === true ? Infinity : Number(args.limit);
  const doWrite = !!args.write;
  const refetch = !!args.refetch;

  const live = await fetch(API, { headers: { 'cache-control': 'no-cache' } }).then((r) => r.json());
  /* Every row, not only the queued ones. A submitted row with a band we never
     read is still a number Brian should be able to see. */
  const rows = (live.jobs || []).filter((j) => j.url).slice(0, Number.isFinite(limit) ? limit : undefined);
  logInfo('sweeping', { rows: rows.length, refetch, write: doWrite });

  const results = [];
  let done = 0;
  for (const job of rows) {
    const { text, via } = await postingText(job, refetch);
    const band = text ? salaryFromText(text) : { min: null, max: null };
    const verdict = judgeBand(band);
    results.push({ ...job, band, verdict, via });
    done += 1;
    if (verdict === 'below-floor') {
      logInfo('below floor', { company: job.company, title: String(job.title).slice(0, 50), band: `${band.min}-${band.max}`, via });
    }
    if (done % 25 === 0) logInfo('progress', { done, of: rows.length });
  }

  const found = results.filter((r) => r.band.min != null);
  const below = results.filter((r) => r.verdict === 'below-floor');
  const unknown = results.filter((r) => r.verdict === 'unknown');
  const byVia = {};
  for (const r of results) byVia[r.via] = (byVia[r.via] || 0) + 1;

  logInfo('sweep complete', {
    rows: results.length,
    bandFound: found.length,
    belowFloor: below.length,
    unknown: unknown.length,
    fetchedVia: byVia
  });

  const out = path.join(ROOT, 'ingest', 'out', 'salary-sweep.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    generated_at: new Date().toISOString(), floor: FLOOR,
    rows: results.map((r) => ({
      dedupe_key: r.dedupe_key, company: r.company, title: r.title, url: r.url,
      salary_min: r.band.min, salary_max: r.band.max, verdict: r.verdict, via: r.via
    }))
  }, null, 2));
  logInfo('wrote report', { file: path.relative(ROOT, out) });

  if (!doWrite) {
    logWarn('nothing written', { hint: 'pass --write to record bands and rule-outs' });
  } else {
    const token = process.env.CF_D1_TOKEN;
    if (!token) {
      logWarn('CF_D1_TOKEN is not set', {});
      process.exit(1);
    }
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
    const checkedAt = new Date().toISOString();
    let wroteBands = 0;
    let wroteChecked = 0;
    let ruledOut = 0;
    /* Per-row failures are collected, not thrown.

       This loop used to let the first rejected UPDATE escape, which abandoned
       every remaining write. Nine rows held match_pct = '' instead of NULL,
       and SQLite compares text as greater than any integer, so '' > 100 is
       TRUE and the range trigger rejected any update to them. The sweep
       reported "205 bands found", wrote seven, and exited zero. The count it
       printed was what it had MEASURED, not what it had SAVED, and nothing
       connected the two. */
    const writeFailures = [];
    const writeUnchanged = [];
    for (const r of results) {
      if (r.band.min != null) {
        try {
          const w = bandWrite(r, checkedAt);
          const res = await run(w.sql, w.params);
          if (d1Changes(res) > 0) {
            wroteBands += 1;
            wroteChecked += 1;
          } else {
            writeUnchanged.push({ dedupe_key: r.dedupe_key, what: 'band' });
          }
        } catch (error) {
          writeFailures.push({ dedupe_key: r.dedupe_key, what: 'band', error: String(error.message || error).slice(0, 160) });
        }
      } else if (fetchSucceeded(r.via)) {
        /* A successful fetch that found no band is still a check. Leaving
           salary_checked_at NULL made "crawled, publishes nothing" look
           identical to "never crawled". Do not invent a band. */
        try {
          const w = checkedWrite(r, checkedAt);
          const res = await run(w.sql, w.params);
          if (d1Changes(res) > 0) {
            wroteChecked += 1;
          } else {
            writeUnchanged.push({ dedupe_key: r.dedupe_key, what: 'checked' });
          }
        } catch (error) {
          writeFailures.push({ dedupe_key: r.dedupe_key, what: 'checked', error: String(error.message || error).slice(0, 160) });
        }
      }
      /* Rule out only what is BELOW the floor and still open. A submitted row
         is history: marking it off-criteria now would rewrite what happened. */
      if (r.verdict === 'below-floor' && r.status !== 'submitted') {
        try {
          const w = belowFloorWrite(r);
          const res = await run(w.sql, w.params);
          if (d1Changes(res) > 0) {
            ruledOut += 1;
          } else {
            writeUnchanged.push({ dedupe_key: r.dedupe_key, what: 'rule-out' });
          }
        } catch (error) {
          writeFailures.push({ dedupe_key: r.dedupe_key, what: 'rule-out', error: String(error.message || error).slice(0, 160) });
        }
      }
    }
    logInfo('written to D1', {
      bands: wroteBands, checked: wroteChecked, ruledOut,
      failed: writeFailures.length, unchanged: writeUnchanged.length
    });
    /* Loud, and non-zero. A sweep that measured more than it saved has not
       done its job, and saying so beats a green run that quietly did less. */
    if (writeFailures.length || writeUnchanged.length) {
      for (const f of writeFailures.slice(0, 10)) logWarn('write rejected', f);
      for (const u of writeUnchanged.slice(0, 10)) logWarn('write changed nothing', u);
      logWarn('some rows were measured but not saved', {
        measured: found.length, saved: wroteBands,
        failed: writeFailures.length, unchanged: writeUnchanged.length
      });
      process.exitCode = 1;
    }
  }
}
