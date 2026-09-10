/**
 * Re-verify the rows marked posting-closed, and make the row agree with itself.
 *
 * 27 queued rows carry `blocked_reason = 'posting-closed'` while still sitting
 * at `status = 'queued'` with a `rank_pct`. The page hides them, because
 * onTheList() treats posting-closed as ruled out, so nothing looks wrong. The
 * table underneath disagrees with the page, and every consumer that reads
 * status rather than blocked_reason sees a different list.
 *
 * Worse, the verdicts are not reproducible. Their `blocked_detail` reads
 * "link check 2026-08-25: HTTP 200 -- the posting is gone", and NOTHING in this
 * repository writes that string: it came from an ad-hoc local script that was
 * never committed. One of them says HTTP 200 and "gone" in the same sentence,
 * which cannot both be a fair reading of the same response.
 *
 * So this re-checks them for real, records what it saw, and acts:
 *   gone     -> status = skipped, rank_pct and pay_tier cleared
 *   live     -> blocked_reason cleared, the row returns to the queue
 *   unknown  -> left exactly as it is
 *
 * A submitted row is history and is never touched.
 *
 *   node ingest/closed-check.mjs                 report only
 *   CF_D1_TOKEN=... node ingest/closed-check.mjs --write
 *   node ingest/closed-check.mjs --unread        the never-read rows instead
 *   node ingest/closed-check.mjs --links         act on link-check's evidence

 * --links reads ingest/evidence/link-check.json and retires only the rows that
 * file classified `dead`. It exists so there is ONE write path rather than two:
 * link-check drives a real browser and produces evidence, this file decides and
 * writes. Its classifier gained a fourth state on 2026-09-10 for exactly this
 * reason -- of twelve rows it had called dead, five were dead, three were live
 * and four were unknowable from the page. Only `dead` reaches this mode.
 *
 * --unread exists because the tiered reader already knows. It returns
 * outcome board-404 when the board itself no longer has the posting, and 24
 * unread rows came back that way -- lever and greenhouse ids the board has
 * dropped. Nothing acted on it, so they sat on the list looking like a
 * reader that could not cope rather than postings that are gone.
 */

import { isCli, parseArgs } from './cli.mjs';
import { logInfo, logWarn } from './logger.mjs';

const API = 'https://apply-dashboard.pages.dev/api/jobs';
const ACCOUNT = 'dd01b432f0329f87bb1cc1a3fad590ee';
const DATABASE = '10e8a6c0-1fa7-4c33-a007-2044876ce6a7';

/* Phrases a board puts on a 200 page when the requisition is closed. A 200 is
   NOT enough on its own: most careers sites answer 200 for everything and
   render the state in the body, and treating a bare 200 as gone is how a live
   posting gets retired. */
export const GONE_MARKERS = [
  'no longer open', 'no longer available', 'no longer accepting',
  'this job is closed', 'position has been filled', 'posting has expired',
  'job not found', 'this position is no longer', 'requisition is closed',
  'we are no longer accepting applications'
];

/**
 * What a response says about whether the posting still exists.
 *
 * Deliberately three-valued. "Unknown" is the answer for a network error or a
 * page too thin to read, and it must never be collapsed into "gone": this
 * whole script exists because something collapsed a 200 into "gone" once.
 *
 * @param {{status: number|null, body: string|null, error?: string}} res
 * @returns {{verdict: 'gone'|'live'|'unknown', why: string}}
 */
export function classifyClosed(res) {
  if (!res || res.error) return { verdict: 'unknown', why: `fetch failed: ${(res && res.error) || 'no response'}` };
  const status = Number(res.status);
  if (status === 404 || status === 410) return { verdict: 'gone', why: `HTTP ${status}` };
  if (status === 403 || status === 429) {
    return { verdict: 'unknown', why: `HTTP ${status}: the board refused the read, which says nothing about the posting` };
  }
  if (status >= 500) return { verdict: 'unknown', why: `HTTP ${status}: the board is broken, not the posting` };
  const body = String(res.body || '');
  const text = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').toLowerCase();
  if (!text || text.length < 200) {
    return { verdict: 'unknown', why: `HTTP ${status} but only ${text.length} chars of text to judge` };
  }
  const hit = GONE_MARKERS.find((m) => text.includes(m));
  if (hit) return { verdict: 'gone', why: `HTTP ${status} and the page says "${hit}"` };
  if (status >= 200 && status < 300) return { verdict: 'live', why: `HTTP ${status} and no closed-posting wording` };
  return { verdict: 'unknown', why: `HTTP ${status}` };
}

/**
 * The write for a row the board no longer has. Mirrors domainBlockWrite: the
 * row leaves the queue and gives up its score, and a submitted row is refused
 * in the WHERE rather than in a caller that might forget.
 *
 * @param {Record<string, any>} row
 * @param {string} why
 * @returns {{sql: string, params: Array<string|null>}}
 */
export function closedWrite(row, why) {
  return {
    sql: `UPDATE jobs SET status = ?, blocked_reason = ?, blocked_detail = ?,
      rank_pct = NULL, pay_tier = NULL, link_status = ?, link_checked_at = ?
      WHERE dedupe_key = ? AND status != ?`,
    params: ['skipped', 'posting-closed', `closed-check: ${why}`.slice(0, 400),
      'dead', new Date().toISOString(), row.dedupe_key, 'submitted']
  };
}

/**
 * The write for a row the board still serves. It goes back on the list: a
 * posting wrongly retired is worse than one wrongly kept, because nothing on
 * the page ever shows it again.
 *
 * @param {Record<string, any>} row
 * @param {string} why
 * @returns {{sql: string, params: Array<string|null>}}
 */
export function reopenWrite(row, why) {
  return {
    sql: `UPDATE jobs SET blocked_reason = NULL, blocked_detail = ?,
      link_status = ?, link_checked_at = ?
      WHERE dedupe_key = ? AND status != ?`,
    params: [`closed-check reopened: ${why}`.slice(0, 400), 'live',
      new Date().toISOString(), row.dedupe_key, 'submitted']
  };
}

/**
 * Rows this script is about: marked closed, not submitted.
 * @param {Array<Record<string, any>>} rows
 * @returns {Array<Record<string, any>>}
 */
export function rowsToRecheck(rows) {
  return (rows || []).filter((r) => r
    && String(r.blocked_reason || '') === 'posting-closed'
    && String(r.status || '') !== 'submitted');
}

/**
 * Queued rows whose description has never been read.
 *
 * The tiered reader returns outcome board-404 when the board itself no longer
 * has the posting, and 24 unread rows came back that way -- lever and
 * greenhouse ids the board has dropped. Nothing acted on it, so they sat on the
 * list looking like a reader that could not cope rather than postings that are
 * gone. This is the set to re-read and close.
 *
 * @param {Array<Record<string, any>>} rows
 * @returns {Array<Record<string, any>>}
 */
export function rowsUnread(rows) {
  return (rows || []).filter((r) => r
    && String(r.status || '') === 'queued'
    && String(r.jd_read || '') !== 'yes');
}

/* ------------------------------------------------------------------ CLI -- */

if (isCli(import.meta.url)) {
  const args = parseArgs();
  const doWrite = !!args.write;

  const d1 = async (sql, params) => {
    const token = process.env.CF_D1_TOKEN;
    if (!token) throw new Error('CF_D1_TOKEN is not set');
    const r = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ sql, params })
      }
    );
    const j = await r.json();
    if (!j.success) throw new Error(JSON.stringify(j.errors).slice(0, 200));
    return j.result[0];
  };

  const live = await (await fetch(API, { headers: { 'cache-control': 'no-cache' } })).json();

  /* --unread asks the READER, not a page fetch. The reader is the thing that
     knows a board id has been dropped, and asking it keeps one answer rather
     than two that can disagree. */
  /* --links: retire what link-check PROVED dead, and nothing else.

     The evidence file carries live, wall, dead and unknown. Only dead is acted
     on, and each row's own note travels into blocked_detail so the reason is
     readable later without re-running anything. */
  if (args.links) {
    const { readFile } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const path = typeof args.links === 'string' && args.links !== 'true'
      ? String(args.links)
      : join(here, 'evidence', 'link-check.json');
    let evidence;
    try {
      evidence = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      logWarn('could not read link-check evidence', { path, error: String(error.message).slice(0, 120) });
      process.exit(1);
    }
    const results = Array.isArray(evidence.results) ? evidence.results : [];
    const byKey = new Map((live.jobs || []).map((r) => [r.dedupe_key, r]));
    const counts = {};
    for (const r of results) counts[r.state] = (counts[r.state] || 0) + 1;
    logInfo('closed-check --links', { evidence: path, results: results.length, ...counts, write: doWrite });

    let retired = 0;
    for (const r of results) {
      if (r.state !== 'dead') continue;
      const row = byKey.get(r.dedupe_key);
      /* Not on the current list, or no longer queued: nothing to do. Its
         expected-case fixtures live in this file too and have no queue row. */
      if (!row || row.status !== 'queued') continue;
      logInfo('dead link', {
        company: row.company, title: String(row.title).slice(0, 40),
        http: r.httpStatus, note: r.note
      });
      if (!doWrite) continue;
      const w = closedWrite(row, `${r.note} (HTTP ${r.httpStatus})`);
      const res = await d1(w.sql, w.params);
      if (res && res.meta && res.meta.changes > 0) retired += 1;
    }
    logInfo('link sweep complete', { retired });
    if (!doWrite) logWarn('nothing written', { hint: 'pass --write to apply' });
    process.exit(0);
  }

  if (args.unread) {
    const { readJd } = await import('./jd-read.mjs');
    await import('./fit-score.mjs');
    const unread = rowsUnread(live.jobs || []);
    logInfo('closed-check --unread', { rows: unread.length, write: doWrite });
    const seen = { 'board-404': 0, read: 0, other: 0 };
    for (const row of unread) {
      let outcome = 'other';
      try {
        const r = await readJd(row.url, { refetch: true });
        outcome = r && r.outcome === 'board-404' ? 'board-404'
          : (r && r.text ? 'read' : 'other');
      } catch { outcome = 'other'; }
      seen[outcome] = (seen[outcome] || 0) + 1;
      if (outcome !== 'board-404') continue;
      logInfo('board-404', { company: row.company, title: String(row.title).slice(0, 44) });
      if (!doWrite) continue;
      const w = closedWrite(row, 'the board no longer lists this posting');
      await d1(w.sql, w.params);
    }
    logInfo('unread sweep complete', seen);
    if (!doWrite) logWarn('nothing written', { hint: 'pass --write to apply' });
    process.exit(0);
  }

  const rows = rowsToRecheck(live.jobs || []);
  logInfo('closed-check', { rows: rows.length, write: doWrite });

  const counts = { gone: 0, live: 0, unknown: 0 };
  for (const row of rows) {
    let res;
    try {
      const r = await fetch(row.url, {
        redirect: 'follow',
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
          accept: 'text/html,application/xhtml+xml'
        }
      });
      res = { status: r.status, body: r.ok ? await r.text() : '' };
    } catch (e) {
      res = { status: null, body: null, error: e.message.slice(0, 60) };
    }
    const { verdict, why } = classifyClosed(res);
    counts[verdict] += 1;
    logInfo(verdict, { company: row.company, title: String(row.title).slice(0, 40), why });
    if (!doWrite || verdict === 'unknown') continue;
    const w = verdict === 'gone' ? closedWrite(row, why) : reopenWrite(row, why);
    await d1(w.sql, w.params);
  }

  logInfo('closed-check complete', counts);
  if (!doWrite) logWarn('nothing written', { hint: 'pass --write to apply' });
}
