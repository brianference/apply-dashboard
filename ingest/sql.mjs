/**
 * SQL helpers. This module never opens a database connection.
 */

/**
 * Escape a JS value as a SQLite string literal, or NULL.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeSqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * Render one INSERT OR IGNORE statement for the jobs table.
 *
 * @param {{
 *   dedupe_key: string,
 *   company: string,
 *   title: string,
 *   url: string,
 *   match_pct: number,
 *   source: string,
 *   status: string,
 *   lane: string,
 *   submitted_at: string|null,
 *   posted: string|null,
 *   work_type: string|null,
 *   updated_at: string
 * }} row
 * @returns {string}
 */
export function renderInsertIgnore(row) {
  const columns = [
    "dedupe_key",
    "company",
    "title",
    "url",
    "match_pct",
    "source",
    "status",
    "lane",
    "submitted_at",
    "posted",
    "work_type",
    "updated_at"
  ];
  const values = [
    escapeSqlLiteral(row.dedupe_key),
    escapeSqlLiteral(row.company),
    escapeSqlLiteral(row.title),
    escapeSqlLiteral(row.url),
    Number.isFinite(row.match_pct) ? String(Math.trunc(row.match_pct)) : "NULL",
    escapeSqlLiteral(row.source),
    escapeSqlLiteral(row.status),
    escapeSqlLiteral(row.lane),
    escapeSqlLiteral(row.submitted_at),
    escapeSqlLiteral(row.posted),
    escapeSqlLiteral(row.work_type),
    escapeSqlLiteral(row.updated_at)
  ];
  return `INSERT OR IGNORE INTO jobs (${columns.join(", ")}) VALUES (${values.join(", ")});`;
}
