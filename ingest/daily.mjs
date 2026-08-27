/**
 * The daily job run: find, filter, dedupe, rank, write.
 *
 * One routine, not two. Ranking is a deterministic function over data already
 * in hand, so splitting it into a second scheduled job buys nothing and adds a
 * race where the ranker scores a half-written batch. The ORDER is the point:
 * filter before ranking, because a rank is not a filter and scoring an
 * ineligible posting well just puts a job Brian cannot take at the top.
 *
 * It also repairs rows it did not create. Something other than this repo has
 * been writing to the same table, and whatever it is, it applies none of
 * Brian's rules and leaves match_pct null. Rather than depend on identifying
 * it, every run re-gates and re-ranks anything unranked -- so a row from any
 * source gets the same treatment within a day.
 *
 * PUBLIC REPO WARNING: this runs in GitHub Actions on a public repository,
 * where run logs are world-readable. --quiet prints counts only. Job postings
 * are public, but which ones Brian applied to, and how each scored against his
 * record, are not.
 *
 *   node ingest/daily.mjs --dry            # no writes, full detail
 *   node ingest/daily.mjs --write --quiet  # what CI runs
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from './cli.mjs';
import { decide } from './sync-to-d1.mjs';
import { fetchJd, scoreOne, boardRef, requirementsGate } from './fit-score.mjs';
import { runUpsert } from './upsert.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname)
  .replace(/^\/([A-Za-z]:)/, '$1'), '..');
const API = 'https://apply-dashboard.pages.dev/api/jobs';
const ACCOUNT = 'dd01b432f0329f87bb1cc1a3fad590ee';
const DATABASE = '10e8a6c0-1fa7-4c33-a007-2044876ce6a7';

const args = parseArgs();
const WRITE = !!args.write;
const QUIET = !!args.quiet;
const MAX_RANK = Number(args['max-rank'] || 120);
const TOKEN = process.env.CF_D1_TOKEN || '';

const say = (m) => process.stdout.write(m + '\n');
const detail = (m) => { if (!QUIET) process.stdout.write(m + '\n'); };

/** @param {string} sql */
async function d1(sql) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sql })
  });
  const j = await r.json();
  if (!j.success) throw new Error(`D1 rejected the query: ${JSON.stringify(j.errors)}`);
  return j;
}
const q = (v) => v === null || v === undefined || v === '' ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;

if (WRITE && !TOKEN) {
  say('FATAL: CF_D1_TOKEN is not set, so nothing could be written. Failing loudly rather than reporting a clean run that did nothing.');
  process.exit(1);
}

const started = Date.now();
const stats = { collected: 0, newRows: 0, ranked: 0, ruledOut: 0, jdRead: 0, errors: 0 };

/* ---- 1. collect ---------------------------------------------------- */
let collected = [];
try {
  await runUpsert({ query: 'product manager', limit: 400 });
  const out = JSON.parse(fs.readFileSync(path.join(ROOT, 'ingest', 'out', 'jobs.json'), 'utf8'));
  collected = out.jobs || [];
  stats.collected = collected.length;
} catch (e) {
  stats.errors++;
  say(`collect failed: ${e.message}`);
}
say(`collected ${stats.collected}`);

/* ---- 2. filter + dedupe against what is already there --------------- */
const existing = (await (await fetch(API, { headers: { 'cache-control': 'no-cache' } })).json()).jobs || [];
const { fresh, rejected } = decide(collected, existing);
say(`eligible and new: ${fresh.length}  (rejected: ${Object.entries(rejected).map(([k, v]) => `${k} ${v}`).join(', ')})`);
for (const r of fresh.slice(0, 25)) detail(`  + ${String(r.match_pct).padStart(3)} ${r.company} - ${r.title}`);

/* ---- 3. insert ------------------------------------------------------ */
if (WRITE && fresh.length) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  for (let i = 0; i < fresh.length; i += 25) {
    const chunk = fresh.slice(i, i + 25);
    const values = chunk.map(r => `(${[
      q(r.dedupe_key), q(r.company), q(r.title), q(r.url), r.match_pct ?? 'NULL',
      q(r.source), q('queued'), q(r.lane || 'ft'), q(r.posted), q(r.work_type), q(now), q('apply-daily')
    ].join(', ')})`).join(',\n');
    try {
      await d1(`INSERT OR IGNORE INTO jobs
        (dedupe_key, company, title, url, match_pct, source, status, lane, posted, work_type, updated_at, source_pipeline)
        VALUES\n${values}`);
      stats.newRows += chunk.length;
    } catch (e) { stats.errors++; say(`insert failed at ${i}: ${e.message}`); }
  }
}

/* ---- 4. gate and rank anything unranked, whoever wrote it ----------- */
const live = (await (await fetch(API, { headers: { 'cache-control': 'no-cache' } })).json()).jobs || [];
/* Quarantined rows are the other writer's. A database trigger forces anything
   not stamped 'apply-daily' into pending-review, so it is off Brian's list
   until it has been through his rules here. Whoever finds a job, the same gate
   decides whether he ever sees it. */
const quarantined = live.filter(j => j.status === 'pending-review');
say(`quarantined by another writer: ${quarantined.length}`);

/* Location and role need no description, so a quarantined posting whose URL
   cannot be read is still judged on those. Gating only readable rows left the
   unreadable ones quarantined forever, invisible and unjudged. */
for (const job of quarantined.filter(j => !boardRef(j.url))) {
  const g = requirementsGate(job, null);
  if (!WRITE) { detail(`  ${g.ok ? 'pass' : 'GATE'} ${job.company} - ${String(job.title).slice(0, 44)}`); continue; }
  try {
    if (!g.ok) {
      await d1(`UPDATE jobs SET status='skipped', blocked_reason='off-criteria',
        blocked_detail=${q(g.reasons.join('; ').slice(0, 400))},
        blocked_at=${q(new Date().toISOString())} WHERE dedupe_key=${q(job.dedupe_key)}`);
      stats.ruledOut++;
    } else {
      await d1(`UPDATE jobs SET status='queued', source_pipeline='apply-daily'
        WHERE dedupe_key=${q(job.dedupe_key)}`);
    }
  } catch (e) { stats.errors++; say(`quarantine gate failed: ${e.message}`); }
}

const needsRank = live
  .filter(j => j.status === 'queued' || j.status === 'pending-review')
  .filter(j => j.rank_pct === null || j.rank_pct === undefined)
  .filter(j => boardRef(j.url))            // ranking needs a readable description
  .slice(0, MAX_RANK);
say(`unranked and readable: ${needsRank.length}`);

for (const job of needsRank) {
  let jd = null;
  try { jd = await fetchJd(job.url); } catch { /* unreadable stays unread */ }
  if (jd) stats.jdRead++;
  const s = scoreOne(job, jd);
  if (!WRITE) {
    detail(`  ${String(s.rank ?? 'GATE').padStart(4)} ${job.company} - ${String(job.title).slice(0, 46)}`);
    continue;
  }
  try {
    if (!s.gate.ok) {
      await d1(`UPDATE jobs SET status='skipped', blocked_reason='off-criteria',
        blocked_detail=${q(s.gate.reasons.join('; ').slice(0, 400))},
        blocked_at=${q(new Date().toISOString())} WHERE dedupe_key=${q(job.dedupe_key)}`);
      stats.ruledOut++;
    } else {
      /* Passing the gate releases a quarantined row into the queue. */
      if (job.status === 'pending-review') {
        /* Stamping the pipeline is what the release trigger checks. Without it
           the row silently stays quarantined. */
        await d1(`UPDATE jobs SET status='queued', source_pipeline='apply-daily'
          WHERE dedupe_key=${q(job.dedupe_key)}`);
      }
      await d1(`UPDATE jobs SET rank_pct=${s.rank ?? 'NULL'},
        fit_pct=${s.fit ? s.fit.pct : 'NULL'}, success_pct=${s.success.pct},
        jd_read=${q(s.jdRead ? 'yes' : 'no')},
        rank_why=${q([...(s.fit ? s.fit.hits.slice(0, 4) : []), ...s.success.reasons].join(' | ').slice(0, 600))}
        WHERE dedupe_key=${q(job.dedupe_key)}`);
      stats.ranked++;
    }
  } catch (e) { stats.errors++; say(`rank write failed: ${e.message}`); }
}

/* ---- 5. report ------------------------------------------------------ */
const secs = Math.round((Date.now() - started) / 1000);
say('');
say(`collected ${stats.collected} | new ${stats.newRows} | ranked ${stats.ranked} | ruled out ${stats.ruledOut} | descriptions read ${stats.jdRead} | errors ${stats.errors} | ${secs}s`);
fs.writeFileSync(path.join(ROOT, 'ingest', 'out', 'daily-summary.json'),
  JSON.stringify({ at: new Date().toISOString(), write: WRITE, ...stats }, null, 2));

/* A run that wrote nothing and hit errors must not look like a quiet success. */
if (stats.errors) process.exitCode = 1;
