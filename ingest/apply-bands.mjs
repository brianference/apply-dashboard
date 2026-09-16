/**
 * Apply board-published pay bands from a sidecar file to rows that already
 * exist, using the sweep's own judge and writers.
 *
 * `candidates-from-json.mjs` writes `<out>.bands.json` beside the sync input,
 * because the sync's INSERT carries no pay columns and the daily band reader
 * only sees what the posting text states. Greenhouse renders some bands from a
 * pay-transparency block the API's `content` field omits, so a board can
 * publish a band the text reader never finds. This closes that gap for rows
 * collected by hand.
 *
 * Nothing here decides anything. `judgeBand` says whether a band clears the
 * floor; `bandWrite` and `belowFloorWrite` are the sweep's own statements, so a
 * hand-collected band and a swept one land in the table the same way and a
 * change to either rule reaches both. A second copy of the floor in this file
 * would be a second place for it to drift.
 *
 *   node ingest/apply-bands.mjs --bands ingest/out/pasted.bands.json          # dry run
 *   node ingest/apply-bands.mjs --bands ingest/out/pasted.bands.json --write
 */

import fs from 'node:fs';
import { parseArgs } from './cli.mjs';
import { judgeBand, bandWrite, belowFloorWrite } from './salary-sweep.mjs';

const ACCOUNT = 'dd01b432f0329f87bb1cc1a3fad590ee';
const DATABASE = '10e8a6c0-1fa7-4c33-a007-2044876ce6a7';
const READ_API = 'https://apply-dashboard.pages.dev/api/jobs';

const args = parseArgs();
const bandsPath = String(args.bands || '');
const write = !!args.write;
const token = process.env.CF_D1_TOKEN || '';
if (!bandsPath) {
  console.error('usage: node ingest/apply-bands.mjs --bands <file.bands.json> [--write]');
  process.exit(2);
}

/**
 * One D1 statement.
 *
 * @param {string} sql
 * @param {Array<string|number|null>} params
 * @returns {Promise<{success: boolean, errors?: Array<{message: string}>}>}
 */
async function d1(sql, params) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sql, params })
  });
  return res.json();
}

/** @param {string} u @returns {string} */
const normUrl = (u) => String(u || '').trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '');

const bands = JSON.parse(fs.readFileSync(bandsPath, 'utf8'));
const live = (await (await fetch(READ_API, { headers: { 'cache-control': 'no-cache' } })).json()).jobs || [];
const byUrl = new Map(live.map((r) => [normUrl(r.url), r]));
const checkedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

let applied = 0;
let blocked = 0;
let missing = 0;
for (const b of bands) {
  const row = byUrl.get(normUrl(b.url));
  if (!row) {
    missing += 1;
    console.log(`  no row   ${b.url.slice(0, 70)}`);
    continue;
  }
  /* A submitted row is history: its band is recorded but it is never re-gated. */
  const band = { min: b.salary_min, max: b.salary_max };
  const verdict = judgeBand(band);
  const label = `${String(row.company).slice(0, 14).padEnd(14)} ${String(row.title).slice(0, 44).padEnd(44)} $${band.min}-${band.max}`;
  /* judgeBand returns one of 'ok' | 'below-floor' | 'unknown', a string. The
     first draft of this file tested `verdict.ok` on that string, which is
     always undefined, and the dry run ruled every one of eleven bands under the
     floor, $250,000 included. A dry run that is read is the whole point of a
     dry run. A hand-collected band is stored under its own salary_source so it
     can never be mistaken for one the sweep read off the posting. */
  const source = `pasted:${b.salary_source || 'board'}`;
  if (verdict !== 'below-floor' || row.status === 'submitted') {
    console.log(`  band     ${label}  -> ${verdict === 'ok' ? 'clears the sweep floor' : verdict === 'unknown' ? 'no start figure, recorded as-is' : 'recorded, row is submitted'}`);
    if (write) {
      const w = bandWrite({ band, dedupe_key: row.dedupe_key, source }, checkedAt);
      const out = await d1(w.sql, w.params);
      if (!out.success) console.log('    D1 error:', out.errors?.[0]?.message);
    }
    applied += 1;
  } else {
    console.log(`  BLOCK    ${label}  -> starts under the sweep floor`);
    if (write) {
      const w1 = bandWrite({ band, dedupe_key: row.dedupe_key, source }, checkedAt);
      await d1(w1.sql, w1.params);
      const w2 = belowFloorWrite({ band, dedupe_key: row.dedupe_key });
      const out = await d1(w2.sql, w2.params);
      if (!out.success) console.log('    D1 error:', out.errors?.[0]?.message);
    }
    blocked += 1;
  }
}

console.log(`\n${applied} band(s) recorded, ${blocked} row(s) ruled out under the floor, ${missing} with no matching row`);
console.log(write ? 'written to D1' : 'DRY RUN. Nothing written. Add --write.');
