/**
 * Repair two columns that hold something other than what they promise.
 *
 * Both defects were found by reading the live queue rather than by a failing
 * test, which is why this file exists as well as the guards now in jobs.mjs:
 * the guards stop new rows going wrong, and nothing was going to fix the rows
 * already stored.
 *
 *   posted held text on 25 rows -- "Posted 2 Days Ago (startDate 2026-08-20)".
 *   The days-ago column rendered a broken age, the posted-within filter could
 *   not see the row, and date-backfill treated the text as PRESENT and so
 *   skipped it on every run. The real date is inside the string.
 *
 *   source carried case-variant duplicates: greenhouse beside Greenhouse,
 *   ashby beside Ashby, lever beside Lever, workday beside Workday. The
 *   capitalised spellings are older rows that stopped updating, so each board
 *   appeared twice in any per-source count, one of them looking dead.
 *
 * Idempotent by construction: it selects only rows that still need changing,
 * so a second run reports nothing to do. Submitted rows are never touched.
 *
 *   node ingest/repair-fields.mjs --dry     # report, change nothing
 *   CF_D1_TOKEN=... node ingest/repair-fields.mjs --write
 */

import { isCli, parseArgs } from './cli.mjs';
import { canonicalSource, isoFromUnknown } from './jobs.mjs';

const ACCOUNT = 'dd01b432f0329f87bb1cc1a3fad590ee';
const DATABASE = '10e8a6c0-1fa7-4c33-a007-2044876ce6a7';

/**
 * @param {string} sql
 * @param {unknown[]} [params]
 * @returns {Promise<any>}
 */
export async function d1(sql, params) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.CF_D1_TOKEN}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(params ? { sql, params } : { sql })
    }
  );
  const body = await res.json();
  if (!body || body.success !== true) {
    const why = body && body.errors ? JSON.stringify(body.errors) : `HTTP ${res.status}`;
    throw new Error(`d1 query failed: ${why}`);
  }
  return body;
}

/**
 * Rows whose stored date is not a date, with the value the repair would write.
 *
 * A row is only listed when the replacement DIFFERS from what is stored, so the
 * count is a count of real changes rather than of rows examined.
 *
 * @param {Array<{ dedupe_key: string, posted: string|null, refreshed_at: string|null }>} rows
 * @returns {Array<{ dedupe_key: string, column: 'posted'|'refreshed_at', from: string, to: string|null }>}
 */
export function dateRepairs(rows) {
  const out = [];
  for (const row of rows || []) {
    for (const column of ['posted', 'refreshed_at']) {
      const stored = row[column];
      if (stored == null || stored === '') continue;
      /* A value that PARSES is already doing its job, whatever its shape.
         Repairing on "does it normalise to itself" instead rewrote all 150
         date-only values into midnight timestamps -- churn that changes no
         behaviour, and that would have made every run report changes forever
         so no report meant anything. Only text that is not a date is touched. */
      if (!Number.isNaN(new Date(stored).getTime())) continue;
      const fixed = isoFromUnknown(stored);
      out.push({ dedupe_key: row.dedupe_key, column, from: String(stored), to: fixed });
    }
  }
  return out;
}

/**
 * Rows whose source label differs from its module id only by case.
 *
 * @param {Array<{ dedupe_key: string, source: string|null }>} rows
 * @returns {Array<{ dedupe_key: string, from: string, to: string }>}
 */
export function sourceRepairs(rows) {
  const out = [];
  for (const row of rows || []) {
    const stored = row.source == null ? '' : String(row.source);
    const fixed = canonicalSource(stored);
    if (!fixed || fixed === stored) continue;
    out.push({ dedupe_key: row.dedupe_key, from: stored, to: fixed });
  }
  return out;
}

/**
 * @param {(sql: string, params?: unknown[]) => Promise<any>} query
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function readRows(query) {
  const body = await query('SELECT dedupe_key, posted, refreshed_at, source FROM jobs');
  const first = body && body.result && body.result[0];
  return (first && first.results) || [];
}

/**
 * @param {{ write?: boolean, query?: (sql: string, params?: unknown[]) => Promise<any> }} [options]
 * @returns {Promise<{ dates: number, sources: number, wrote: boolean, rows: number }>}
 */
export async function repairFields(options = {}) {
  const query = options.query || d1;
  const rows = await readRows(query);
  const dates = dateRepairs(rows);
  const sources = sourceRepairs(rows);

  for (const fix of dates) {
    console.log(`  ${fix.column}: ${JSON.stringify(fix.from).slice(0, 52)} -> ${JSON.stringify(fix.to)}`);
  }
  const bySpelling = new Map();
  for (const fix of sources) bySpelling.set(fix.from, (bySpelling.get(fix.from) || 0) + 1);
  for (const [from, n] of bySpelling) console.log(`  source: ${n} x ${from} -> ${canonicalSource(from)}`);

  if (!options.write) {
    console.log(`\n${dates.length} date value(s) and ${sources.length} source label(s) would change across ${rows.length} rows`);
    return { dates: dates.length, sources: sources.length, wrote: false, rows: rows.length };
  }

  for (const fix of dates) {
    await query(
      `UPDATE jobs SET ${fix.column} = ? WHERE dedupe_key = ? AND status != 'submitted'`,
      [fix.to, fix.dedupe_key]
    );
  }
  for (const fix of sources) {
    await query(
      `UPDATE jobs SET source = ? WHERE dedupe_key = ? AND status != 'submitted'`,
      [fix.to, fix.dedupe_key]
    );
  }
  console.log(`\nwrote ${dates.length} date value(s) and ${sources.length} source label(s) across ${rows.length} rows`);
  return { dates: dates.length, sources: sources.length, wrote: true, rows: rows.length };
}

if (isCli(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const write = Boolean(args.write);
  if (write && !process.env.CF_D1_TOKEN) {
    console.error('CF_D1_TOKEN is not set, so nothing could be written. Failing rather than reporting a clean run that did nothing.');
    process.exitCode = 1;
  } else {
    const result = await repairFields({ write });
    /* Nothing to do is the expected steady state once this has run, so it is
       not an error. A failure to WRITE is, and d1() throws on that. */
    if (!result.wrote && (result.dates || result.sources)) {
      console.log('(dry run, nothing written)');
    }
  }
}
