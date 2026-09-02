/**
 * Recover published bands the old decoder dropped, and re-run the gate so a
 * start under $160k actually leaves the list.
 *
 * A fix that only applies to new arrivals leaves the 19 already-queued rows
 * sitting there with no band. Ranking will not touch them -- they already
 * have a rank_pct -- so this walk is the only thing that writes the figure
 * back. salary_source is `posting:recover` for a band scraped out of
 * prose and `ashby:compensation` for a band read from Ashby's structured
 * field. Those failure modes are different (a regex over HTML vs an
 * employer-entered number) and must not be indistinguishable afterwards.
 *
 * Fetches through fetchJd so board-token resolution is the one the pipeline
 * already trusts, not a guess from the company name. The probe that found
 * this bug guessed, and 8 of 31 rows could not be fetched for that reason.
 *
 *   node ingest/salary-recover.mjs            # report only (default)
 *   node ingest/salary-recover.mjs --dry      # same
 *   node ingest/salary-recover.mjs --write    # write bands and re-gate
 */

import { isCli, parseArgs } from './cli.mjs';
import { logInfo, logWarn } from './logger.mjs';
import {
  fetchJd, requirementsGate, rankWrite, strip, payTier
} from './fit-score.mjs';
import { salaryFromAshbyCompensation, salaryFromText } from './salary-from-posting.mjs';
import { bandWrite, checkedWrite } from './salary-sweep.mjs';
import { ensurePayColumns } from './pay-columns.mjs';
import { hasPublishedSalary, readCachedAshbyCompensation } from './salary-audit.mjs';

const API = 'https://apply-dashboard.pages.dev/api/jobs';
const ACCOUNT = 'dd01b432f0329f87bb1cc1a3fad590ee';
const DATABASE = '10e8a6c0-1fa7-4c33-a007-2044876ce6a7';

/**
 * Queued rows with no stored band. Submitted is history; skipped already
 * failed some other rule and is not what this walk is for.
 *
 * @param {Array<Record<string, any>>} rows
 * @returns {Array<Record<string, any>>}
 */
export function rowsToRecover(rows) {
  return (rows || []).filter((row) => row && row.status === 'queued' && !hasPublishedSalary(row));
}

/**
 * What to do with one fetched description, plus optional Ashby structured
 * compensation. Structured numbers win over anything parsed out of the
 * description: a field the employer filled in beats a regex over prose.
 *
 * @param {string|null} jd
 * @param {unknown} [compensation]
 * @returns {{kind: 'unreadable'|'empty'|'band', band: {min: number|null, max: number|null}, source: string|null}}
 */
export function recoverFromJd(jd, compensation = null) {
  const structured = salaryFromAshbyCompensation(compensation);
  if (structured.min != null || structured.max != null) {
    return { kind: 'band', band: structured, source: 'ashby:compensation' };
  }
  if (!jd) return { kind: 'unreadable', band: { min: null, max: null }, source: null };
  const band = salaryFromText(strip(jd));
  if (band.min == null) return { kind: 'empty', band, source: null };
  return { kind: 'band', band, source: 'posting:recover' };
}

if (isCli(import.meta.url)) {
  const args = parseArgs();
  const doWrite = !!args.write;
  const token = process.env.CF_D1_TOKEN || '';
  if (doWrite && !token) {
    logWarn('CF_D1_TOKEN is not set, so --write would change nothing', {});
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

  const live = await (await fetch(API, { headers: { 'cache-control': 'no-cache' } })).json();
  const candidates = rowsToRecover(live.jobs || []);
  logInfo('recover', { examined: candidates.length, write: doWrite });

  const summary = { examined: candidates.length, recovered: 0, ruledOut: 0, empty: 0, unreadable: 0 };
  const checkedAt = new Date().toISOString();

  if (doWrite) await ensurePayColumns(run);

  for (const row of candidates) {
    /* refetch: true because cached files written by the old decoder replaced
       `&mdash;` with a space, and no amount of re-decoding puts a separator
       back. Board-token resolution is still fetchJd's. */
    let jd = null;
    try {
      jd = await fetchJd(row.url, { refetch: true });
    } catch {
      jd = null;
    }
    const compensation = readCachedAshbyCompensation(row.url);
    const verdict = recoverFromJd(jd, compensation);
    if (verdict.kind === 'unreadable') {
      summary.unreadable += 1;
      continue;
    }
    if (verdict.kind === 'empty') {
      summary.empty += 1;
      if (doWrite) {
        const w = checkedWrite(row, checkedAt);
        await run(w.sql, w.params);
      }
      continue;
    }

    summary.recovered += 1;
    const scoredJob = { ...row, salary_min: verdict.band.min, salary_max: verdict.band.max };
    const gate = requirementsGate(scoredJob, jd);
    const lane = payTier(scoredJob);
    logInfo('recovered', {
      company: row.company,
      title: String(row.title).slice(0, 44),
      band: `${verdict.band.min}-${verdict.band.max}`,
      source: verdict.source,
      gate: gate.ok ? `lane ${lane}` : gate.reasons[0]
    });

    /* Count the floor separately from other gate reasons. The write still
       skips on ANY gate failure -- re-checking only salary is how a security
       product would come back -- but the summary Brian asked for is how many
       the floor itself took off. */
    if (!gate.ok && (gate.reasons || []).some((r) => String(r).startsWith('salary:'))) {
      summary.ruledOut += 1;
    }

    if (!doWrite) continue;

    /* Write the band FIRST. Ruling the row out without storing the figure
       is how a published salary gets lost a second time -- the skipped row
       would look unpriced, the lane would treat it as unknown, and a later
       reopen would put it back on the list above priced postings. */
    const band = bandWrite(
      { band: verdict.band, via: 'recover', source: verdict.source, dedupe_key: row.dedupe_key },
      checkedAt
    );
    await run(band.sql, band.params);
    if (!gate.ok) {
      const w = rankWrite({
        job: row,
        gate,
        rank: null,
        pay_tier: null,
        fit: null,
        success: { pct: 0, reasons: [] },
        jdRead: true,
        offFocus: null
      });
      await run(w.sql, w.params);
    }
  }

  logInfo('recover complete', {
    examined: summary.examined,
    recovered: summary.recovered,
    ruledOut: summary.ruledOut,
    confirmedEmpty: summary.empty,
    unreadable: summary.unreadable
  });
  if (!doWrite) logWarn('nothing written', { hint: 'pass --write to apply' });
}
