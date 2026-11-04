/**
 * Read-only sweep for applications that have gone quiet.
 *
 * Idea taken from the upstream ai-job-search `/outcome followup` (10+ days) and
 * `/outcome stale` (60+ days); the code is original. It reads, it flags, it
 * prints. It never writes a row and never drafts text.
 *
 * What the database actually records (checked 2026-11-03): jobs.submitted_at,
 * and an `outcomes` table (dedupe_key, stage, occurred_on, note). There is no
 * reply column and no rejection column, so "no recorded outcome" means "no row
 * in `outcomes`", and a rejection or a silent reply is invisible to this sweep.
 *
 *   node ingest/followup-sweep.mjs [--followup 10] [--stale 60] [--asof YYYY-MM-DD]
 *   (needs CF_D1_TOKEN in the environment; SELECT statements only)
 */

import { isCli, parseArgs } from './cli.mjs';

export const FOLLOWUP_DAYS = 10;
export const STALE_DAYS = 60;
const MS_PER_DAY = 86_400_000;

/**
 * @param {unknown} value
 * @returns {number} epoch ms, or NaN when unusable
 */
function toMs(value) {
  if (typeof value !== 'string' && !(value instanceof Date)) return NaN;
  return new Date(value).getTime();
}

/**
 * True when the row had a recorded outcome on or before asOf.
 * An outcome with no usable date counts as recorded: when unsure, do not nag.
 *
 * @param {{outcome?: unknown, outcome_on?: unknown}} row
 * @param {number} asOfMs
 * @returns {boolean}
 */
export function hasOutcomeBy(row, asOfMs) {
  if (!row.outcome) return false;
  const on = toMs(row.outcome_on);
  return Number.isNaN(on) || on <= asOfMs;
}

/**
 * Split open applications into follow-up (quiet >= followupDays, < staleDays)
 * and stale (quiet >= staleDays). A row appears in one list only.
 *
 * @param {Array<Record<string, any>>} rows
 * @param {Date|string} asOf
 * @param {{followupDays?: number, staleDays?: number}} [opts]
 * @returns {{followup: object[], stale: object[]}}
 */
export function sweep(rows, asOf, { followupDays = FOLLOWUP_DAYS, staleDays = STALE_DAYS } = {}) {
  const asOfMs = toMs(asOf);
  const out = { followup: [], stale: [] };
  if (Number.isNaN(asOfMs)) return out;
  for (const row of rows ?? []) {
    if (!row || !row.submitted_at) continue;
    const sentMs = toMs(row.submitted_at);
    if (Number.isNaN(sentMs) || sentMs > asOfMs) continue;
    if (hasOutcomeBy(row, asOfMs)) continue;
    const daysQuiet = Math.floor((asOfMs - sentMs) / MS_PER_DAY);
    const entry = { company: row.company, role: row.title ?? row.role, submitted_at: row.submitted_at, daysQuiet };
    if (daysQuiet >= staleDays) out.stale.push(entry);
    else if (daysQuiet >= followupDays) out.followup.push(entry);
  }
  const oldestFirst = (a, b) => b.daysQuiet - a.daysQuiet;
  out.followup.sort(oldestFirst);
  out.stale.sort(oldestFirst);
  return out;
}

/** Submitted rows joined to their latest outcome. SELECT only. */
export const SELECT_SUBMITTED = `SELECT j.dedupe_key, j.company, j.title, j.submitted_at,
    (SELECT o.stage FROM outcomes o WHERE o.dedupe_key = j.dedupe_key ORDER BY o.occurred_on DESC LIMIT 1) AS outcome,
    (SELECT o.occurred_on FROM outcomes o WHERE o.dedupe_key = j.dedupe_key ORDER BY o.occurred_on DESC LIMIT 1) AS outcome_on
  FROM jobs j WHERE j.submitted_at IS NOT NULL`;

/**
 * @returns {Promise<object[]>} every submitted row with its latest outcome
 */
export async function loadSubmitted() {
  const { d1 } = await import('./ensure-guards.mjs');
  const r = await d1(SELECT_SUBMITTED);
  if (!r.success) throw new Error(`D1 query failed: ${JSON.stringify(r.errors)}`);
  return r.result[0].results;
}

/**
 * Turn CLI flags into sweep options, refusing anything that would make the
 * sweep quietly report "nothing to follow up": a bare flag, a non-number, a
 * non-positive number, an unreadable date, or a follow-up threshold at or past
 * the stale one.
 *
 * @param {Record<string, unknown>} args parsed flags
 * @param {Date} [now]
 * @returns {{asOf: Date, followupDays: number, staleDays: number}}
 */
export function sweepOptions(args, now = new Date()) {
  const days = (name, fallback) => {
    if (args[name] === undefined) return fallback;
    const n = Number(args[name]);
    if (args[name] === true || !Number.isInteger(n) || n < 1) throw new Error(`--${name} needs a whole number of days, got ${JSON.stringify(args[name])}`);
    return n;
  };
  const followupDays = days('followup', FOLLOWUP_DAYS);
  const staleDays = days('stale', STALE_DAYS);
  if (followupDays >= staleDays) throw new Error(`--followup (${followupDays}) must be smaller than --stale (${staleDays})`);
  const asOf = args.asof === undefined ? now : new Date(String(args.asof));
  if (args.asof !== undefined && Number.isNaN(asOf.getTime())) throw new Error(`--asof needs a date like 2026-11-03, got ${JSON.stringify(args.asof)}`);
  return { asOf, followupDays, staleDays };
}

/**
 * Rows the sweep cannot place in time because submitted_at is missing or not a
 * date. They are not flagged; the CLI reports how many so they do not vanish.
 *
 * @param {Array<Record<string, any>>} rows
 * @returns {number}
 */
export function countUnreadable(rows) {
  return (rows ?? []).filter((row) => !row || Number.isNaN(toMs(row.submitted_at))).length;
}

if (isCli(import.meta.url)) {
  const args = parseArgs();
  let options;
  try {
    options = sweepOptions(args);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const { asOf, ...opts } = options;
  const rows = await loadSubmitted();
  const { followup, stale } = sweep(rows, asOf, opts);
  const unreadable = countUnreadable(rows);
  if (unreadable) console.log(`${unreadable} submitted row(s) have a missing or unreadable submitted_at and are not in either list`);
  const show = (title, list) => {
    console.log(`\n${title} (${list.length})`);
    for (const e of list) console.log(`  ${String(e.daysQuiet).padStart(4)}d  ${e.company} | ${e.role} | ${e.submitted_at}`);
  };
  console.log(`submitted rows: ${rows.length}  as of ${asOf.toISOString().slice(0, 10)}`);
  show(`Follow up (quiet ${opts.followupDays}-${opts.staleDays - 1} days)`, followup);
  show(`Stale (quiet ${opts.staleDays}+ days)`, stale);
}
