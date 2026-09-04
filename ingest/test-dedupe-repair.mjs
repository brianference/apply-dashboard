/**
 * Collapsing postings that are already stored twice, and the one case it must
 * refuse to touch.
 *
 * The four shapes below are the real ones, read off the live queue on
 * 2026-09-04. Three of them still get past `sameJob` even now, which is why
 * grouping is by normalised URL: two rows pointing at the same posting are the
 * same posting, whatever their company and title strings say.
 *
 *   " - Twilio" appended to the title by a second board
 *   a double space inside the title
 *   "Kin" and "Kin Insurance" for one employer
 *   tracking parameters on one copy of the URL and not the other
 *
 * The refusal matters more than the collapse. Where BOTH rows of a pair are
 * submitted, two real applications happened, and choosing which one to erase is
 * not a decision code should make. It reports and changes nothing.
 *
 *   node ingest/test-dedupe-repair.mjs
 */

import { planDedupe, rankForKeeping, repairDuplicates, DUPLICATE_REASON } from './dedupe-repair.mjs';
import { readFileSync } from 'node:fs';
import { sameJob, withoutTrailingCompany, normalizeForDedupe } from './match.mjs';

let bad = 0;
/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(name, ok, detail) {
  if (!ok) bad += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(name).padEnd(74)} ${detail || ''}`);
}

const TWILIO = 'https://job-boards.greenhouse.io/twilio/jobs/7918885';
const KIN = 'https://jobs.ashbyhq.com/kin/34551772';

const ROWS = [
  { dedupe_key: 'kin|director pm', company: 'Kin', title: 'Director PM', url: KIN, status: 'queued', salary_min: 200000, posted: '2026-09-01T00:00:00.000Z', match_pct: 70 },
  { dedupe_key: 'kin insurance|director pm', company: 'Kin Insurance', title: 'Director PM', url: KIN + '?utm_source=board', status: 'queued', salary_min: null, posted: null, match_pct: null },
  { dedupe_key: 'lone|product manager', company: 'Lone', title: 'Product Manager', url: 'https://example.com/jobs/1', status: 'queued', salary_min: null, posted: null, match_pct: 50 }
];

/* ------------------------------------------------------------- the plan -- */

const plan = planDedupe(ROWS);
check('two rows at the same posting are one group, whatever the company says',
  plan.collapse.length === 1, `${plan.collapse.length} collapses`);
/* A tracking parameter is not a different job. */
check('a utm parameter does not make it a different url',
  plan.collapse[0] && plan.collapse[0].drop === 'kin insurance|director pm',
  plan.collapse[0] && plan.collapse[0].drop);
check('the row keeps the band, the date and the score',
  plan.collapse[0] && plan.collapse[0].keep === 'kin|director pm',
  plan.collapse[0] && plan.collapse[0].keep);
check('a posting stored once is left alone',
  !plan.collapse.some((c) => c.drop.startsWith('lone')));
check('no pair here is conflicted', plan.conflicted.length === 0);

/* ---------------------------------------------------- which row survives -- */

const ordered = rankForKeeping([
  { dedupe_key: 'b', status: 'skipped', salary_min: 200000, posted: 'x', match_pct: 9 },
  { dedupe_key: 'a', status: 'submitted', salary_min: null, posted: null, match_pct: null }
]);
/* History outranks information. A submitted row is what actually happened. */
check('a submitted row is kept even when the other carries more data',
  ordered[0].dedupe_key === 'a', ordered[0].dedupe_key);

const richer = rankForKeeping([
  { dedupe_key: 'thin', status: 'queued', salary_min: null, posted: null, match_pct: null },
  { dedupe_key: 'rich', status: 'queued', salary_min: 200000, posted: 'x', match_pct: 70 }
]);
check('otherwise the row carrying a band and a date is kept',
  richer[0].dedupe_key === 'rich', richer[0].dedupe_key);

const tie = rankForKeeping([
  { dedupe_key: 'mitratech|sr. product manager ai - mitratech', status: 'queued', salary_min: null, posted: null, match_pct: null },
  { dedupe_key: 'mitratech|sr. product manager ai', status: 'queued', salary_min: null, posted: null, match_pct: null }
]);
/* The longer key is nearly always the one with the employer appended. */
check('on a tie the shorter key wins, which is the one without the appended employer',
  tie[0].dedupe_key === 'mitratech|sr. product manager ai', tie[0].dedupe_key);

/* --------------------------------------------- two real applications -- */

const bothSubmitted = [
  { dedupe_key: 'twilio|staff pm', company: 'Twilio', title: 'Staff PM', url: TWILIO, status: 'submitted', submitted_at: '2026-08-25T01:30:00Z' },
  { dedupe_key: 'twilio|staff pm - twilio', company: 'Twilio', title: 'Staff PM - Twilio', url: TWILIO, status: 'submitted', submitted_at: '2026-08-25T01:30:00Z' }
];
const conflictPlan = planDedupe(bothSubmitted);
check('a pair that both reached submitted is reported, not collapsed',
  conflictPlan.collapse.length === 0 && conflictPlan.conflicted.length === 1,
  `collapse=${conflictPlan.collapse.length} conflicted=${conflictPlan.conflicted.length}`);
check('and the report names both keys so a person can decide',
  conflictPlan.conflicted[0].keys.length === 2, conflictPlan.conflicted[0].keys.join(' | '));

const mixed = planDedupe([
  { dedupe_key: 'a|x', company: 'A', title: 'X', url: TWILIO, status: 'submitted', submitted_at: '2026-08-25T01:30:00Z' },
  { dedupe_key: 'a|x dup', company: 'A', title: 'X dup', url: TWILIO, status: 'queued' }
]);
check('a submitted row beside a queued one collapses the QUEUED one',
  mixed.collapse.length === 1 && mixed.collapse[0].drop === 'a|x dup',
  mixed.collapse[0] && mixed.collapse[0].drop);

/* ------------------------------------------------------------ the write -- */

/**
 * @param {Array<Record<string, any>>} rows
 */
function fakeD1(rows) {
  const writes = [];
  const state = rows.map((r) => ({ ...r }));
  return {
    writes, state,
    query: async (sql, params) => {
      writes.push({ sql, params });
      const row = state.find((r) => r.dedupe_key === params[params.length - 1]);
      if (row && row.status !== 'submitted') { row.status = 'skipped'; row.blocked_reason = DUPLICATE_REASON; }
      return { result: [{ meta: { changes: 1 } }] };
    }
  };
}

const live = fakeD1(ROWS);
const wrote = await repairDuplicates({ write: true, rows: ROWS, query: live.query });
check('the write marks the duplicate', wrote.collapsed === 1, `collapsed=${wrote.collapsed}`);
check('it is marked rather than deleted, so anything referring to it still resolves',
  live.writes.every((w) => /^UPDATE/i.test(w.sql.trim())), live.writes[0].sql.trim().slice(0, 30));
check('the statement still refuses to touch a submitted row',
  live.writes.every((w) => /status != 'submitted'/.test(w.sql)));
check('the reason says which row it duplicates, not just "duplicate"',
  live.writes.some((w) => w.params.some((p) => String(p).includes('kin|director pm'))),
  String(live.writes[0].params[0]).slice(0, 60));
/* A collapsed row must lose its rank, or it keeps a position in a list it is
   no longer part of. */
check('a collapsed row loses rank_pct and pay_tier',
  live.writes.every((w) => /rank_pct = NULL/.test(w.sql) && /pay_tier = NULL/.test(w.sql)));

/* The writer has to use a reason the READER already rules out. A new word --
   "duplicate" -- matched neither index.html's RULED_OUT list nor its label map,
   so five collapsed rows stayed on the list showing the raw string. Binding the
   two here is what stops them drifting apart again. */
const page = readFileSync('index.html', 'utf8');
const ruledOut = (page.match(/var RULED_OUT = \[(.*?)\]/) || [])[1] || '';
check('the reason written is one index.html rules off the list',
  ruledOut.includes(`"${DUPLICATE_REASON}"`), `RULED_OUT = [${ruledOut}]`);
check('and one it has a human label for, not a raw slug',
  page.includes(JSON.stringify(DUPLICATE_REASON) + ': "'), DUPLICATE_REASON);

const second = await repairDuplicates({ write: true, rows: live.state, query: fakeD1(live.state).query });
check('a second pass over the collapsed rows finds nothing to do',
  second.collapsed === 0, `collapsed=${second.collapsed}`);

/* ------------------------------------------- the guard that stops recurrence -- */

/* The appended-employer shape now has to be caught BEFORE a second row is
   written, or this repair runs forever against a source that keeps producing
   them. */
check('sameJob catches an employer appended to the title',
  sameJob({ company: 'Twilio', title: 'Staff Product Manager - Enterprise AI' },
    { company: 'Twilio', title: 'Staff Product Manager - Enterprise AI - Twilio' }));
check('and the same shape at another employer',
  sameJob({ company: 'Mitratech', title: 'Sr. Product Manager AI' },
    { company: 'Mitratech', title: 'Sr. Product Manager AI - Mitratech' }));
check('a double space is already handled by the normaliser',
  sameJob({ company: 'Temporal', title: 'Staff PM, Cloud Namespace' },
    { company: 'Temporal', title: 'Staff PM,  Cloud Namespace' }));

/* The stripping must not turn two different jobs at one employer into one. */
check('two different jobs at the same employer stay different',
  !sameJob({ company: 'Twilio', title: 'Product Manager, Messaging' },
    { company: 'Twilio', title: 'Product Manager, Voice' }));
/* The employer's name inside the title, not at the end, is part of the job. */
check('an employer name in the MIDDLE of a title is not stripped',
  withoutTrailingCompany(normalizeForDedupe('Product Manager, Twilio Voice'), 'twilio')
  === normalizeForDedupe('Product Manager, Twilio Voice'));
/* Stripping down to nothing would make every posting at an employer identical. */
check('a title that is only the employer name is not stripped to nothing',
  withoutTrailingCompany('twilio', 'twilio') === 'twilio');

console.log(bad
  ? `\n${bad} FAILED`
  : '\nduplicates collapse to the richest row, two real applications are left alone, and the appended-employer shape is caught at ingest');
process.exitCode = bad ? 1 : 0;
