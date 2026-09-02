/**
 * Fail the daily run if a posting that publishes a band is about to go out
 * with no band stored.
 *
 * Brian's rule, 2026-09-02: never lose a published salary. Losing one is
 * worse than showing nothing, because the pay lane treats "no band" as
 * unknown, not low, and floats the row above priced postings it should sit
 * below. 19 queued Greenhouse rows did exactly that -- MongoDB job 8143805
 * among them -- and the twice-daily run stayed green, because the only copy
 * of the rule was a comment.
 *
 * Reads the SAME descriptions the ranking pass used, from ingest/out/jd-cache/,
 * never the internet, and the Ashby compensation sidecar fetchJd writes next
 * to them. A CI runner that re-crawled would fail for network reasons and
 * look like a decoder bug, or worse, pass because a refetch succeeded while
 * the ranking pass had used a stale file. Without the sidecar the audit
 * would have passed all 17 Ashby rows whose feed published a band.
 *
 *   node ingest/salary-audit.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { isCli } from './cli.mjs';
import { ashbyCompensationCacheFileName, boardRef, jdCacheFileName, parsePayStart, strip } from './fit-score.mjs';
import { salaryFromAshbyCompensation, salaryFromText } from './salary-from-posting.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname)
  .replace(/^\/([A-Za-z]:)/, '$1'), '..');
const CACHE = path.join(ROOT, 'ingest', 'out', 'jd-cache');
const API = 'https://apply-dashboard.pages.dev/api/jobs';

const ON_THE_LIST = new Set(['queued', 'pending-review']);

/**
 * Does this row already carry a published figure, so the audit has nothing
 * to recover?
 *
 * Failing input: salary_min = 0 used to look stored and skip the check,
 * which is how an unknown start stayed unknown.
 *
 * @param {Record<string, any>|null|undefined} row
 * @returns {boolean}
 */
export function hasPublishedSalary(row) {
  const min = parsePayStart(row && row.salary_min);
  const max = parsePayStart(row && row.salary_max);
  return (min != null && min > 0) || (max != null && max > 0);
}

/**
 * The on-disk description ranking used for this URL, or null if this runner
 * never fetched it. Does not hit the network.
 *
 * Greenhouse URLs that only carry ?gh_jid= have no board token in the URL.
 * The cache file still has the token fetchJd resolved, so we match on the
 * job id rather than guessing the board from the company name -- that guess
 * is how 8 of the 31 unpriced Greenhouse rows could not be fetched by the
 * probe that found this bug.
 *
 * @param {string} url
 * @param {string} [cacheDir]
 * @returns {string|null}
 */
export function readCachedDescription(url, cacheDir = CACHE) {
  const ref = boardRef(url);
  if (!ref || !fs.existsSync(cacheDir)) return null;
  if (ref.token) {
    const name = jdCacheFileName(ref);
    if (!name) return null;
    const full = path.join(cacheDir, name);
    return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
  }
  const prefix = `${ref.ats}-`;
  const suffix = `-${String(ref.id).replace(/[^a-z0-9-]/gi, '_')}.txt`;
  let hit = null;
  for (const name of fs.readdirSync(cacheDir)) {
    if (name.startsWith(prefix) && name.endsWith(suffix)) {
      hit = name;
      break;
    }
  }
  if (!hit) return null;
  return fs.readFileSync(path.join(cacheDir, hit), 'utf8');
}

/**
 * Ashby structured compensation the ranking pass cached next to the
 * description, or null if this runner never fetched it.
 *
 * @param {string} url
 * @param {string} [cacheDir]
 * @returns {unknown}
 */
export function readCachedAshbyCompensation(url, cacheDir = CACHE) {
  const ref = boardRef(url);
  if (!ref || ref.ats !== 'ashby' || !fs.existsSync(cacheDir)) return null;
  const name = ashbyCompensationCacheFileName(ref);
  if (!name) return null;
  const full = path.join(cacheDir, name);
  if (!fs.existsSync(full)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return Object.prototype.hasOwnProperty.call(parsed, 'compensation')
      ? parsed.compensation
      : parsed;
  } catch {
    return null;
  }
}

/**
 * Rows the daily run is about to leave unpriced even though their description
 * or Ashby feed publishes a band. Empty means the rule holds. A missing
 * description (and missing compensation sidecar) is not a failure -- we
 * cannot claim a band we did not read.
 *
 * Structured Ashby pay is checked first. A number the employer typed into
 * a field beats a number a regex found in prose, and 17 queued Ashby rows
 * published the former with a description that contains no figures at all.
 *
 * @param {Array<Record<string, any>>} rows
 * @param {(row: Record<string, any>) => string|null|undefined} descriptionOf
 * @param {(row: Record<string, any>) => unknown} [compensationOf]
 * @returns {Array<{row: Record<string, any>, band: {min: number, max: number|null}, source: string}>}
 */
export function recoverableUnpriced(rows, descriptionOf, compensationOf) {
  const lost = [];
  for (const row of rows || []) {
    if (!ON_THE_LIST.has(row && row.status)) continue;
    if (hasPublishedSalary(row)) continue;
    const compensation = typeof compensationOf === 'function' ? compensationOf(row) : null;
    const structured = salaryFromAshbyCompensation(compensation);
    if (structured.min != null || structured.max != null) {
      lost.push({ row, band: structured, source: 'ashby:compensation' });
      continue;
    }
    const jd = descriptionOf(row);
    if (!jd) continue;
    const band = salaryFromText(strip(jd));
    if (band.min == null) continue;
    lost.push({ row, band, source: 'posting' });
  }
  return lost;
}

if (isCli(import.meta.url)) {
  const live = await (await fetch(API, { headers: { 'cache-control': 'no-cache' } })).json();
  const rows = live.jobs || [];
  const lost = recoverableUnpriced(
    rows,
    (row) => readCachedDescription(row.url),
    (row) => readCachedAshbyCompensation(row.url)
  );
  const examined = rows.filter((r) => ON_THE_LIST.has(r.status) && !hasPublishedSalary(r)).length;
  if (lost.length) {
    process.stdout.write(
      `FAIL  ${lost.length} posted band(s) about to go out unpriced `
      + `(${examined} unpriced rows on the list)\n`
    );
    for (const { row, band } of lost) {
      process.stdout.write(
        `  ${row.company} | ${row.title} | $${band.min}-${band.max} | ${row.url}\n`
      );
    }
    process.exit(1);
  }
  process.stdout.write(
    `ok    ${examined} unpriced rows on the list, none had a recoverable band in the cache\n`
  );
}
