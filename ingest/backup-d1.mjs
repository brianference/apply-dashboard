/**
 * Take a restore point of the jobs table.
 *
 * The previous backup was made by hand, and its INSERT list names 25 columns
 * chosen on the day. The table has gained columns since -- resume_pct among
 * them -- so restoring from that file would silently drop them. This reads the
 * live schema and writes every column the table actually has, which is the
 * only version of this that stays correct as the schema moves.
 *
 * Writes two files per run:
 *   backups/jobs-<stamp>.json   the rows, for reading and diffing
 *   backups/jobs-<stamp>.sql    INSERT OR REPLACE, for restoring
 *
 * backups/ is gitignored on purpose. The postings are public; which ones Brian
 * applied to and when is not, and this repository is public.
 *
 *   CF_D1_TOKEN=... node ingest/backup-d1.mjs
 *   CF_D1_TOKEN=... node ingest/backup-d1.mjs --table jobs
 */

import fs from 'node:fs';
import path from 'node:path';
import { isCli, parseArgs } from './cli.mjs';
import { logInfo, logError } from './logger.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname)
  .replace(/^\/([A-Za-z]:)/, '$1'), '..');
const ACCOUNT = 'dd01b432f0329f87bb1cc1a3fad590ee';
const DATABASE = '10e8a6c0-1fa7-4c33-a007-2044876ce6a7';

/**
 * Run one statement against D1.
 * @param {string} sql
 * @param {Array<string|number|null>} [params]
 * @returns {Promise<object[]>} result rows
 */
export async function query(sql, params = []) {
  const token = process.env.CF_D1_TOKEN;
  if (!token) throw new Error('CF_D1_TOKEN is not set');
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sql, params })
    }
  );
  const json = await res.json();
  if (!json.success) throw new Error(JSON.stringify(json.errors));
  return (json.result && json.result[0] && json.result[0].results) || [];
}

/**
 * SQL literal for one value. Used only for the restore FILE, which has to be a
 * standalone script -- the live writes in this repo bind parameters instead.
 * @param {unknown} value
 * @returns {string}
 */
export function literal(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  const text = String(value).replace(/'/g, "''");
  /* A newline inside the value would put the statement across several LINES,
     and anything that reads the file statement-by-statement then splits one
     INSERT into fragments that are not SQL. That is not hypothetical: the
     profile row holds the whole resume, and restoring it failed with
     `unrecognized token: "'BRIAN FERENCE`. Newlines become char(10) so every
     statement stays on exactly one line and still restores byte-for-byte. */
  const NL = String.fromCharCode(10);
  if (!text.includes(NL) && !text.includes(String.fromCharCode(13))) return `'${text}'`;
  const CR = String.fromCharCode(13);
  const flat = text.split(CR + NL).join(NL).split(CR).join(NL);
  /* ONE replace() rather than a chain of || char(10) ||. The chain works for
     a few lines and then does not: the resume is over a hundred lines, and
     SQLite refused it with "Expression tree is too large (maximum depth 100)".
     A sentinel plus a single replace is flat however many lines there are.
     The sentinel is grown until it does not occur in the value, so it can
     never collide with real content. */
  let sentinel = String.fromCharCode(1) + "NL" + String.fromCharCode(1);
  while (flat.includes(sentinel)) sentinel += String.fromCharCode(1);
  const encoded = flat.split(NL).join(sentinel);
  return `replace('${encoded}', '${sentinel}', char(10))`;
}

/**
 * A timestamp safe for a Windows filename.
 * @param {Date} now
 * @returns {string}
 */
export function stamp(now) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', 'T');
}

/* Guarded, because importing this file to reuse query() ran the whole backup
   and wrote a second restore point as a side effect. */
if (isCli(import.meta.url)) {
const args = parseArgs();
const table = args.table && args.table !== true ? String(args.table) : 'jobs';
if (!/^[a-z_][a-z0-9_]*$/i.test(table)) {
  logError('refusing an unsafe table name', { table });
  process.exit(1);
}

try {
  /* Columns come from the live schema, never from a list written by hand. */
  const info = await query(`PRAGMA table_info(${table})`);
  const columns = info.map((c) => c.name);
  if (!columns.length) {
    logError('no such table, or it has no columns', { table });
    process.exit(1);
  }
  const rows = await query(`SELECT * FROM ${table}`);
  logInfo('read the table', { table, columns: columns.length, rows: rows.length });

  const dir = path.join(ROOT, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date();
  const tag = at.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const jsonFile = path.join(dir, `${table}-${tag}.json`);
  const sqlFile = path.join(dir, `${table}-${tag}.sql`);

  fs.writeFileSync(jsonFile, JSON.stringify({ table, taken_at: at.toISOString(), columns, rows }, null, 2));

  const head = [
    `-- apply-dashboard ${table} table, ${rows.length} rows, ${columns.length} columns, taken ${at.toISOString()}`,
    '-- Columns were read from the live schema with PRAGMA table_info, not written by hand.',
    `-- restore: DELETE FROM ${table}; then run these inserts.`
  ];
  const body = rows.map((row) =>
    `INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((c) => literal(row[c])).join(', ')});`
  );
  fs.writeFileSync(sqlFile, head.concat(body).join('\n') + '\n');

  logInfo('restore point written', {
    json: path.relative(ROOT, jsonFile),
    sql: path.relative(ROOT, sqlFile),
    rows: rows.length,
    statements: body.length
  });
} catch (err) {
  logError('backup failed', { error: String(err && err.message ? err.message : err) });
  process.exit(1);
}
}
