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
import { fetchJd, scoreOne, boardRef, requirementsGate, rankWrite, strip, publishedStarts } from './fit-score.mjs';
import { salaryFromAshbyCompensation, salaryFromText } from './salary-from-posting.mjs';
import { judgeBand, FLOOR } from './salary-sweep.mjs';
import { ensurePayColumns } from './pay-columns.mjs';
import { runUpsert } from './upsert.mjs';
import { readCachedAshbyCompensation } from './salary-audit.mjs';

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
/**
 * Run one statement. Pass `params` and use `?` placeholders wherever the value
 * came from outside this repo - a job title, a company name, a pay figure
 * scraped off somebody else's board. The rest of this file predates that and
 * still interpolates through q(); new statements should not.
 *
 * @param {string} sql
 * @param {Array<string|number|null>} [params]
 */
async function d1(sql, params) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(params === undefined ? { sql } : { sql, params })
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
if (WRITE) {
  /* Schema first, or INSERT names refreshed_at against a table that does
     not have it and every new row of the run is lost. */
  try { await ensurePayColumns(d1); }
  catch (e) { stats.errors++; say(`schema ensure failed: ${e.message}`); }
}
if (WRITE && fresh.length) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  for (let i = 0; i < fresh.length; i += 25) {
    const chunk = fresh.slice(i, i + 25);
    const values = chunk.map(r => `(${[
      q(r.dedupe_key), q(r.company), q(r.title), q(r.url), r.match_pct ?? 'NULL',
      q(r.source), q('queued'), q(r.lane || 'ft'), q(r.posted), q(r.refreshed_at), q(r.work_type), q(now), q('apply-daily')
    ].join(', ')})`).join(',\n');
    try {
      await d1(`INSERT OR IGNORE INTO jobs
        (dedupe_key, company, title, url, match_pct, source, status, lane, posted, refreshed_at, work_type, updated_at, source_pipeline)
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

/* Fetch every description FIRST. resumeMatch weighs a posting's terms against
   how rare they are across the cached corpus, and the corpus is those cached
   files -- so scoring while the cache is still filling measures against almost
   nothing. On a fresh CI runner the cache starts empty, which is why the
   twice-daily run produced no resume scores at all. */
const descriptions = new Map();
for (const job of needsRank) {
  try {
    const jd = await fetchJd(job.url);
    if (jd) { descriptions.set(job.dedupe_key, jd); stats.jdRead++; }
  } catch { /* unreadable stays unread */ }
}
say(`descriptions fetched before scoring: ${descriptions.size}`);

/* Read the pay band off the SAME description that was just fetched for
   scoring. This is the connection that was missing: the ranking pass held the
   text, the extractor could parse it, and nothing joined them - so a Lever
   posting reading "Base salary: $135,000-$155,000 annually" was scored 83 and
   listed with no salary, twenty-five thousand under the floor. 184 of 201 open
   rows had no band recorded while their postings published one. */
const bands = new Map();
for (const job of needsRank) {
  const jd = descriptions.get(job.dedupe_key) || null;
  /* Structured Ashby pay wins over anything in the description. The feed
     carries the band as numbers; descriptionPlain for Teamworks is 5857
     characters with none. salary_source is ashby:compensation for that
     path and posting:daily for a regex over prose, because a field the
     employer typed and a number a regex found fail in different ways. */
  const structured = salaryFromAshbyCompensation(readCachedAshbyCompensation(job.url));
  if (structured.min != null || structured.max != null) {
    bands.set(job.dedupe_key, { ...structured, source: 'ashby:compensation' });
    continue;
  }
  if (!jd) continue;
  /* strip() again: cached files from the old decoder still contain
     `&lt;span&gt;` and `&mdash;`, and salaryFromText then reports no band.
     New fetches are already stripped; running it twice is a no-op on those. */
  const band = salaryFromText(strip(jd));
  if (band.min != null) bands.set(job.dedupe_key, { ...band, source: 'posting:daily' });
}
say(`pay bands read from those descriptions: ${bands.size}`);

/* Pay percentile is against THIS run's published starts, built once so a
   posting scored first is not judged against a shorter list than one
   scored last. Unpriced rows are omitted here and take the median inside
   scoreOne -- leaving them out of the distribution is what makes 50 mean
   "average of the priced ones", not "average of a list padded with zeros". */
const payStarts = publishedStarts(needsRank.map((job) => {
  const band = bands.get(job.dedupe_key);
  return band ? { ...job, salary_min: band.min, salary_max: band.max } : job;
}));

for (const job of needsRank) {
  const jd = descriptions.get(job.dedupe_key) || null;
  const band = bands.get(job.dedupe_key) || null;
  /* Score against the band we just read, not the stale stored one. Otherwise
     pay_tier is computed as unknown on the same pass that writes the band. */
  const scoredJob = band
    ? { ...job, salary_min: band.min, salary_max: band.max }
    : job;
  const s = scoreOne(scoredJob, jd, payStarts);
  /* A published band under the floor rules the row out here, before it can be
     ranked well and shown. An ABSENT band is unknown, not low, and never
     rules anything out - that distinction is the whole point. */
  if (band && judgeBand(band) === 'below-floor' && s.gate.ok) {
    s.gate.ok = false;
    s.gate.reasons = (s.gate.reasons || []).concat(
      `published band starts at $${band.min}, under the $${FLOOR} floor`
    );
    s.rank = null;
    s.pay_tier = null;
  }
  if (!WRITE) {
    detail(`  ${String(s.rank ?? 'GATE').padStart(4)} ${job.company} - ${String(job.title).slice(0, 46)}`);
    continue;
  }
  try {
    /* Write the band FIRST, including when the gate fails. Ruling a row
       out without storing the figure is how a published salary gets lost
       a second time. */
    if (band) {
      const minPay = Number(band.min);
      const maxPay = band.max === null || band.max === undefined ? null : Number(band.max);
      if (Number.isFinite(minPay) && (maxPay === null || Number.isFinite(maxPay))) {
        await d1(
          'UPDATE jobs SET salary_min = ?, salary_max = ?, salary_source = ? WHERE dedupe_key = ?',
          [minPay, maxPay, band.source || 'posting:daily', job.dedupe_key]
        );
      }
    }
    if (!s.gate.ok) {
      /* excluded_domain is written as a bare value so the list can offer it as
         a switch. A signed-in account can turn healthcare, construction,
         clearance or risk-compliance postings back on, and that needs
         something switchable rather than a phrase to parse out of blocked_detail.
         rank_pct and pay_tier are cleared in the same statement: a later band
         that fails the gate used to leave the old rank sitting. */
      const w = rankWrite({ ...s, job });
      await d1(w.sql, w.params);
      stats.ruledOut++;
    } else {
      /* Passing the gate releases a quarantined row into the queue. */
      if (job.status === 'pending-review') {
        /* Stamping the pipeline is what the release trigger checks. Without it
           the row silently stays quarantined. */
        await d1(`UPDATE jobs SET status='queued', source_pipeline='apply-daily'
          WHERE dedupe_key=${q(job.dedupe_key)}`);
      }
      /* resume_pct was missing from this statement while fit-score.mjs wrote
         it, so every posting the DAILY run ranked came out with no resume
         score at all -- eight in a row before anyone looked. The two write
         paths now agree. */
      const w = rankWrite({ ...s, job });
      await d1(w.sql, w.params);
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
