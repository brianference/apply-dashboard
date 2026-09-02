/**
 * Apply a rule change to the rows that are already in the queue.
 *
 * Two passes, both driven by the REAL gate rather than by the one rule that
 * changed:
 *
 *   block   every non-submitted row whose employer is on the blocked list
 *   domain  every queued row whose title now fails a domain rule
 *   reopen  every row skipped for the retired "top under $180k" reason that
 *           now passes the WHOLE gate
 *
 * The reopen pass re-runs `requirementsGate` with the cached job description,
 * never the salary rule on its own. A row rejected for pay may ALSO be a
 * security product, a healthcare product or a San Francisco role, and
 * re-checking a rejection with a subset of the rules that made it silently
 * reverses everything the subset cannot see.
 *
 * A `submitted` row is history and is never rewritten.
 *
 *   node ingest/regate.mjs                # report only
 *   CF_D1_TOKEN=... node ingest/regate.mjs --write
 */

import { isCli, parseArgs } from './cli.mjs';
import { logInfo, logWarn } from './logger.mjs';
import { requirementsGate, blockedEmployer, fetchJd } from './fit-score.mjs';
import { rowsToBlock, employerBlockWrite } from './apply-employer-block.mjs';
import { rowsToDomainBlock, domainBlockWrite, domainSignals } from './domain-eligible.mjs';
import {
  matchesRetiredSalarySkip, decideReopen, reopenWrite, stillRejectedWrite
} from './reopen-second-lane.mjs';

const API = 'https://apply-dashboard.pages.dev/api/jobs';
const ACCOUNT = 'dd01b432f0329f87bb1cc1a3fad590ee';
const DATABASE = '10e8a6c0-1fa7-4c33-a007-2044876ce6a7';


if (isCli(import.meta.url)) {
  const args = parseArgs();
  const doWrite = !!args.write;
  const token = process.env.CF_D1_TOKEN || '';
  if (doWrite && !token) {
    logWarn('CF_D1_TOKEN is not set, so --write would change nothing', {});
    process.exit(1);
  }

  /** @param {string} sql @param {Array<string|number|null>} params */
  const run = async (sql, params) => {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sql, params })
    });
    const j = await r.json();
    if (!j.success) throw new Error(JSON.stringify(j.errors));
    return (j.result && j.result[0] && j.result[0].meta) || {};
  };

  const rows = (await (await fetch(API, { headers: { 'cache-control': 'no-cache' } })).json()).jobs || [];
  logInfo('regate', { rows: rows.length, write: doWrite });

  /* ---- pass 1: employers ruled out by name ---- */
  /* rowsToBlock and employerBlockWrite are the pure, tested pair in
     apply-employer-block.mjs -- the submitted-row protection lives there and is
     asserted in ingest/test-employer-block.mjs rather than restated here. */
  const toBlock = rowsToBlock(rows);
  const blockedSubmitted = rows.filter((r) => r.status === 'submitted' && blockedEmployer(r.company));
  let blocked = 0;
  for (const { row, blocked: who } of toBlock) {
    logInfo('block', { company: row.company, title: String(row.title).slice(0, 44), status: row.status });
    if (!doWrite) continue;
    const w = employerBlockWrite(row, who);
    const meta = await run(w.sql, w.params);
    if (meta.changes) blocked += 1;
  }

  /* ---- pass 1b: domains ruled out by title ---- */
  /* rowsToDomainBlock and domainBlockWrite are the pure, tested pair in
     domain-eligible.mjs -- submitted-row protection lives there. A new
     domain rule flows through this pass because it re-runs domainSignals
     on every queued row; risk-compliance is title-first so it does not
     need a description. The reopen pass below still re-runs the WHOLE
     gate, so a salary-skip that is also a compliance title stays out. */
  const toDomain = rowsToDomainBlock(rows);
  const domainSubmitted = rows.filter((r) => r.status === 'submitted' && domainSignals(r, null).ruled);
  let domainBlocked = 0;
  for (const { row, domain } of toDomain) {
    logInfo('domain-block', {
      company: row.company,
      title: String(row.title).slice(0, 44),
      domain: domain.domain,
      status: row.status
    });
    if (!doWrite) continue;
    const w = domainBlockWrite(row, domain);
    const meta = await run(w.sql, w.params);
    if (meta.changes) domainBlocked += 1;
  }

  /* ---- pass 2: rows the retired salary rule rejected ---- */
  const candidates = rows.filter((r) => r.status === 'skipped' && matchesRetiredSalarySkip(r.blocked_detail));
  let reopened = 0;
  const stillOut = {};
  for (const r of candidates) {
    /* The description is what the security, healthcare and construction rules
       read. Re-gating without it is the subset problem this script exists to
       avoid, so an unreadable description leaves the row skipped. */
    const jd = await fetchJd(r.url).catch(() => null);
    const gate = requirementsGate(r, jd);
    const decision = decideReopen(r, gate);
    if (decision.action !== 'reopen') {
      const key = decision.reasons[0] || 'unknown';
      stillOut[key] = (stillOut[key] || 0) + 1;
      if (doWrite && decision.action === 'keep-skip') {
        const w = stillRejectedWrite(r, decision.reasons);
        await run(w.sql, w.params);
      }
      continue;
    }
    logInfo('reopen', {
      company: r.company, title: String(r.title).slice(0, 44),
      band: `${r.salary_min}-${r.salary_max}`
    });
    if (!doWrite) continue;
    const w = reopenWrite(r);
    const meta = await run(w.sql, w.params);
    if (meta.changes) reopened += 1;
  }

  logInfo('regate complete', {
    blockedCandidates: toBlock.length,
    blockedWritten: blocked,
    submittedLeftAlone: blockedSubmitted.length,
    domainCandidates: toDomain.length,
    domainWritten: domainBlocked,
    domainSubmittedLeftAlone: domainSubmitted.length,
    reopenCandidates: candidates.length,
    reopened,
    stillRejected: stillOut
  });
  if (!doWrite) logWarn('nothing written', { hint: 'pass --write to apply' });
}
