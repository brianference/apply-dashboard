/**
 * The salary audit has to be able to FAIL.
 *
 * A posting that publishes a band and is stored with no band is the whole
 * reason the audit exists. If this file only ever saw rows that already
 * had a salary, a decoder that always returned null would still look green.
 *
 *   node ingest/test-salary-audit.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  recoverableUnpriced, hasPublishedSalary, readCachedDescription
} from './salary-audit.mjs';
import { recoverFromJd, rowsToRecover } from './salary-recover.mjs';

let bad = 0;
/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(name, ok, detail) {
  if (!ok) bad += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(name).padEnd(72)} ${detail || ''}`);
}

/* The real Greenhouse content for MongoDB 8143805. The audit must recover
   this through strip() then salaryFromText, the same path ranking uses. */
const MONGODB_DOUBLE =
  '&lt;div class=&quot;pay-range&quot;&gt;&lt;span&gt;$126,000&lt;/span&gt;&lt;span class=&quot;divider&quot;&gt;&amp;mdash;&lt;/span&gt;&lt;span&gt;$248,000 USD&lt;/span&gt;&lt;/div&gt;';

const ROW = {
  dedupe_key: 'mongodb|senior product manager, client libraries',
  status: 'queued',
  company: 'MongoDB',
  title: 'Senior Product Manager, Client Libraries',
  url: 'https://job-boards.greenhouse.io/mongodb/jobs/8143805',
  salary_min: null,
  salary_max: null
};

const byKey = new Map([[ROW.dedupe_key, MONGODB_DOUBLE]]);
const read = (row) => byKey.get(row.dedupe_key) || null;

const lost = recoverableUnpriced([ROW], read);
check('FAILS when a band is recoverable and the stored salary is null',
  lost.length === 1
    && lost[0].band.min === 126000
    && lost[0].band.max === 248000
    && lost[0].row.dedupe_key === ROW.dedupe_key,
  `lost=${lost.length} band=${lost[0] && lost[0].band.min}-${lost[0] && lost[0].band.max}`);

const stored = recoverableUnpriced(
  [{ ...ROW, salary_min: 126000, salary_max: 248000 }],
  read
);
check('PASSES when the salary is stored', stored.length === 0, `lost=${stored.length}`);

const emptyJd = recoverableUnpriced(
  [ROW],
  () => '<p>Competitive compensation. Come join us.</p>'
);
check('PASSES when the description publishes no band',
  emptyJd.length === 0, `lost=${emptyJd.length}`);

const unread = recoverableUnpriced([ROW], () => null);
check('unread description is not a failure -- we cannot claim a band we did not read',
  unread.length === 0, `lost=${unread.length}`);

const skipped = recoverableUnpriced([{ ...ROW, status: 'skipped' }], read);
check('a skipped row is off the list, so a recoverable band there is not this audit',
  skipped.length === 0, `lost=${skipped.length}`);

check('salary_min = 0 is not a published salary',
  hasPublishedSalary({ salary_min: 0, salary_max: null }) === false);
check('a negative figure is not a published salary',
  hasPublishedSalary({ salary_min: -1, salary_max: null }) === false);
check('{salary_min:126000} is a published salary',
  hasPublishedSalary({ salary_min: 126000, salary_max: 248000 }) === true);

/* The audit reads the ranking cache by the same file name fetchJd writes,
   including a greenhouse URL whose token is only in the filename. */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'salary-audit-'));
try {
  const named = 'greenhouse-mongodb-8143805.txt';
  fs.writeFileSync(path.join(tmp, named), MONGODB_DOUBLE, 'utf8');
  const fromUrl = readCachedDescription(
    'https://job-boards.greenhouse.io/mongodb/jobs/8143805',
    tmp
  );
  check('cache hit on a greenhouse URL whose token is in the URL',
    fromUrl === MONGODB_DOUBLE);

  const fromJid = readCachedDescription(
    'https://www.mongodb.com/careers/job/?gh_jid=8143805',
    tmp
  );
  check('cache hit on a ?gh_jid= URL matches the file by job id, not a guessed token',
    fromJid === MONGODB_DOUBLE);

  const miss = readCachedDescription(
    'https://job-boards.greenhouse.io/mongodb/jobs/1',
    tmp
  );
  check('a different job id is not a hit', miss === null);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* recoverFromJd is the same decoder the write path uses. */
const fromHtml = recoverFromJd(MONGODB_DOUBLE);
check('recoverFromJd on the MongoDB block returns the band',
  fromHtml.kind === 'band' && fromHtml.band.min === 126000 && fromHtml.band.max === 248000,
  `${fromHtml.kind} ${fromHtml.band.min}-${fromHtml.band.max}`);
check('recoverFromJd on unread is unreadable, not empty',
  recoverFromJd(null).kind === 'unreadable');
check('recoverFromJd on a genuine no-band posting is empty, not a guess',
  recoverFromJd('<p>Competitive compensation.</p>').kind === 'empty');

const recoverRows = rowsToRecover([
  ROW,
  { ...ROW, dedupe_key: 'x', status: 'skipped' },
  { ...ROW, dedupe_key: 'y', status: 'submitted' },
  { ...ROW, dedupe_key: 'z', salary_min: 200000, salary_max: 240000 }
]);
check('rowsToRecover keeps only queued rows with no stored band',
  recoverRows.length === 1 && recoverRows[0].dedupe_key === ROW.dedupe_key,
  `n=${recoverRows.length}`);

/* The CLI must actually exit non-zero. A function that returns a list is
   not an audit if the runner swallows it. */
const src = fs.readFileSync(
  path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), 'salary-audit.mjs'),
  'utf8'
);
check('the audit CLI calls process.exit(1) when any row is lost',
  /if\s*\(\s*lost\.length\s*\)/.test(src) && /process\.exit\(\s*1\s*\)/.test(src));

console.log(bad ? `\n${bad} FAILED` : '\nthe audit fails when a published band would go out unpriced, and only then');
process.exitCode = bad ? 1 : 0;
