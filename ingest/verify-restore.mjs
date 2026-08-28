/**
 * Prove a restore point restores, on the table that broke it.
 *
 * The .sql files write one statement per line. That only holds if no value
 * contains a newline, and `profile.resume_text` holds the whole resume - so
 * restoring it failed with `unrecognized token: "'BRIAN FERENCE`. Newlines are
 * emitted as char(10) concatenation now. This checks that, by rebuilding each
 * table's schema as a throwaway, restoring into it, comparing, and dropping it.
 */

import fs from 'node:fs';
import path from 'node:path';

const ACCOUNT = 'dd01b432f0329f87bb1cc1a3fad590ee';
const DATABASE = '10e8a6c0-1fa7-4c33-a007-2044876ce6a7';
const NL = String.fromCharCode(10);
const ROOT = 'C:/Users/brian/workspace/apply-dashboard';

/**
 * @param {string} sql
 * @returns {Promise<object[]>}
 */
async function q(sql) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.CF_D1_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sql })
    }
  );
  const json = await res.json();
  if (!json.success) throw new Error(JSON.stringify(json.errors).slice(0, 250));
  return (json.result && json.result[0] && json.result[0].results) || [];
}

let bad = 0;
for (const table of ['profile', 'jobs', 'users', 'applied_log']) {
  const dir = path.join(ROOT, 'backups');
  const file = fs.readdirSync(dir).filter((f) => f.startsWith(table + '-') && f.endsWith('.sql')).sort().pop();
  if (!file) { console.log(`  SKIP ${table}: no restore point`); continue; }
  const statements = fs.readFileSync(path.join(dir, file), 'utf8')
    .split(NL).filter((l) => l.startsWith('INSERT OR REPLACE'));

  const ddl = (await q(`SELECT sql FROM sqlite_master WHERE type='table' AND name='${table}'`))[0].sql;
  const probe = 'restore_probe_' + table;
  /* Rename by cutting at the first '(' rather than by regex: the table name
     appears again inside the column list of some of these schemas. */
  const open = ddl.indexOf('(');
  const rebuilt = 'CREATE TABLE ' + probe + ' ' + ddl.slice(open);

  await q(`DROP TABLE IF EXISTS ${probe}`);
  await q(rebuilt);

  const sample = statements.slice(0, 40);
  for (const s of sample) {
    await q(s.replace(`INSERT OR REPLACE INTO ${table} `, `INSERT OR REPLACE INTO ${probe} `));
  }
  const n = (await q(`SELECT count(*) AS n FROM ${probe}`))[0].n;

  let detail = '';
  if (table === 'profile') {
    const a = (await q(`SELECT length(resume_text) AS len, display_name FROM ${probe}`))[0];
    const b = (await q('SELECT length(resume_text) AS len, display_name FROM profile'))[0];
    detail = a.len === b.len && a.display_name === b.display_name
      ? `resume ${a.len} chars round-tripped exactly`
      : `MISMATCH ${a.len} vs ${b.len}`;
    if (a.len !== b.len) bad++;
  }

  await q(`DROP TABLE ${probe}`);
  const gone = (await q(`SELECT count(*) AS n FROM sqlite_master WHERE name='${probe}'`))[0].n === 0;
  const ok = n === sample.length && gone;
  if (!ok) bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${table.padEnd(12)} ${n}/${sample.length} restored, probe dropped: ${gone}  ${detail}`);
}

console.log(bad ? `\n${bad} failing` : '\nPASS every restore point restores, including multi-line text');
process.exit(bad ? 1 : 0);
