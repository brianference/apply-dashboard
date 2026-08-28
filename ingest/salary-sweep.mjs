/**
 * Read the pay band off the destination posting for EVERY row, and rule out
 * anything whose published band starts below the floor.
 *
 * This exists because of a job Brian caught himself. "Sr. Product Manager -
 * Skylar Analytics" sat at the top of his list at 83 percent with no salary
 * recorded, and its Lever posting says, in the description the pipeline had
 * already downloaded and scored against:
 *
 *     Base salary: $135,000-$155,000 annually.
 *
 * Twenty-five thousand under the floor. The row carried `jd_read: yes`, so the
 * text was in hand; the extractor in salary-from-posting.mjs parses that exact
 * string correctly; and 184 of 201 clear queued rows had no band at all. The
 * extractor existed, the text existed, and no code connected them - salary
 * extraction lived in a separate script nobody ran, while the ranking pass read
 * the same description for a different purpose and threw the pay line away.
 *
 * A missing band is treated as UNKNOWN, never as acceptable. That rule is
 * correct and stays; what was wrong is how often the band was missing when the
 * posting published one.
 *
 *   node ingest/salary-sweep.mjs                  # report only
 *   node ingest/salary-sweep.mjs --write          # write bands and rule-outs
 *   node ingest/salary-sweep.mjs --limit 50
 *   node ingest/salary-sweep.mjs --refetch        # ignore the JD cache
 */

import fs from 'node:fs';
import path from 'node:path';
import { isCli, parseArgs } from './cli.mjs';
import { logInfo, logWarn } from './logger.mjs';
import { fetchJd } from './fit-score.mjs';
import { salaryFromText } from './salary-from-posting.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname)
  .replace(/^\/([A-Za-z]:)/, '$1'), '..');
const API = 'https://apply-dashboard.pages.dev/api/jobs';
const ACCOUNT = 'dd01b432f0329f87bb1cc1a3fad590ee';
const DATABASE = '10e8a6c0-1fa7-4c33-a007-2044876ce6a7';

/** Brian's floor. A band whose START is under this fails, however high its top. */
export const FLOOR = 160000;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Strip tags and collapse whitespace, so a band split across markup still reads
 * as one line to the extractor.
 * @param {string} html
 * @returns {string}
 */
export function textOf(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Is this band acceptable?
 *
 * Null is UNKNOWN, not acceptable and not a failure - it is a gap in what we
 * know, and the row stays with a flag rather than being silently dropped or
 * silently kept as though it had cleared.
 *
 * @param {{min: number|null, max: number|null}} band
 * @param {number} [floor]
 * @returns {"ok"|"below-floor"|"unknown"}
 */
export function judgeBand(band, floor = FLOOR) {
  if (!band || band.min == null) return 'unknown';
  return band.min < floor ? 'below-floor' : 'ok';
}

/**
 * The posting text for a row: the board API when it is a board we can read,
 * otherwise the destination page itself.
 *
 * The page fetch is the part Brian asked for - crawl the final apply page
 * rather than trusting whatever the index said.
 *
 * @param {{url: string}} job
 * @param {boolean} refetch
 * @returns {Promise<{text: string|null, via: string}>}
 */
export async function postingText(job, refetch = false) {
  if (!refetch) {
    const fromBoard = await fetchJd(job.url).catch(() => null);
    if (fromBoard && fromBoard.length > 200) return { text: fromBoard, via: 'board-api' };
  }
  try {
    const res = await fetch(job.url, {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(25000)
    });
    if (!res.ok) return { text: null, via: `page-${res.status}` };
    const body = await res.text();
    return { text: textOf(body), via: 'page' };
  } catch (error) {
    return { text: null, via: 'page-error' };
  }
}

if (isCli(import.meta.url)) {
  const args = parseArgs();
  const limit = args.limit === undefined || args.limit === true ? Infinity : Number(args.limit);
  const doWrite = !!args.write;
  const refetch = !!args.refetch;

  const live = await fetch(API, { headers: { 'cache-control': 'no-cache' } }).then((r) => r.json());
  /* Every row, not only the queued ones. A submitted row with a band we never
     read is still a number Brian should be able to see. */
  const rows = (live.jobs || []).filter((j) => j.url).slice(0, Number.isFinite(limit) ? limit : undefined);
  logInfo('sweeping', { rows: rows.length, refetch, write: doWrite });

  const results = [];
  let done = 0;
  for (const job of rows) {
    const { text, via } = await postingText(job, refetch);
    const band = text ? salaryFromText(text) : { min: null, max: null };
    const verdict = judgeBand(band);
    results.push({ ...job, band, verdict, via });
    done += 1;
    if (verdict === 'below-floor') {
      logInfo('below floor', { company: job.company, title: String(job.title).slice(0, 50), band: `${band.min}-${band.max}`, via });
    }
    if (done % 25 === 0) logInfo('progress', { done, of: rows.length });
  }

  const found = results.filter((r) => r.band.min != null);
  const below = results.filter((r) => r.verdict === 'below-floor');
  const unknown = results.filter((r) => r.verdict === 'unknown');
  const byVia = {};
  for (const r of results) byVia[r.via] = (byVia[r.via] || 0) + 1;

  logInfo('sweep complete', {
    rows: results.length,
    bandFound: found.length,
    belowFloor: below.length,
    unknown: unknown.length,
    fetchedVia: byVia
  });

  const out = path.join(ROOT, 'ingest', 'out', 'salary-sweep.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    generated_at: new Date().toISOString(), floor: FLOOR,
    rows: results.map((r) => ({
      dedupe_key: r.dedupe_key, company: r.company, title: r.title, url: r.url,
      salary_min: r.band.min, salary_max: r.band.max, verdict: r.verdict, via: r.via
    }))
  }, null, 2));
  logInfo('wrote report', { file: path.relative(ROOT, out) });

  if (!doWrite) {
    logWarn('nothing written', { hint: 'pass --write to record bands and rule-outs' });
  } else {
    const token = process.env.CF_D1_TOKEN;
    if (!token) {
      logWarn('CF_D1_TOKEN is not set', {});
    } else {
      /** @param {string} sql @param {Array<string|number|null>} params */
      const run = async (sql, params) => {
        const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ sql, params })
        });
        const j = await r.json();
        if (!j.success) throw new Error(JSON.stringify(j.errors));
      };
      let wroteBands = 0;
      let ruledOut = 0;
      for (const r of results) {
        if (r.band.min != null) {
          await run(
            'UPDATE jobs SET salary_min = ?, salary_max = ?, salary_source = ? WHERE dedupe_key = ?',
            [r.band.min, r.band.max, 'posting:' + r.via, r.dedupe_key]
          );
          wroteBands += 1;
        }
        /* Rule out only what is BELOW the floor and still open. A submitted row
           is history: marking it off-criteria now would rewrite what happened. */
        if (r.verdict === 'below-floor' && r.status !== 'submitted') {
          await run(
            "UPDATE jobs SET blocked_reason = 'off-criteria', blocked_detail = ? WHERE dedupe_key = ?",
            [`published band starts at $${r.band.min}, under the $${FLOOR} floor`, r.dedupe_key]
          );
          ruledOut += 1;
        }
      }
      logInfo('written to D1', { bands: wroteBands, ruledOut });
    }
  }
}
