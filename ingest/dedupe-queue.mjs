/**
 * Find duplicate postings already sitting side by side in the queue.
 *
 * The ingest-time guard in sync-to-d1.mjs (exact dedupe_key, exact URL, and
 * now normalised company+title -- see ingest/match.mjs sameJob()) only sees
 * rows that pass through this repo's own pipeline. Something outside the
 * repo writes rows directly to D1 -- capitalised source tags (Ashby,
 * Greenhouse, Workday, Indeed, LinkedIn), minute-truncated updated_at -- and
 * none of Brian's dedupe rules ever run on those before they land. Kin
 * ("Kin" / "Kin Insurance", the identical Ashby URL, one row sourced
 * "LinkedIn" and one "Ashby") is exactly that: both queued, both applyable,
 * and the ingest-time guard never had a chance to see either one.
 *
 * This is the retroactive counterpart. It looks at what is ALREADY in D1,
 * not what is about to be written, and groups rows on the same two
 * signatures the ingest-time guard uses -- an identical URL (tracking
 * params aside) and a normalised company+title match -- regardless of which
 * source or writer produced each row.
 *
 * A submitted row is history, same as everywhere else in this pipeline: it
 * is never rewritten, but if it has a still-queued duplicate, that duplicate
 * is a live risk of a second application and is exactly what this exists to
 * catch. Two rows BOTH marked submitted for the same posting are reported,
 * never written -- that already happened and rewriting history is not this
 * script's job.
 *
 * Only a normalised company+title match with no title similarity beyond
 * that -- "Product Manager - AI Stockbroking" next to "... AI Stockbroking
 * App" -- is deliberately left alone. CRITERIA.md's own Cisco example
 * ("Product Manager" vs "Product Manager - Partner Experience") is the
 * reason: two different roles at the same company can share almost all of
 * their words, and collapsing them would quietly stop Brian applying to a
 * job he wants. sameJob() only fires when normalisation makes the two
 * titles IDENTICAL, not merely similar, so that pair is correctly never
 * grouped here.
 *
 *   node ingest/dedupe-queue.mjs                # report only
 *   CF_D1_TOKEN=... node ingest/dedupe-queue.mjs --write
 */

import { isCli, parseArgs } from './cli.mjs';
import { logInfo, logWarn } from './logger.mjs';
import { sameJob } from './match.mjs';
import { normalizeUrl } from './sync-to-d1.mjs';

const API = 'https://apply-dashboard.pages.dev/api/jobs';
const ACCOUNT = 'dd01b432f0329f87bb1cc1a3fad590ee';
const DATABASE = '10e8a6c0-1fa7-4c33-a007-2044876ce6a7';

const LIVE = new Set(['queued', 'submitted']);

/**
 * Group rows that are the same posting under different dedupe keys.
 *
 * Union-find over indices: two rows merge into one group if they share
 * EITHER signature. Transitive by construction, so A~B (same URL) and B~C
 * (same normalised title) land A, B and C in one group even though A and C
 * might match on neither signature directly.
 *
 * @param {Array<Record<string, any>>} rows
 * @returns {Array<Array<Record<string, any>>>} groups of size >= 2
 */
export function findDuplicateGroups(rows) {
  const live = rows.filter((r) => LIVE.has(r.status));
  const parent = live.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[ra] = rb; };

  const byUrl = new Map();
  for (let i = 0; i < live.length; i++) {
    const u = normalizeUrl(live[i].url);
    if (!u) continue;
    if (byUrl.has(u)) union(byUrl.get(u), i);
    else byUrl.set(u, i);
  }
  /* O(n^2) on the normalised-title check, same as apply/batch.mjs's own
     last-second scan over the live queue -- a few hundred rows, negligible. */
  for (let i = 0; i < live.length; i++) {
    for (let k = i + 1; k < live.length; k++) {
      if (sameJob(live[i], live[k])) union(i, k);
    }
  }

  const groups = new Map();
  for (let i = 0; i < live.length; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(live[i]);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

/**
 * Which row in a duplicate group to keep, and what to do with the rest.
 *
 * A submitted row always wins -- Brian has already applied, and the
 * duplicate is the risk, not the history. Two submitted rows in the same
 * group is an anomaly this script reports and does not touch: it already
 * happened, and neither row is history to rewrite here. Otherwise the
 * highest-ranked queued row is kept: it carries the most information about
 * whether the posting is worth his time, and the rest are the copies.
 *
 * @param {Array<Record<string, any>>} group
 * @returns {{keeper: Record<string, any>|null, drop: Array<Record<string, any>>, note: string}}
 */
export function decideKeeper(group) {
  const submitted = group.filter((r) => r.status === 'submitted');
  if (submitted.length > 1) {
    return { keeper: null, drop: [], note: `${submitted.length} rows already submitted for the same posting -- reported, not rewritten` };
  }
  if (submitted.length === 1) {
    const keeper = submitted[0];
    return { keeper, drop: group.filter((r) => r !== keeper), note: 'kept the submitted row' };
  }
  const ranked = [...group].sort((a, b) => {
    const ra = a.rank_pct == null ? -1 : Number(a.rank_pct);
    const rb = b.rank_pct == null ? -1 : Number(b.rank_pct);
    if (ra !== rb) return rb - ra;
    const pa = a.posted ? Date.parse(a.posted) : Infinity;
    const pb = b.posted ? Date.parse(b.posted) : Infinity;
    if (pa !== pb) return pa - pb;
    return String(a.dedupe_key).localeCompare(String(b.dedupe_key));
  });
  const keeper = ranked[0];
  return { keeper, drop: ranked.slice(1), note: `kept the highest-ranked queued row (rank_pct ${keeper.rank_pct ?? 'null'})` };
}

/**
 * @param {Record<string, any>} row the row to mark as a duplicate
 * @param {Record<string, any>} keeper the row it duplicates
 * @returns {{sql: string, params: Array<string|number|null>}}
 */
export function duplicateWrite(row, keeper) {
  return {
    sql: `UPDATE jobs SET status = ?, blocked_reason = ?, blocked_detail = ?,
      rank_pct = NULL, pay_tier = NULL
      WHERE dedupe_key = ? AND status = ?`,
    params: [
      'skipped',
      'duplicate-posting',
      `same posting as ${keeper.dedupe_key}`.slice(0, 400),
      row.dedupe_key,
      row.status
    ]
  };
}

if (isCli(import.meta.url)) {
  const args = parseArgs();
  const doWrite = !!args.write;
  const token = process.env.CF_D1_TOKEN || '';
  if (doWrite && !token) {
    logWarn('CF_D1_TOKEN is not set, so --write would change nothing', {});
    process.exit(1);
  }

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
  const groups = findDuplicateGroups(rows);
  logInfo('dedupe-queue', { rowsExamined: rows.length, duplicateGroups: groups.length });

  let dropped = 0;
  for (const group of groups) {
    const { keeper, drop, note } = decideKeeper(group);
    logInfo('group', {
      members: group.map((r) => `${r.dedupe_key} (${r.status}, ${r.source})`),
      note
    });
    if (!keeper) continue;
    for (const row of drop) {
      logInfo('drop', { dedupe_key: row.dedupe_key, keeps: keeper.dedupe_key });
      if (!doWrite) continue;
      const w = duplicateWrite(row, keeper);
      const meta = await run(w.sql, w.params);
      if (meta.changes) dropped += 1;
    }
  }

  logInfo('dedupe-queue complete', { duplicateGroups: groups.length, dropped });
  if (!doWrite) logWarn('nothing written', { hint: 'pass --write to apply' });
}
