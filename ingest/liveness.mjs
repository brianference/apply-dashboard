/**
 * Close queued rows whose posting the employer has taken down.
 *
 * Measured 2026-11-03: a dry run over the 490 queued Greenhouse, Lever and Ashby
 * rows found about half gone from both the board API and the posting page.
 * Nothing re-checked a row once it was ranked. link-check drives a browser over
 * 80 rows a run, always the same first 80 of a fixed order, and the description
 * reader only runs on unranked rows.
 *
 * These three boards answer plain fetches, so every queued row on them can be
 * re-checked twice a day with no browser. A row closes only when TWO independent
 * signals agree, the board API and the posting page:
 *
 *   API gone, page gone      close
 *   API gone, page live      keep. Shield AI's Lever API answered 404 for a
 *                            posting whose page still served it.
 *   anything unknown         keep. A 403, a 429, a 5xx or a timeout is the board
 *                            refusing to talk, which says nothing about the job.
 *
 * Closing goes through closedWrite so there is one write path, and its WHERE
 * clause refuses a submitted row. A row this file closed is re-checked on later
 * runs and returns to the queue if both signals say it came back, because a
 * wrongly-retired row is one Brian never sees again. Rows closed by anything
 * else are not reopened: this file cannot see why they were closed.
 *
 * Rows it cannot settle are written to UNRESOLVED_PATH, and link-cohort sends
 * them to the browser check. Careers-page URLs carrying ?gh_jid= name no board
 * token, so they stay with link-check from the start, along with every other host.
 *
 * PUBLIC REPO WARNING: --quiet prints counts only, because CI logs are
 * world-readable and which jobs are on Brian's list is not public.
 *
 *   node ingest/liveness.mjs                       report only
 *   CF_D1_TOKEN=... node ingest/liveness.mjs --write --quiet
 *   CF_D1_TOKEN=... node ingest/liveness.mjs --write --max-close 400
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCli, parseArgs } from './cli.mjs';
import { closedWrite } from './closed-check.mjs';
import { boardRef } from './fit-score.mjs';
import { fetchText, mapPool } from './http.mjs';
import { logInfo, logWarn } from './logger.mjs';

const API = 'https://apply-dashboard.pages.dev/api/jobs';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const CONCURRENCY = 4;
const RETRY_WAIT_MS = 2_000;
const SELF_CHECK_TRIES = 5;

/** Read by .github/scripts/link-cohort.mjs in the same job. Gitignored, never uploaded. */
export const UNRESOLVED_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out', 'liveness-unresolved.json');

/**
 * Closes allowed in one run. The two signals guard against a misread posting;
 * this bounds the damage if both break together, such as a board returning 404
 * for everything. Over the cap the rest wait for the next run, so a real wave
 * still drains and a wrong one costs at most this many rows before anyone looks,
 * all of which come back on their own once the signals recover. Clearing a known
 * backlog at once takes --max-close from someone who has read the dry run.
 */
export const MAX_CLOSE_PER_RUN = 40;

const NO_SUCH_ID = { greenhouse: '9999999999', lever: '00000000-0000-0000-0000-000000000000', ashby: '00000000-0000-0000-0000-000000000000' };
const BOARD_HOST = { greenhouse: /(^|\.)greenhouse\.io$/i, lever: /(^|\.)lever\.co$/i, ashby: /(^|\.)ashbyhq\.com$/i };

/** Prefix closedWrite puts in blocked_detail, which marks a row as closed here. */
export const CLOSED_HERE = 'closed-check: liveness:';

/**
 * An application may already have gone out on this row. Its runner could not
 * confirm it, and only a person can settle that, so nothing here touches it.
 */
const LEAVE_ALONE = new Set(['submitted-unconfirmed']);

/**
 * What the board API says about one posting.
 *
 * @param {{ats: string, id: string}} ref
 * @param {{status?: number, listedIds?: Set<string>|null, error?: string}} res
 * @returns {'live'|'gone'|'unknown'}
 */
export function verdictFromApi(ref, res) {
  if (!res || res.error) return 'unknown';
  if (ref.ats === 'ashby') {
    /* Ashby has no per-posting endpoint, only the whole board. A failed board
       read has no list, and must not read as "not on the list". */
    if (res.status === 404) return 'gone';
    if (res.status !== 200 || !res.listedIds) return 'unknown';
    return res.listedIds.has(String(ref.id).toLowerCase()) ? 'live' : 'gone';
  }
  if (res.status === 200) return 'live';
  if (res.status === 404 || res.status === 410) return 'gone';
  return 'unknown';
}

/**
 * What the human posting page says, using the shapes measured 2026-11-03 on
 * known-live and known-gone postings from all three boards. Lever and Ashby
 * answer 404. Greenhouse usually redirects to its board root with ?error=true
 * at 200, which is why a bare status cannot be the test.
 *
 * Only a page on the board's own host counts. Oscar's Greenhouse board redirects
 * every posting to oscarhealth.com/careers/, which answers 404 for a real id and
 * a made-up one alike, and other employers echo any id back in a ?gh_jid= URL.
 * Off the host, the page is the employer's site and says nothing about the job.
 *
 * @param {{ats: string, id: string}} ref
 * @param {{status?: number, finalUrl?: string, body?: string, error?: string}} res
 * @returns {'live'|'gone'|'unknown'}
 */
export function verdictFromPage(ref, res) {
  if (!res || res.error) return 'unknown';
  const finalUrl = String(res.finalUrl || '');
  let host = '';
  try { host = new URL(finalUrl).hostname; } catch { return 'unknown'; }
  if (!BOARD_HOST[ref.ats] || !BOARD_HOST[ref.ats].test(host)) return 'unknown';
  if (res.status === 404 || res.status === 410) return 'gone';
  if (res.status !== 200) return 'unknown';
  if (/[?&]error=true\b/.test(finalUrl)) return 'gone';
  const id = String(ref.id).toLowerCase();
  if (finalUrl.toLowerCase().includes(id) || String(res.body || '').toLowerCase().includes(id)) return 'live';
  return 'unknown';
}

/**
 * @param {'live'|'gone'|'unknown'} api
 * @param {'live'|'gone'|'unknown'|null} page null when the page was not needed
 * @returns {'close'|'live'|'keep-disagree'|'keep-unknown'}
 */
export function decide(api, page) {
  if (api === 'unknown' || page === 'unknown') return 'keep-unknown';
  if (api === 'live') return 'live';
  return page === 'gone' ? 'close' : 'keep-disagree';
}

/**
 * Rows to re-check: queued rows on a board we can address. A submitted row is
 * history and never enters this list, and closedWrite refuses it again.
 *
 * @param {Array<Record<string, any>>} rows
 * @returns {Array<{row: Record<string, any>, ref: {ats: string, token: string, id: string}}>}
 */
export function rowsToCheck(rows) {
  return (rows || [])
    .filter((row) => row && row.status === 'queued' && !LEAVE_ALONE.has(row.blocked_reason))
    .map((row) => ({ row, ref: boardRef(row.url) }))
    .filter((entry) => entry.ref && entry.ref.token);
}

/**
 * Rows this file closed earlier, which may have come back.
 *
 * @param {Array<Record<string, any>>} rows
 * @returns {Array<{row: Record<string, any>, ref: {ats: string, token: string, id: string}}>}
 */
export function rowsToRecheck(rows) {
  return (rows || [])
    .filter((row) => row && row.status === 'skipped' && !row.submitted_at
      && row.blocked_reason === 'posting-closed'
      && String(row.blocked_detail || '').startsWith(CLOSED_HERE))
    .map((row) => ({ row, ref: boardRef(row.url) }))
    .filter((entry) => entry.ref && entry.ref.token);
}

/**
 * The reason recorded on a close. closedWrite overwrites blocked_reason, so a
 * block the row already carried is kept here for reopenClosedWrite to restore:
 * a row the runner gave up on as needs-email-code must not look retryable just
 * because its posting went away and came back.
 *
 * @param {Record<string, any>} row
 * @param {string} ats
 * @returns {string}
 */
export function closeReason(row, ats) {
  const prior = row.blocked_reason && row.blocked_reason !== 'posting-closed' ? ` | was ${row.blocked_reason}` : '';
  return `liveness: gone from the ${ats} API and the posting page${prior}`;
}

/**
 * Put a row this file closed back in the queue, with any block it had before.
 * rank_pct is already NULL, so the next daily run re-gates and re-ranks it.
 *
 * @param {Record<string, any>} row
 * @returns {{sql: string, params: Array<string|null>}}
 */
export function reopenClosedWrite(row) {
  const prior = /\| was ([\w-]+)$/.exec(String(row.blocked_detail || ''));
  return {
    sql: `UPDATE jobs SET status = ?, blocked_reason = ?, blocked_detail = ?,
      link_status = ?, link_checked_at = ?
      WHERE dedupe_key = ? AND status = ? AND blocked_reason = ? AND submitted_at IS NULL`,
    params: ['queued', prior ? prior[1] : null, 'liveness: back on the board and the page', 'live', new Date().toISOString(),
      row.dedupe_key, 'skipped', 'posting-closed']
  };
}

/**
 * Is the measurer itself working? A made-up id must not read live, and a posting
 * the API lists must not read gone. Those are the wrong readings that could close
 * a real job or hide a broken classifier, so any of them stops the run.
 *
 * An unknown reading is not a failure. A throttled board gives unknown, and
 * unknown never closes anything, so the run is already safe.
 *
 * @param {Array<{ats: string, fakeApi: string, fakePage: string, realPage: string|null}>} probes
 * @returns {string[]} what failed; empty when healthy
 */
export function measurerProblems(probes) {
  const problems = [];
  for (const p of probes) {
    if (p.fakeApi === 'live') problems.push(`${p.ats}: a made-up id read as live from the API`);
    if (p.fakePage === 'live') problems.push(`${p.ats}: a made-up id read as live from the page`);
    if (p.realPage === 'gone') problems.push(`${p.ats}: a listed posting read as gone from its page`);
  }
  return problems;
}

/* ------------------------------------------------------------- network -- */

/**
 * @param {string} url
 * @param {Record<string, string>} [headers]
 * @returns {Promise<{status?: number, finalUrl?: string, body?: string, error?: string}>}
 */
export async function get(url, headers) {
  let last = { error: 'not tried' };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetchText(url, { headers, accept: '*/*', hideUrlInLogs: true });
      last = { status: res.status, finalUrl: res.finalUrl, body: res.text };
      if (res.status < 500) return last;
    } catch (error) {
      last = { error: String(error && error.message ? error.message : error).slice(0, 120) };
    }
    if (attempt === 0) await new Promise((resolve) => { setTimeout(resolve, RETRY_WAIT_MS); });
  }
  return last;
}

/**
 * @param {Map<string, Promise<object>>} boards one read per Ashby board per run
 * @param {{ats: string, token: string, id: string}} ref
 * @returns {Promise<object>}
 */
function apiResponse(boards, ref) {
  const token = encodeURIComponent(ref.token);
  if (ref.ats === 'greenhouse') return get(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs/${ref.id}`);
  if (ref.ats === 'lever') return get(`https://api.lever.co/v0/postings/${token}/${ref.id}`);
  if (!boards.has(ref.token)) {
    boards.set(ref.token, get(`https://api.ashbyhq.com/posting-api/job-board/${token}`).then((res) => {
      if (res.status !== 200) return { ...res, listedIds: null };
      try {
        const jobs = JSON.parse(res.body).jobs;
        return { status: 200, listedIds: Array.isArray(jobs) ? new Set(jobs.map((job) => String(job.id).toLowerCase())) : null };
      } catch {
        return { status: 200, listedIds: null };
      }
    }));
  }
  return boards.get(ref.token);
}

/** @param {string} url @returns {Promise<object>} */
const pageResponse = (url) => get(url, { 'user-agent': BROWSER_UA });

/**
 * @param {Map<string, Promise<object>>} boards
 * @param {{row: Record<string, any>, ref: object}} entry
 * @returns {Promise<{entry: object, api: string, page: string|null, outcome: string}>}
 */
async function check(boards, entry) {
  const api = verdictFromApi(entry.ref, await apiResponse(boards, entry.ref));
  if (api !== 'gone') return { entry, api, page: null, outcome: decide(api, null) };
  const page = verdictFromPage(entry.ref, await pageResponse(entry.row.url));
  return { entry, api, page, outcome: decide(api, page) };
}

/**
 * Probe one made-up id and one listed posting per board type. An employer that
 * redirects off the board reads unknown, so a few get a turn before giving up.
 *
 * @param {Map<string, Promise<object>>} boards
 * @param {Array<{row: Record<string, any>, ref: object}>} entries
 * @returns {Promise<string[]>}
 */
async function selfCheck(boards, entries) {
  const pageUrl = { greenhouse: (r) => `https://job-boards.greenhouse.io/${r.token}/jobs/${r.id}`, lever: (r) => `https://jobs.lever.co/${r.token}/${r.id}`, ashby: (r) => `https://jobs.ashbyhq.com/${r.token}/${r.id}` };
  const probes = [];
  for (const ats of Object.keys(NO_SUCH_ID)) {
    const onBoard = entries.filter((entry) => entry.ref.ats === ats);
    if (!onBoard.length) continue;
    let fakeApi = 'unknown';
    let fakePage = 'unknown';
    for (const token of [...new Set(onBoard.map((entry) => entry.ref.token))].slice(0, SELF_CHECK_TRIES)) {
      const fake = { ats, token, id: NO_SUCH_ID[ats] };
      fakeApi = verdictFromApi(fake, await apiResponse(boards, fake));
      fakePage = verdictFromPage(fake, await pageResponse(pageUrl[ats](fake)));
      if (fakeApi !== 'unknown' && fakePage !== 'unknown') break;
    }
    let realPage = null;
    let tries = 0;
    for (const entry of onBoard) {
      if (tries >= SELF_CHECK_TRIES) break;
      if (verdictFromApi(entry.ref, await apiResponse(boards, entry.ref)) !== 'live') continue;
      tries += 1;
      realPage = verdictFromPage(entry.ref, await pageResponse(entry.row.url));
      if (realPage !== 'unknown') break;
    }
    probes.push({ ats, fakeApi, fakePage, realPage });
  }
  return measurerProblems(probes);
}

/**
 * One full pass. `apply` runs a write and returns the rows it changed; it is only
 * called when `write` is true.
 *
 * @param {{rows: Array<Record<string, any>>, write?: boolean, quiet?: boolean, maxClose?: number, apply?: (w: {sql: string, params: any[]}) => Promise<number>}} options
 * @returns {Promise<{ok: boolean, problems: string[], counts: Record<string, number>, closed: number, reopened: number, waiting: number, unresolved: Array<{url: string, dedupe_key: string}>}>}
 */
export async function runLiveness({ rows, write = false, quiet = false, maxClose = MAX_CLOSE_PER_RUN, apply }) {
  const queued = rowsToCheck(rows);
  const closedHere = rowsToRecheck(rows);
  const boards = new Map();
  const empty = { counts: {}, closed: 0, reopened: 0, waiting: 0, unresolved: [] };

  const problems = await selfCheck(boards, queued);
  if (problems.length) {
    logWarn('measurer failed its self-check, nothing written', { problems });
    return { ok: false, problems, ...empty };
  }

  const results = await mapPool(queued, CONCURRENCY, (entry) => check(boards, entry));
  const cameBack = (await mapPool(closedHere, CONCURRENCY, async (entry) => {
    if (verdictFromApi(entry.ref, await apiResponse(boards, entry.ref)) !== 'live') return null;
    return verdictFromPage(entry.ref, await pageResponse(entry.row.url)) === 'live' ? entry : null;
  })).filter(Boolean);

  const counts = {};
  for (const r of results) counts[r.outcome] = (counts[r.outcome] || 0) + 1;
  const toClose = results.filter((r) => r.outcome === 'close');
  const closing = toClose.slice(0, maxClose);
  const waiting = toClose.length - closing.length;
  logInfo('liveness', { checked: results.length, ...counts, overCap: waiting, closedBefore: closedHere.length, cameBack: cameBack.length, write });
  if (waiting) logWarn('more closes than the cap, the rest wait for the next run', { waiting, cap: maxClose });
  if (!quiet) {
    for (const r of results) {
      if (r.outcome === 'live') continue;
      logInfo(r.outcome, { company: r.entry.row.company, title: String(r.entry.row.title).slice(0, 50), api: r.api, page: r.page, url: r.entry.row.url });
    }
    for (const entry of cameBack) logInfo('came back', { company: entry.row.company, title: String(entry.row.title).slice(0, 50) });
  }

  let closed = 0;
  let reopened = 0;
  if (write) {
    for (const r of closing) closed += await apply(closedWrite(r.entry.row, closeReason(r.entry.row, r.entry.ref.ats)));
    for (const entry of cameBack) reopened += await apply(reopenClosedWrite(entry.row));
  }
  const unresolved = results.filter((r) => r.outcome.startsWith('keep'))
    .map((r) => ({ url: r.entry.row.url, dedupe_key: r.entry.row.dedupe_key }));
  return { ok: true, problems: [], counts, closed, reopened, waiting, unresolved };
}

/* ----------------------------------------------------------------- CLI -- */

if (isCli(import.meta.url)) {
  const args = parseArgs();
  const doWrite = !!args.write;
  const maxClose = args['max-close'] === undefined ? MAX_CLOSE_PER_RUN : Number(args['max-close']);
  if (!Number.isInteger(maxClose) || maxClose < 0) {
    logWarn('--max-close needs a whole number', { got: args['max-close'] });
    process.exit(2);
  }
  if (doWrite && !process.env.CF_D1_TOKEN) {
    logWarn('CF_D1_TOKEN is not set, so --write would change nothing', {});
    process.exit(1);
  }

  const { d1 } = await import('./ensure-guards.mjs');
  const live = await (await fetch(API, { headers: { 'cache-control': 'no-cache' } })).json();
  const outcome = await runLiveness({
    rows: live.jobs,
    write: doWrite,
    quiet: !!args.quiet,
    maxClose,
    apply: async (write) => {
      const res = await d1(write.sql, write.params);
      if (!res.success) throw new Error(`D1 rejected the write: ${JSON.stringify(res.errors).slice(0, 200)}`);
      return res.result[0].meta.changes;
    }
  });
  fs.mkdirSync(path.dirname(UNRESOLVED_PATH), { recursive: true });
  fs.writeFileSync(UNRESOLVED_PATH, JSON.stringify({ jobs: outcome.unresolved }));
  logInfo('liveness complete', { closed: outcome.closed, reopened: outcome.reopened, waiting: outcome.waiting, unresolved: outcome.unresolved.length });
  if (!doWrite) logWarn('nothing written', { hint: 'pass --write to apply' });
  if (!outcome.ok) process.exit(1);
}
