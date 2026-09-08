/**
 * Collect the careers sites that need a browser, and load what passes.
 *
 * Separate from daily.mjs on purpose. That runs in a plain Node step with no
 * Chromium; this runs in the step that has one. Splitting them means a browser
 * that fails to launch costs these two employers and nothing else.
 *
 * Everything a row must survive is the SAME gate the rest of the queue goes
 * through -- decide() in sync-to-d1.mjs, which applies the role rule, the
 * location rule, and all three duplicate checks against what is already
 * stored. Nothing here writes a row the ordinary pipeline would have refused.
 *
 *   node ingest/browser-sweep.mjs --dry
 *   CF_D1_TOKEN=... node ingest/browser-sweep.mjs --write
 */

import { isCli, parseArgs } from './cli.mjs';
import { logInfo, logWarn } from './logger.mjs';
import { decide } from './sync-to-d1.mjs';
import { fetchJobs } from './sources/browser-boards.mjs';

const ACCOUNT = 'dd01b432f0329f87bb1cc1a3fad590ee';
const DATABASE = '10e8a6c0-1fa7-4c33-a007-2044876ce6a7';
const API = 'https://apply-dashboard.pages.dev/api/jobs';

/**
 * What he is actually looking for.
 *
 * The remote and Arizona variants matter more here than anywhere else. A first
 * pass with the plain titles alone collected 23 rows and the location rule
 * refused 22 of them, all correctly: they were on-site roles in Minnesota,
 * Georgia, Colorado, Texas and New York, and the rule is remote-or-Arizona.
 *
 * These two employers put the remote flag in the TITLE -- "Facets Product
 * Consultant (Remote - US)" -- while the location field still names the office
 * city, so asking for "remote" is what surfaces them at all.
 */
export const QUERIES = [
  'product manager remote',
  'product manager Arizona',
  'senior product manager remote',
  'principal product manager remote',
  'product owner remote',
  'product manager',
  'director of product remote'
];

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
 * Collect across every query, keeping the first copy of each URL.
 *
 * The queries overlap heavily -- "product manager" and "senior product
 * manager" return many of the same postings -- so without this the same job is
 * offered to decide() four times and the rejection counts read as four times
 * the real duplication.
 *
 * @param {{ collect?: Function, queries?: string[], pages?: number }} [options]
 * @returns {Promise<Array<object>>}
 */
export async function collectAll(options = {}) {
  const collect = options.collect || fetchJobs;
  const queries = options.queries || QUERIES;
  const byUrl = new Map();
  for (const query of queries) {
    let found = [];
    try {
      found = await collect({ query, pages: options.pages });
    } catch (error) {
      /* One query failing must not lose the others. */
      logWarn('browser sweep query failed', {
        query, error: String(error && error.message || error).slice(0, 140)
      });
      continue;
    }
    for (const job of found) {
      if (job && job.url && !byUrl.has(job.url)) byUrl.set(job.url, job);
    }
  }
  return [...byUrl.values()];
}

/**
 * @param {{ write?: boolean, collect?: Function, query?: Function, existing?: object[] }} [options]
 */
export async function runBrowserSweep(options = {}) {
  const query = options.query || d1;
  const candidates = await collectAll(options);
  logInfo('browser sweep collected', { candidates: candidates.length });

  const existing = options.existing
    || ((await (await fetch(API, { headers: { 'cache-control': 'no-cache' } })).json()).jobs || []);
  const { fresh, rejected } = decide(candidates, existing);
  logInfo('browser sweep judged', { fresh: fresh.length, ...rejected });

  for (const row of fresh) {
    console.log(`  + ${String(row.company).padEnd(11)} ${String(row.work_type || '-').slice(0, 34).padEnd(34)} ${row.title.slice(0, 52)}`);
  }

  if (!options.write) {
    console.log(`\n${fresh.length} row(s) would be added from ${candidates.length} collected`);
    return { candidates: candidates.length, fresh: fresh.length, wrote: 0, rejected };
  }

  const now = new Date().toISOString();
  let wrote = 0;
  for (const row of fresh) {
    try {
      /* INSERT OR IGNORE and source_pipeline 'apply-daily', matching daily.mjs:
         a row stamped anything else is forced into pending-review by a database
         trigger, and these have already been through the same gate. */
      await query(
        `INSERT OR IGNORE INTO jobs
          (dedupe_key, company, title, url, match_pct, source, status, lane, posted, refreshed_at, work_type, updated_at, source_pipeline)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, 'apply-daily')`,
        [row.dedupe_key, row.company, row.title, row.url, row.match_pct ?? null,
          row.source, row.lane || 'ft', row.posted, row.refreshed_at, row.work_type, now]
      );
      wrote += 1;
    } catch (error) {
      logWarn('browser sweep insert failed', {
        dedupe_key: row.dedupe_key, error: String(error && error.message || error).slice(0, 140)
      });
    }
  }
  console.log(`\nwrote ${wrote} of ${fresh.length} new row(s) from ${candidates.length} collected`);
  return { candidates: candidates.length, fresh: fresh.length, wrote, rejected };
}

if (isCli(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const write = Boolean(args.write);
  if (write && !process.env.CF_D1_TOKEN) {
    console.error('CF_D1_TOKEN is not set, so nothing could be written. Failing rather than reporting a clean run that did nothing.');
    process.exitCode = 1;
  } else {
    await runBrowserSweep({ write });
  }
}
