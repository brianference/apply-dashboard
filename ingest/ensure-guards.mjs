/**
 * Put the database's own protections back, and prove they hold.
 *
 * Written after `protect_submitted_status` vanished from sqlite_master between
 * one test and the next, and an un-submit went straight through the gap. A
 * guard that exists once is not a guard: something in this account's write path
 * removes them, so they are re-asserted and RE-ATTACKED on every daily run.
 *
 * Also restores any application the gap swallowed. applied_log is insert-only
 * and mirrors every submission, so it survives whatever clobbered the row.
 *
 *   node ingest/ensure-guards.mjs            # check and repair, then attack
 *   node ingest/ensure-guards.mjs --verify   # attack only, change nothing
 */

import { isCli, parseArgs } from './cli.mjs';

const ACCOUNT = 'dd01b432f0329f87bb1cc1a3fad590ee';
const DATABASE = '10e8a6c0-1fa7-4c33-a007-2044876ce6a7';

/** @param {string} sql @param {unknown[]} [params] */
export async function d1(sql, params) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.CF_D1_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(params ? { sql, params } : { sql })
  });
  return r.json();
}

/* Each guard is (name, SQL). Recreated unconditionally rather than with
   IF NOT EXISTS, because the failure being defended against is a guard that
   silently stopped existing. */
export const GUARDS = [
  ['applied_log', `CREATE TABLE IF NOT EXISTS applied_log (
      dedupe_key TEXT NOT NULL, submitted_at TEXT NOT NULL, recorded_at TEXT NOT NULL,
      PRIMARY KEY (dedupe_key, submitted_at))`],
  ['log_submitted_update', `CREATE TRIGGER log_submitted_update
      AFTER UPDATE ON jobs FOR EACH ROW WHEN NEW.submitted_at IS NOT NULL
      BEGIN INSERT OR IGNORE INTO applied_log VALUES (NEW.dedupe_key, NEW.submitted_at, datetime('now')); END`],
  ['log_submitted_insert', `CREATE TRIGGER log_submitted_insert
      AFTER INSERT ON jobs FOR EACH ROW WHEN NEW.submitted_at IS NOT NULL
      BEGIN INSERT OR IGNORE INTO applied_log VALUES (NEW.dedupe_key, NEW.submitted_at, datetime('now')); END`],
  ['protect_submitted_status', `CREATE TRIGGER protect_submitted_status
      BEFORE UPDATE ON jobs FOR EACH ROW WHEN OLD.status = 'submitted' AND NEW.status <> 'submitted'
      BEGIN SELECT RAISE(ABORT, 'refusing to un-submit an application'); END`],
  ['protect_submitted_at', `CREATE TRIGGER protect_submitted_at
      BEFORE UPDATE ON jobs FOR EACH ROW WHEN OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS NULL
      BEGIN SELECT RAISE(ABORT, 'refusing to clear submitted_at'); END`],
  ['protect_submitted_delete', `CREATE TRIGGER protect_submitted_delete
      BEFORE DELETE ON jobs FOR EACH ROW WHEN OLD.submitted_at IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'refusing to delete a submitted application'); END`],
  /* INSERT OR REPLACE is a delete plus an insert and SQLite does not fire the
     DELETE trigger for it, so this one has to sit on the INSERT side. */
  ['protect_submitted_replace', `CREATE TRIGGER protect_submitted_replace
      BEFORE INSERT ON jobs FOR EACH ROW
      WHEN NEW.submitted_at IS NULL
       AND EXISTS (SELECT 1 FROM jobs j WHERE j.dedupe_key = NEW.dedupe_key AND j.submitted_at IS NOT NULL)
      BEGIN SELECT RAISE(IGNORE); END`],
  ['quarantine_foreign_inserts', `CREATE TRIGGER quarantine_foreign_inserts
      AFTER INSERT ON jobs FOR EACH ROW
      WHEN NEW.source_pipeline IS NULL OR NEW.source_pipeline <> 'apply-daily'
      BEGIN UPDATE jobs SET status='pending-review'
        WHERE dedupe_key = NEW.dedupe_key AND submitted_at IS NULL; END`],
  ['reject_hostile_insert', `CREATE TRIGGER reject_hostile_insert
      BEFORE INSERT ON jobs FOR EACH ROW
      WHEN NEW.url IS NULL OR NEW.url NOT LIKE 'https://%' OR length(NEW.url) > 2048
        OR length(NEW.company) > 200 OR length(NEW.title) > 300
        OR length(coalesce(NEW.work_type,'')) > 500
        OR NEW.url LIKE '%javascript:%' OR NEW.url LIKE '%data:%'
        OR NEW.title LIKE '%<script%' OR NEW.company LIKE '%<script%'
      BEGIN SELECT RAISE(IGNORE); END`],
  ['reject_hostile_update', `CREATE TRIGGER reject_hostile_update
      BEFORE UPDATE OF url, title, company, work_type ON jobs FOR EACH ROW
      WHEN NEW.url NOT LIKE 'https://%' OR length(NEW.url) > 2048
        OR length(NEW.title) > 300 OR NEW.url LIKE '%javascript:%'
      BEGIN SELECT RAISE(ABORT, 'rejected: hostile or malformed field'); END`],
  ['reject_out_of_range', `CREATE TRIGGER reject_out_of_range
      BEFORE UPDATE ON jobs FOR EACH ROW
      WHEN (NEW.match_pct IS NOT NULL AND (NEW.match_pct < 0 OR NEW.match_pct > 100))
        OR (NEW.rank_pct IS NOT NULL AND (NEW.rank_pct < 0 OR NEW.rank_pct > 100))
        OR (NEW.fit_pct IS NOT NULL AND (NEW.fit_pct < 0 OR NEW.fit_pct > 100))
        OR (NEW.resume_pct IS NOT NULL AND (NEW.resume_pct < 0 OR NEW.resume_pct > 100))
        OR (NEW.success_pct IS NOT NULL AND (NEW.success_pct < 0 OR NEW.success_pct > 100))
        OR (NEW.salary_min IS NOT NULL AND (NEW.salary_min < 0 OR NEW.salary_min > 10000000))
      BEGIN SELECT RAISE(ABORT, 'percentage or salary out of range'); END`]
];

/** Recreate every guard. @returns {Promise<string[]>} names that were missing */
export async function repair() {
  const present = new Set(((await d1(
    "SELECT name FROM sqlite_master WHERE type IN ('trigger','table')")).result?.[0]?.results || []
  ).map(r => r.name));
  const missing = GUARDS.filter(([n]) => !present.has(n)).map(([n]) => n);
  for (const [name, sql] of GUARDS) {
    if (!sql.startsWith('CREATE TABLE')) await d1(`DROP TRIGGER IF EXISTS ${name}`);
    const out = await d1(sql);
    if (!out.success) throw new Error(`could not create ${name}: ${JSON.stringify(out.errors)}`);
  }
  return missing;
}

/** Put back any application the jobs table lost but the ledger still holds. */
export async function restoreFromLedger() {
  const out = await d1(`UPDATE jobs SET status='submitted', lane='submitted',
    submitted_at=(SELECT MIN(submitted_at) FROM applied_log a WHERE a.dedupe_key = jobs.dedupe_key)
    WHERE submitted_at IS NULL
      AND dedupe_key IN (SELECT dedupe_key FROM applied_log)`);
  return out.meta?.changes ?? out.result?.[0]?.meta?.changes ?? 0;
}

/** Attack every un-apply path. @returns {Promise<{failures: string[]}>} */
export async function attack() {
  const failures = [];
  const victim = (await d1("SELECT dedupe_key, status, submitted_at FROM jobs WHERE status='submitted' LIMIT 1"))
    .result?.[0]?.results?.[0];
  if (!victim) return { failures: ['no submitted row to test with'] };
  const k = [victim.dedupe_key];
  const mustAbort = async (label, sql, params) => {
    const o = await d1(sql, params);
    if (o.success) failures.push(label);
  };
  await mustAbort('un-submit via UPDATE', `UPDATE jobs SET status='queued' WHERE dedupe_key = ?`, k);
  await mustAbort('clear submitted_at', `UPDATE jobs SET submitted_at=NULL WHERE dedupe_key = ?`, k);
  await mustAbort('DELETE a submitted row', `DELETE FROM jobs WHERE dedupe_key = ?`, k);
  /* REPLACE is expected to SUCCEED as a statement while skipping the row, so
     this one is judged on the row's state, not the exit status. */
  await d1(`INSERT OR REPLACE INTO jobs (dedupe_key, company, title, url, status, lane, updated_at)
    VALUES (?, 'X', 'X', 'https://x.test/1', 'queued', 'ft', '2026-01-01T00:00:00Z')`, k);
  const after = (await d1(`SELECT status, submitted_at FROM jobs WHERE dedupe_key = ?`, k))
    .result?.[0]?.results?.[0];
  if (!after || after.status !== 'submitted' || after.submitted_at !== victim.submitted_at) {
    failures.push('the row did not survive the attack');
  }
  return { failures };
}

if (isCli(import.meta.url)) {
  const args = parseArgs();
  if (!process.env.CF_D1_TOKEN) { console.log('CF_D1_TOKEN not set'); process.exit(1); }
  if (!args.verify) {
    const missing = await repair();
    console.log(missing.length ? `guards that had gone missing: ${missing.join(', ')}` : 'all guards were present');
    const restored = await restoreFromLedger();
    console.log(`applications restored from the ledger: ${restored}`);
  }
  const { failures } = await attack();
  const n = (await d1("SELECT COUNT(*) c FROM jobs WHERE status='submitted'")).result[0].results[0].c;
  const logged = (await d1('SELECT COUNT(DISTINCT dedupe_key) c FROM applied_log')).result[0].results[0].c;
  console.log(`submitted rows: ${n} | distinct keys in the ledger: ${logged}`);
  if (failures.length) {
    console.log(`GUARD FAILURES: ${failures.join('; ')}`);
    process.exitCode = 1;
  } else {
    console.log('every un-apply path is blocked');
  }
}
