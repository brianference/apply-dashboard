/**
 * Score the applications already sent, so the ranker can be judged against
 * what actually happened.
 *
 * Brian, 2026-09-18: three applications led to a first-round interview,
 * Mitratech, WWT and Bjak. Make a plan to improve the ranking based on the
 * applications that got an interview.
 *
 * The first thing measuring that found: only 81 of 150 applications had ever
 * been ranked. 69 went in before the ranker existed or were ranked out later,
 * and every write path treats a submitted row as history and never touches
 * it. Two of the three interview sources have no rank, no fit score and no
 * description read. A ranker cannot be judged against outcomes it never
 * scored, so this writes the scores onto the history.
 *
 * WHAT IT WRITES, AND WHAT IT NEVER WRITES. rank_pct, fit_pct, resume_pct,
 * success_pct, pay_tier, rank_why, jd_read and jd_read_status. Never status,
 * never submitted_at, never blocked_reason, never anything the gate decides:
 * an application that was sent is a fact, and the gate's opinion of it today
 * is a label for analysis, kept in rank_why, not a reason to rewrite history.
 * rankWrite() is NOT used here for that reason, because its gate-fail branch
 * sets status. The pass-branch columns are written directly.
 *
 * Idempotent and re-runnable: --all rescores every submitted row, otherwise
 * only the unranked ones. Re-running after a weight change is how a change
 * gets measured against the same outcomes.
 *
 *   node ingest/score-history.mjs                 # report only, unranked rows
 *   node ingest/score-history.mjs --write         # write them
 *   node ingest/score-history.mjs --all --write   # rescore every application
 */

import { parseArgs } from './cli.mjs';
import { scoreOne, publishedStarts, rankBlend, RANK_SUCCESS_WEIGHT, RANK_PAY_WEIGHT } from './fit-score.mjs';
import { readJd } from './jd-read.mjs';

const ACCOUNT = 'dd01b432f0329f87bb1cc1a3fad590ee';
const DATABASE = '10e8a6c0-1fa7-4c33-a007-2044876ce6a7';
const READ_API = 'https://apply-dashboard.pages.dev/api/jobs';

const args = parseArgs();
const write = !!args.write;
const all = !!args.all;
const token = process.env.CF_D1_TOKEN || '';

/**
 * @param {string} sql
 * @param {Array<string|number|null>} params
 * @returns {Promise<{success: boolean, errors?: Array<{message: string}>}>}
 */
async function d1(sql, params) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sql, params })
  });
  return res.json();
}

const live = (await (await fetch(READ_API, { headers: { 'cache-control': 'no-cache' } })).json()).jobs || [];
const submitted = live.filter((r) => r.status === 'submitted');
const targets = all ? submitted : submitted.filter((r) => r.rank_pct == null);
/* The same pay population the daily run scores against, so a historical rank
   is comparable to a live one. */
const payStarts = publishedStarts(live.filter((r) => r.status === 'queued'));

console.log(`applications: ${submitted.length} | to score: ${targets.length} | pay population: ${payStarts.length}`);

let scored = 0;
let unread = 0;
let gateWouldFail = 0;
for (const job of targets) {
  let jd = null;
  let readStatus = 'never-tried';
  try {
    const result = await readJd(job.url);
    jd = result.text || null;
    readStatus = result.text ? 'read' : (result.status || 'unreadable');
  } catch {
    readStatus = 'unreadable';
  }
  if (!jd) unread++;
  const s = scoreOne(job, jd, payStarts);
  if (!s.gate.ok) gateWouldFail++;
  /* scoreOne leaves rank null when the gate fails, because a row off the list
     has no rank. History is different: the application went in, and the
     question is what the ranker would have said. So the blend is computed
     anyway, from the same three terms with the same weights. */
  if (s.rank == null) {
    s.rank = s.fit
      ? rankBlend(s.fit.pct, s.success.pct, s.payTerm)
      : Math.round(s.success.pct * RANK_SUCCESS_WEIGHT + s.payTerm * RANK_PAY_WEIGHT);
  }
  /* The gate's opinion is recorded in the reason, never acted on. */
  const why = (s.gate.ok ? '' : `[would not pass today: ${(s.gate.reasons || []).join('; ')}] `)
    + (s.success && s.success.reasons ? s.success.reasons.join(' | ') : '');
  const line = `${String(s.rank).padStart(4)}  fit ${String(s.fit ? s.fit.pct : '-').padStart(3)}  success ${String(s.success ? s.success.pct : '-').padStart(3)}  lane ${s.pay_tier ?? '-'}  ${String(job.company).slice(0, 16).padEnd(16)} ${String(job.title).slice(0, 44)}`;
  console.log((s.gate.ok ? '  ' : 'g ') + line);
  if (write) {
    const out = await d1(
      `UPDATE jobs SET rank_pct = ?, fit_pct = ?, resume_pct = ?, success_pct = ?,
         jd_read = ?, rank_why = ?, pay_tier = ?, jd_read_status = ?
       WHERE dedupe_key = ? AND status = 'submitted'`,
      [
        s.rank,
        s.fit ? s.fit.pct : null,
        s.fit && s.fit.resumePct != null ? s.fit.resumePct : null,
        s.success ? s.success.pct : null,
        jd ? 1 : 0,
        why.slice(0, 900),
        s.pay_tier,
        readStatus,
        job.dedupe_key
      ]
    );
    if (!out.success) console.log('    D1 error:', out.errors?.[0]?.message);
  }
  scored++;
}

console.log(`\nscored ${scored} | descriptions unreadable ${unread} | would not pass today's gate ${gateWouldFail} (marked in rank_why, status untouched)`);
console.log(write ? 'written' : 'DRY RUN. Nothing written. Add --write.');
