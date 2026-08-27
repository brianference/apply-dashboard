/**
 * Find employer job boards we are not yet watching.
 *
 * Supply, not filtering, is the ceiling. A full pipeline run on 2026-08-27
 * collected 591 postings and produced 2 new eligible ones, because the seed
 * list is only 152 companies (84 Greenhouse, 58 Ashby, 10 Lever) and everything
 * else was a duplicate of a posting already seen.
 *
 * Every company already in the queue is a candidate board we are not asking.
 * This probes each one against the same public ATS endpoints resolve-by-board
 * uses, and adds any token that answers 200 with real postings. A token that
 * does not exist returns 404, so a wrong guess costs one request and is never
 * recorded.
 *
 * Nothing is guessed into the file: a token is written only after the board
 * returned postings that parsed.
 *
 *   node ingest/discover-boards.mjs              # report only
 *   node ingest/discover-boards.mjs --write      # also update ingest/companies.json
 *   node ingest/discover-boards.mjs --limit 50
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from './cli.mjs';
import { logInfo, logWarn } from './logger.mjs';
import { boardTokens, fetchBoard, parseBoardPostings, ATS_ORDER } from './resolve-by-board.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname)
  .replace(/^\/([A-Za-z]:)/, '$1'), '..');
const COMPANIES = path.join(ROOT, 'ingest', 'companies.json');
const OUT = path.join(ROOT, 'ingest', 'out', 'discovered-boards.json');
const API = 'https://apply-dashboard.pages.dev/api/jobs';

/**
 * Companies we already watch, by ATS, lowercased for comparison.
 * @param {Record<string, Array<{token: string, name: string}>>} companies
 * @returns {{tokens: Set<string>, names: Set<string>}}
 */
export function alreadyWatched(companies) {
  const tokens = new Set();
  const names = new Set();
  for (const ats of Object.keys(companies || {})) {
    for (const entry of companies[ats] || []) {
      if (entry && entry.token) tokens.add(`${ats}:${String(entry.token).toLowerCase()}`);
      if (entry && entry.name) names.add(String(entry.name).toLowerCase().trim());
    }
  }
  return { tokens, names };
}

/**
 * A posting list worth adding: at least one posting parsed off the board.
 * @param {unknown[]} postings
 * @returns {boolean}
 */
export function boardIsReal(postings) {
  return Array.isArray(postings) && postings.length > 0;
}

const args = parseArgs();
const limit = args.limit === undefined || args.limit === true ? Infinity : Number(args.limit);
const doWrite = !!args.write;

const companies = JSON.parse(fs.readFileSync(COMPANIES, 'utf8'));
const watched = alreadyWatched(companies);

const live = await fetch(API, { headers: { 'cache-control': 'no-cache' } }).then((r) => r.json());
const names = [...new Set((live.jobs || []).map((j) => String(j.company || '').trim()).filter(Boolean))];
const unwatched = names.filter((n) => !watched.names.has(n.toLowerCase()));
logInfo('companies in the queue', { total: names.length, alreadyWatched: names.length - unwatched.length, toProbe: Math.min(unwatched.length, limit) });

const found = [];
let probed = 0;
for (const name of unwatched.slice(0, Number.isFinite(limit) ? limit : undefined)) {
  probed += 1;
  let hit = null;
  /* boardTokens yields {token, preferredAts, source}, not bare strings. Probing
     with the object put the literal "[object Object]" in every URL and found
     nothing at all -- a run that looked like an honest zero. */
  for (const candidate of boardTokens(name, companies)) {
    const token = candidate && candidate.token ? candidate.token : String(candidate);
    for (const ats of ATS_ORDER) {
      const key = `${ats}:${String(token).toLowerCase()}`;
      if (watched.tokens.has(key)) continue;
      let res;
      try { res = await fetchBoard(ats, token); } catch { continue; }
      if (!res || res.status !== 200 || !res.json) continue;
      const postings = parseBoardPostings(ats, res.json);
      if (!boardIsReal(postings)) continue;
      hit = { name, ats, token, postings: postings.length };
      break;
    }
    if (hit) break;
  }
  if (hit) {
    found.push(hit);
    logInfo('board found', hit);
  }
}

const byAts = {};
for (const f of found) byAts[f.ats] = (byAts[f.ats] || 0) + 1;
logInfo('discovery complete', { probed, found: found.length, byAts });

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ generated_at: new Date().toISOString(), probed, found }, null, 2));
logInfo('wrote report', { file: path.relative(ROOT, OUT) });

/* Only greenhouse, ashby and lever have a source module that reads
   companies.json -- see ingest/sources/. A smartrecruiters or workable token
   written here would sit in the file doing nothing and read like coverage, so
   it is reported separately instead of quietly added. */
const CONSUMED = new Set(['greenhouse', 'ashby', 'lever']);
const addable = found.filter((f) => CONSUMED.has(f.ats));
const notConsumed = found.filter((f) => !CONSUMED.has(f.ats));
if (notConsumed.length) {
  logWarn('boards found but no source module reads them', {
    count: notConsumed.length,
    ats: [...new Set(notConsumed.map((f) => f.ats))],
    companies: notConsumed.map((f) => f.name)
  });
}
if (doWrite && addable.length) {
  for (const f of addable) {
    if (!Array.isArray(companies[f.ats])) companies[f.ats] = [];
    companies[f.ats].push({ token: f.token, name: f.name });
  }
  fs.writeFileSync(COMPANIES, JSON.stringify(companies, null, 2));
  const added = {};
  for (const f of addable) added[f.ats] = (added[f.ats] || 0) + 1;
  logInfo('added to companies.json', added);
} else if (doWrite) {
  logWarn('nothing to add', {});
}
