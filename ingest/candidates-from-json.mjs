/**
 * Turn a hand-collected list of postings into sync-to-d1 input.
 *
 * Brian pastes job lists from boards the ingest cannot read on its own:
 * Wellfound and TrueUp block non-browser clients, FlexJobs is behind a
 * subscription. The rows get resolved to their PRIMARY posting URL (the
 * employer's Greenhouse, Lever, Ashby or careers page) and land here as JSON.
 * This turns that JSON into the shape `sync-to-d1.mjs --input` expects, and
 * nothing else: no rule is applied here. Every row still goes through
 * `decide()`, which owns the role rule, the location rule and the three
 * duplicate checks. A second gate in this file would be a second place for the
 * rules to drift apart.
 *
 * What it does add is the one thing the collector cannot know later: a pay
 * band the board published alongside the listing. That is written to a
 * sidecar file, keyed by URL, for `salary-backfill.mjs` to apply AFTER the row
 * exists, because the sync's INSERT carries no pay columns and the daily band
 * reader only sees what the posting text states.
 *
 *   node ingest/candidates-from-json.mjs --in <collected.json> --out ingest/out/pasted.json
 *
 * Input rows: { company, title, url, location, posted, salary_min, salary_max,
 *               source, still_open }
 * A row with still_open:false or no url is dropped here, with a line saying so:
 * a closed posting is worth knowing about but not worth a queue row.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from './cli.mjs';
import { isoFromUnknown } from './jobs.mjs';

const args = parseArgs();
const inPath = String(args.in || '');
const outPath = String(args.out || 'ingest/out/pasted.json');
if (!inPath) {
  console.error('usage: node ingest/candidates-from-json.mjs --in <collected.json> [--out <sync-input.json>]');
  process.exit(2);
}

const raw = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const rows = Array.isArray(raw) ? raw : (raw.jobs || raw.rows || []);

const candidates = [];
const bands = [];
let dropped = 0;

for (const r of rows) {
  const url = String(r.url || '').trim();
  if (!url || r.still_open === false) {
    dropped += 1;
    console.log(`  drop  ${String(r.company).padEnd(14)} ${String(r.title).slice(0, 50)}  ${!url ? 'no primary url' : 'posting closed'}`);
    continue;
  }
  /* Only http(s). A javascript: or data: URL here would reach the page. */
  if (!/^https?:\/\//i.test(url)) {
    dropped += 1;
    console.log(`  drop  ${String(r.company).padEnd(14)} ${String(r.title).slice(0, 50)}  url is not http(s)`);
    continue;
  }
  candidates.push({
    company: String(r.company || '').trim(),
    title: String(r.title || '').trim(),
    url,
    source: String(r.source || 'pasted'),
    /* The location string is what the gate reads. Eligibility wording rides
       along with it so "Remote / Europe only" is refused rather than passed. */
    work_type: [r.location, r.eligibility].filter(Boolean).join(' / ') || null,
    posted: isoFromUnknown(r.posted)
  });
  if (r.salary_min || r.salary_max) {
    bands.push({
      url,
      salary_min: r.salary_min ? Number(r.salary_min) : null,
      salary_max: r.salary_max ? Number(r.salary_max) : null,
      /* Where the figure came from decides how much it is trusted. A board
         republishing the employer's own band is fine; a board's estimate is not
         a published band and must not be written as one. */
      salary_source: String(r.salary_source || 'board')
    });
  }
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify({ jobs: candidates }, null, 2)}\n`, 'utf8');
const bandsPath = outPath.replace(/\.json$/, '.bands.json');
fs.writeFileSync(bandsPath, `${JSON.stringify(bands, null, 2)}\n`, 'utf8');

console.log(`\n${candidates.length} candidates -> ${outPath}`);
console.log(`${bands.length} published bands -> ${bandsPath}`);
console.log(`${dropped} dropped (closed or no primary url)`);
console.log('\nnext: node ingest/sync-to-d1.mjs --input ' + outPath + '   (dry run; add --write to insert)');
