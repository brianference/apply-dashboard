/**
 * Collapse postings that are already stored twice.
 *
 * `decide()` in sync-to-d1.mjs stops new duplicates on three signals -- key,
 * normalised URL, and `sameJob` on normalised company and title. What no code
 * did was clean up the rows that entered BEFORE those guards, so four postings
 * were sitting in the database twice:
 *
 *   Twilio, one title carrying " - Twilio" appended by a second board. BOTH
 *   rows submitted, at the same timestamp. That is the duplicate application
 *   the whole rule exists to prevent.
 *   Temporal, one title with a double space.
 *   Mitratech, the appended-employer shape again.
 *   Kin and Kin Insurance, the same employer written two ways -- named in
 *   sync-to-d1's own comment as the motivating case, and still not caught by
 *   `sameJob`, because the company strings differ.
 *
 * Grouping is by NORMALISED URL, which is the one signal that is unambiguous
 * when the company name is written two ways. Two rows pointing at the same
 * posting are the same posting.
 *
 * A submitted row is never rewritten. The database refuses it anyway, and it
 * should: an application that happened is history. Where a duplicate PAIR is
 * both submitted, this reports it and changes nothing, because choosing which
 * of two real applications to erase is not a decision code should make.
 *
 *   node ingest/dedupe-repair.mjs --dry
 *   CF_D1_TOKEN=... node ingest/dedupe-repair.mjs --write
 */

import { isCli, parseArgs } from './cli.mjs';
import { normalizeUrl } from './sync-to-d1.mjs';

const ACCOUNT = 'dd01b432f0329f87bb1cc1a3fad590ee';
const DATABASE = '10e8a6c0-1fa7-4c33-a007-2044876ce6a7';
const API = 'https://apply-dashboard.pages.dev/api/jobs';

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

/** Which row to keep, best first. A submitted row always wins. */
const STATUS_RANK = { submitted: 0, queued: 1, 'pending-review': 2, skipped: 3 };

/**
 * Order rows so the one to KEEP comes first.
 *
 * Submitted first, because history outranks everything. Then the row carrying
 * the most information, so collapsing a pair never throws away the only copy
 * of a published band or a posted date. The shorter dedupe_key breaks a tie,
 * since the longer one is usually the key with the employer appended to the
 * title.
 *
 * @param {Array<Record<string, any>>} group
 * @returns {Array<Record<string, any>>}
 */
export function rankForKeeping(group) {
  const score = (r) => (r.salary_min != null ? 2 : 0) + (r.posted ? 1 : 0) + (r.match_pct != null ? 1 : 0);
  return [...group].sort((a, b) => {
    const sa = STATUS_RANK[a.status] ?? 9;
    const sb = STATUS_RANK[b.status] ?? 9;
    if (sa !== sb) return sa - sb;
    const ia = score(b) - score(a);
    if (ia !== 0) return ia;
    return String(a.dedupe_key).length - String(b.dedupe_key).length;
  });
}

/**
 * Group rows by normalised URL and decide what to do with each duplicate.
 *
 * @param {Array<Record<string, any>>} rows
 * @returns {{ collapse: Array<{keep: string, drop: string, url: string, status: string}>, conflicted: Array<{url: string, keys: string[]}> }}
 */
export function planDedupe(rows) {
  const byUrl = new Map();
  for (const row of rows || []) {
    if (!row || !row.url) continue;
    /* A row already settled as a duplicate is out of the grouping entirely.
       It keeps its URL after being marked, so leaving it in made every run
       re-mark it -- work that changes nothing and makes the count meaningless
       from the second run onward. */
    if (row.blocked_reason === 'duplicate') continue;
    const key = normalizeUrl(row.url);
    if (!key) continue;
    byUrl.set(key, (byUrl.get(key) || []).concat(row));
  }

  const collapse = [];
  const conflicted = [];
  for (const [url, group] of byUrl) {
    if (group.length < 2) continue;
    const ordered = rankForKeeping(group);
    const keep = ordered[0];
    const rest = ordered.slice(1);

    /* Two real applications for one posting. Nothing here can decide which one
       to erase, and the database refuses the write in any case. */
    const submittedRest = rest.filter((r) => r.status === 'submitted' || r.submitted_at);
    if (submittedRest.length) {
      conflicted.push({ url, keys: group.map((r) => r.dedupe_key) });
      continue;
    }
    for (const row of rest) {
      collapse.push({ keep: keep.dedupe_key, drop: row.dedupe_key, url, status: row.status });
    }
  }
  return { collapse, conflicted };
}

/**
 * @param {{ write?: boolean, rows?: Array<Record<string, any>>, query?: Function }} [options]
 */
export async function repairDuplicates(options = {}) {
  const query = options.query || d1;
  const rows = options.rows
    || ((await (await fetch(API, { headers: { 'cache-control': 'no-cache' } })).json()).jobs || []);

  const { collapse, conflicted } = planDedupe(rows);

  for (const c of collapse) {
    console.log(`  drop ${JSON.stringify(c.drop).slice(0, 56)} (${c.status}) -> keep ${JSON.stringify(c.keep).slice(0, 56)}`);
  }
  for (const c of conflicted) {
    console.log(`  BOTH SUBMITTED, left alone: ${c.url.slice(0, 60)}`);
    for (const k of c.keys) console.log(`      ${k.slice(0, 70)}`);
  }

  if (!options.write) {
    console.log(`\n${collapse.length} duplicate row(s) would be marked, ${conflicted.length} pair(s) left alone across ${rows.length} rows`);
    return { collapsed: 0, planned: collapse.length, conflicted: conflicted.length, wrote: false };
  }

  let collapsed = 0;
  for (const c of collapse) {
    /* Marked, not deleted. The row keeps its history and its key, and anything
       referring to it -- an outcome, an experiment arm -- still resolves. */
    await query(
      `UPDATE jobs SET status = 'skipped', blocked_reason = 'duplicate', blocked_detail = ?,
        rank_pct = NULL, pay_tier = NULL
       WHERE dedupe_key = ? AND status != 'submitted'`,
      [`the same posting is already stored as ${c.keep}`, c.drop]
    );
    collapsed += 1;
  }
  console.log(`\nmarked ${collapsed} duplicate row(s); ${conflicted.length} pair(s) are both submitted and were left alone`);
  return { collapsed, planned: collapse.length, conflicted: conflicted.length, wrote: true };
}

if (isCli(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const write = Boolean(args.write);
  if (write && !process.env.CF_D1_TOKEN) {
    console.error('CF_D1_TOKEN is not set, so nothing could be written. Failing rather than reporting a clean run that did nothing.');
    process.exitCode = 1;
  } else {
    await repairDuplicates({ write });
  }
}
