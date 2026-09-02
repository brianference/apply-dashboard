/**
 * The pay columns and the migration that adds them.
 *
 * This lives on its own because both `salary-sweep.mjs` and `fit-score.mjs`
 * need it, and salary-sweep imports fit-score. Reaching for it with a dynamic
 * `await import('./salary-sweep.mjs')` from inside fit-score's own top-level
 * CLI block closed that circle: the import waited for fit-score to finish
 * evaluating, fit-score was waiting on the import, and node exited with
 * "Detected unsettled top-level await" having written nothing. A module with
 * no dependency of its own cannot deadlock either caller.
 */

import { logInfo } from './logger.mjs';

/** @type {Array<[string, string]>} column name and its SQLite declaration. */
export const PAY_COLUMNS = [
  ['pay_tier', 'INTEGER'],
  ['salary_checked_at', 'TEXT']
];

/**
 * Employer last-update, stored next to `posted` (first published).
 *
 * Same ALTER guard as the pay columns: a re-run against a database that
 * already has it is not an error. Without this column the stale lens has
 * to treat every row as "refresh unknown" and quietly stops hiding anything.
 */
export const DATE_COLUMNS = [
  ['refreshed_at', 'TEXT']
];

/**
 * Column rows from a PRAGMA table_info response, whichever shape the runner
 * returned.
 *
 * Failing input: `{ results: [{ name: 'pay_tier' }], success: true, meta: {} }`
 * (Workers `.all()`) used to yield `cols = []`, so every re-run ALTERed.
 *
 * @param {any} raw
 * @returns {Array<{name: string}>}
 */
export function pragmaColumns(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.results)) return raw.results;
  if (raw && raw.result && raw.result[0] && Array.isArray(raw.result[0].results)) {
    return raw.result[0].results;
  }
  return [];
}

/**
 * Is this SQLite refusing an ALTER because the column already exists?
 *
 * Failing input: `"duplicate column name: pay_tier"` must be swallowed;
 * `"no such table: jobs"` must rethrow.
 *
 * @param {unknown} error
 * @param {string} column
 * @returns {boolean}
 */
export function isDuplicateColumnError(error, column) {
  const msg = String(error && (/** @type {{message?: string}} */ (error).message || error));
  return /duplicate column name/i.test(msg) && msg.includes(column);
}

/**
 * Add the named columns if they are missing. Re-running against a database
 * that already has them is not an error.
 *
 * @param {(sql: string, params?: Array<string|number|null>) => Promise<any>} run
 * @param {Array<[string, string]>} columns
 * @returns {Promise<void>}
 */
export async function ensureColumns(run, columns) {
  const raw = await run('PRAGMA table_info(jobs)', []);
  const cols = pragmaColumns(raw);
  const have = new Set(cols.map((c) => c.name));
  for (const [name, decl] of columns) {
    if (have.has(name)) continue;
    try {
      await run(`ALTER TABLE jobs ADD COLUMN ${name} ${decl}`, []);
      logInfo('added column', { name, decl });
      have.add(name);
    } catch (error) {
      if (!isDuplicateColumnError(error, name)) throw error;
    }
  }
}

/**
 * Add pay_tier and salary_checked_at if they are missing. Re-running against
 * a database that already has them is not an error.
 *
 * @param {(sql: string, params?: Array<string|number|null>) => Promise<any>} run
 *   a D1 query runner. Tolerates a runner that returns the raw REST envelope,
 *   the Workers `.all()` `{ results }` shape, or the results array.
 * @returns {Promise<void>}
 */
export async function ensurePayColumns(run) {
  /* refreshed_at rides the same guard so a caller that already ensures pay
     columns cannot forget the date column and silently leave every row
     "refresh unknown". */
  await ensureColumns(run, PAY_COLUMNS);
  await ensureDateColumns(run);
}

/**
 * Add refreshed_at if it is missing. Same swallow-duplicate behaviour as
 * ensurePayColumns -- a second ALTER on a live database is how a deploy
 * against an already-migrated table used to 500.
 *
 * @param {(sql: string, params?: Array<string|number|null>) => Promise<any>} run
 * @returns {Promise<void>}
 */
export async function ensureDateColumns(run) {
  await ensureColumns(run, DATE_COLUMNS);
}
