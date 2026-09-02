/**
 * Blocked-employer gate, match boundaries, and the script that applies the
 * block to rows already in the queue.
 *
 * Every new rule has an input that makes it FAIL. Coinbase is the fail case;
 * emptying the list, and "Bitcoin Base", are the pass cases.
 *
 *   node ingest/test-employer-block.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { requirementsGate, scoreOne } from './fit-score.mjs';
import {
  BLOCKED_EMPLOYERS,
  employerBlockReason,
  findBlockedEmployer,
  normalizeEmployerName
} from './blocked-employers.mjs';
import { employerBlockWrite, rowsToBlock } from './apply-employer-block.mjs';
import {
  matchesRetiredSalarySkip,
  decideReopen,
  reopenWrite,
  stillRejectedWrite
} from './reopen-second-lane.mjs';
import { decideQueuedGate, queuedGateWrite } from './queued-gate.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname)
  .replace(/^\/([A-Za-z]:)/, '$1'), '..');

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

const GOOD = { title: 'Senior Product Manager', work_type: 'Remote US' };
const EMPLOYER_REASON = 'employer: Coinbase is blocked - employer application limit reached';

/* ---- normalisation: Coinbase Global matches; Bitcoin Base does not -- */

check('"Coinbase Global, Inc." normalises to a string containing coinbase',
  normalizeEmployerName('Coinbase Global, Inc.').includes('coinbase'),
  normalizeEmployerName('Coinbase Global, Inc.'));
check('"Bitcoin Base" does not contain coinbase after normalisation',
  !normalizeEmployerName('Bitcoin Base').includes('coinbase'),
  normalizeEmployerName('Bitcoin Base'));
check('stripping spaces WOULD make Bitcoin Base match — that is why we keep them',
  normalizeEmployerName('Bitcoin Base').replace(/ /g, '').includes('coinbase'));

check('Coinbase Global, Inc. is blocked',
  !!findBlockedEmployer('Coinbase Global, Inc.') &&
    findBlockedEmployer('Coinbase Global, Inc.').name === 'Coinbase');
check('Bitcoin Base is not blocked', findBlockedEmployer('Bitcoin Base') === null);
check('empty company is not blocked', findBlockedEmployer('') === null);
check('Stripe is not blocked', findBlockedEmployer('Stripe') === null);

/* ---- the gate, both directions -------------------------------------- */

const coinbase = requirementsGate({ ...GOOD, company: 'Coinbase' }, null);
check('a Coinbase row fails the gate', coinbase.ok === false,
  (coinbase.reasons || []).join('; '));
check('the Coinbase fail names the employer rule',
  (coinbase.reasons || []).includes(EMPLOYER_REASON),
  String((coinbase.reasons || []).join('; ')));

const emptied = requirementsGate({ ...GOOD, company: 'Coinbase' }, null, { blockedEmployers: [] });
check('the same Coinbase row with the employer removed from the list passes',
  emptied.ok === true, (emptied.reasons || []).join('; '));

const globalInc = requirementsGate({ ...GOOD, company: 'Coinbase Global, Inc.' }, null);
check('"Coinbase Global, Inc." fails the gate',
  globalInc.ok === false && (globalInc.reasons || []).includes(EMPLOYER_REASON));

const bitcoin = requirementsGate({ ...GOOD, company: 'Bitcoin Base' }, null);
check('"Bitcoin Base" is not blocked', bitcoin.ok === true,
  (bitcoin.reasons || []).join('; '));

const scored = scoreOne({ ...GOOD, company: 'Coinbase', dedupe_key: 'cb' }, null);
check('a blocked employer clears pay_tier the way any gate fail does',
  scored.gate.ok === false && scored.pay_tier === null && scored.rank === null);

/* The JSON file is what the default list is. If match were "base", Bitcoin
   Base would be blocked and the cases above would not be testing the list. */
const fromFile = BLOCKED_EMPLOYERS.find((e) => e.name === 'Coinbase');
check('blocked-employers.json lists Coinbase with match "coinbase"',
  !!fromFile && fromFile.match === 'coinbase' &&
    fromFile.reason === 'employer application limit reached');
check('employerBlockReason uses the committed name and reason',
  employerBlockReason(fromFile) === EMPLOYER_REASON);

/* ---- apply-employer-block: 9 Coinbase rows, submitted is history ---- */

const nine = [
  { dedupe_key: 'q0', company: 'Coinbase', status: 'queued' },
  { dedupe_key: 'q1', company: 'Coinbase', status: 'queued' },
  { dedupe_key: 'q2', company: 'Coinbase', status: 'queued' },
  { dedupe_key: 'q3', company: 'Coinbase', status: 'queued' },
  { dedupe_key: 'q4', company: 'Coinbase', status: 'queued' },
  { dedupe_key: 'q5', company: 'Coinbase', status: 'queued' },
  { dedupe_key: 'q6', company: 'Coinbase', status: 'queued' },
  { dedupe_key: 'sk', company: 'Coinbase', status: 'skipped' },
  { dedupe_key: 'sub', company: 'Coinbase', status: 'submitted' }
];
const extras = [
  { dedupe_key: 'bb', company: 'Bitcoin Base', status: 'queued' },
  { dedupe_key: 'inc', company: 'Coinbase Global, Inc.', status: 'queued' },
  { dedupe_key: 'st', company: 'Stripe', status: 'queued' }
];
const decided = rowsToBlock(nine);
const keys = decided.map((item) => item.row.dedupe_key);
check('blocks 7 queued + 1 already-skipped Coinbase, not the submitted one',
  decided.length === 8 &&
    keys.filter((k) => k.startsWith('q')).length === 7 &&
    keys.includes('sk') &&
    !keys.includes('sub'));
check('submitted Coinbase is never in the write list',
  decided.every((item) => item.row.status !== 'submitted' && item.row.dedupe_key !== 'sub'));

const extraBlock = rowsToBlock(extras);
const extraKeys = extraBlock.map((item) => item.row.dedupe_key);
check('Coinbase Global, Inc. would be skipped; Bitcoin Base and Stripe would not',
  extraBlock.length === 1 && extraKeys[0] === 'inc');
check('Bitcoin Base is not in the write list', !extraKeys.includes('bb'));
check('Stripe is not in the write list', !extraKeys.includes('st'));

const write = employerBlockWrite({ dedupe_key: 'q0' }, fromFile);
check('employer write sets status skipped',
  write.params.includes('skipped') && /status\s*=\s*\?/.test(write.sql));
check('employer write sets blocked_reason off-criteria',
  write.params.includes('off-criteria'));
check('employer write names the employer rule',
  write.params.includes(EMPLOYER_REASON));
check('employer write clears rank_pct and pay_tier',
  /rank_pct\s*=\s*NULL/.test(write.sql) && /pay_tier\s*=\s*NULL/.test(write.sql));
check('employer write refuses a submitted row in the WHERE',
  /status\s*!=\s*\?/.test(write.sql) && write.params.includes('submitted'));

const blockSrc = fs.readFileSync(path.join(ROOT, 'ingest', 'apply-employer-block.mjs'), 'utf8');
check('apply-employer-block --write with no token process.exit(1)s',
  /!token[\s\S]{0,200}process\.exit\(1\)/.test(blockSrc));

/* ---- reopen: full gate, never salary-only, never submitted ---------- */

check('retired $180k skip text matches',
  matchesRetiredSalarySkip('salary: publishes $175k, under the $180k floor (second tier)'));
check('retired $160k skip text matches',
  matchesRetiredSalarySkip('salary: publishes $150k, below the $160k second tier'));
check('an unrelated skip is not a retired salary skip',
  matchesRetiredSalarySkip('location: San Francisco, CA') === false);

check('a submitted row is never reopened, even if the gate would pass',
  decideReopen({ status: 'submitted', dedupe_key: 'sub' }, { ok: true, reasons: [] }).action === 'leave');
check('a skipped row that now passes is reopened',
  decideReopen({ status: 'skipped', dedupe_key: 'k' }, { ok: true, reasons: [] }).action === 'reopen');
check('a skipped row that still fails the full gate stays skipped',
  decideReopen({ status: 'skipped', dedupe_key: 'k' }, { ok: false, reasons: ['location: San Francisco'] }).action === 'keep-skip');

/* Failing input: reversing salary alone would re-queue a San Francisco role
   whose original skip mentioned the retired $180k reason. */
const sfNowPays = requirementsGate({
  title: 'Senior Product Manager',
  work_type: 'San Francisco, CA',
  salary_min: 165000,
  salary_max: 175000
}, null);
check('full gate still rejects SF when the $165k-$175k salary now passes',
  sfNowPays.ok === false && (sfNowPays.reasons || []).some((r) => r.startsWith('location:')),
  (sfNowPays.reasons || []).join('; '));

const coinbaseNowPays = requirementsGate({
  ...GOOD,
  company: 'Coinbase',
  salary_min: 165000,
  salary_max: 175000
}, null);
check('full gate still rejects Coinbase when salary now passes',
  coinbaseNowPays.ok === false && (coinbaseNowPays.reasons || []).includes(EMPLOYER_REASON));

const rw = reopenWrite({ dedupe_key: 'k' });
check('reopen write only updates skipped rows',
  rw.params.includes('queued') && rw.params.includes('skipped') &&
    /status = \?/.test(rw.sql));
check('reopen write clears blocked_reason and blocked_detail',
  /blocked_reason = NULL/.test(rw.sql) && /blocked_detail = NULL/.test(rw.sql));

const keep = stillRejectedWrite({ dedupe_key: 'k' }, ['role: security product - "zero trust"']);
check('still-rejected write keeps status skipped and writes current reasons',
  keep.params.includes('skipped') &&
    keep.params[0] === 'role: security product - "zero trust"');

const reopenSrc = fs.readFileSync(path.join(ROOT, 'ingest', 'regate.mjs'), 'utf8');
check('regate --write with no token process.exit(1)s',
  /!token[\s\S]{0,200}process\.exit\(1\)/.test(reopenSrc));
check('regate re-runs requirementsGate, not a salary-only check',
  /requirementsGate\(/.test(reopenSrc) && !/salaryOnly|salary-only/.test(reopenSrc));

/* ---- queued pass: the whole gate, over rows already in the list ----- */

/* Teamworks sat in the queue after the role rule changed because nothing
   re-ran it against rows that were already there. */
const teamworksQueued = decideQueuedGate({
  ...GOOD,
  company: 'Teamworks',
  title: 'Senior Product Success Manager I (Nutrition, Pro)',
  status: 'queued',
  dedupe_key: 'tw'
}, 'A customer-success role sitting next to the product team.');
check('queued Teamworks product-success title is skipped',
  teamworksQueued.action === 'skip' &&
    (teamworksQueued.reasons || []).some((r) => r.startsWith('role:')),
  (teamworksQueued.reasons || []).join('; '));

const teamworksUnread = decideQueuedGate({
  ...GOOD,
  company: 'Teamworks',
  title: 'Senior Product Success Manager I (Nutrition, Pro)',
  status: 'queued',
  dedupe_key: 'tw-unread'
}, null);
check('Teamworks is still skipped when the description cannot be read',
  teamworksUnread.action === 'skip',
  (teamworksUnread.reasons || []).join('; '));

const teamworksSubmitted = decideQueuedGate({
  ...GOOD,
  company: 'Teamworks',
  title: 'Senior Product Success Manager I (Nutrition, Pro)',
  status: 'submitted',
  dedupe_key: 'tw-sub'
}, 'A customer-success role sitting next to the product team.');
check('submitted Teamworks is never in the write list',
  teamworksSubmitted.action === 'leave');

/* An unreadable description is unknown, not disqualifying. 114 queued rows
   currently have no cached JD. Treating that as a fail would empty a third
   of the list. */
const unreadClean = decideQueuedGate({
  ...GOOD,
  company: 'Acme',
  title: 'Senior Product Manager',
  status: 'queued',
  dedupe_key: 'unread'
}, null);
check('an unreadable description is not a skip',
  unreadClean.action === 'leave',
  (unreadClean.reasons || []).join('; '));

const unreadEmpty = decideQueuedGate({
  ...GOOD,
  company: 'Acme',
  title: 'Senior Product Manager',
  status: 'queued',
  dedupe_key: 'empty'
}, '');
check('an empty description is not a skip',
  unreadEmpty.action === 'leave',
  (unreadEmpty.reasons || []).join('; '));

const vclusterQueued = decideQueuedGate({
  ...GOOD,
  company: 'vCluster Labs',
  title: 'Staff Product Manager (vMetal)',
  status: 'queued',
  dedupe_key: 'vc'
}, 'help own the systems that discover, provision, configure, and manage physical hardware, turning racks of bare metal into a programmable platform for AI Cloud operators and hyperscalers');
check('queued vCluster hardware description is skipped',
  vclusterQueued.action === 'skip' &&
    (vclusterQueued.reasons || []).some((r) => r.includes('hardware')),
  (vclusterQueued.reasons || []).join('; '));

const skippedRow = decideQueuedGate({
  ...GOOD,
  company: 'Acme',
  title: 'Senior Product Success Manager I',
  status: 'skipped',
  dedupe_key: 'already'
}, 'whatever');
check('an already-skipped row is left on its original reason',
  skippedRow.action === 'leave');

const qw = queuedGateWrite({ dedupe_key: 'tw' }, {
  reasons: ['role: not a product role'],
  excludedDomain: null
});
check('queued-gate write sets status skipped',
  qw.params.includes('skipped') && /status\s*=\s*\?/.test(qw.sql));
check('queued-gate write sets blocked_reason off-criteria',
  qw.params.includes('off-criteria'));
check('queued-gate write records the gate reason',
  qw.params.includes('role: not a product role'));
check('queued-gate write clears rank_pct and pay_tier',
  /rank_pct\s*=\s*NULL/.test(qw.sql) && /pay_tier\s*=\s*NULL/.test(qw.sql));
check('queued-gate write refuses a submitted row in the WHERE',
  /status\s*!=\s*\?/.test(qw.sql) && qw.params.includes('submitted'));

check('regate re-runs the whole gate over queued rows',
  /decideQueuedGate\(/.test(reopenSrc) && /queuedGateWrite\(/.test(reopenSrc));
check('regate reads the cached description through fetchJd for queued rows',
  /queuedRows[\s\S]{0,400}fetchJd\(/.test(reopenSrc) ||
    /for \(const row of queuedRows\)[\s\S]{0,200}fetchJd\(/.test(reopenSrc));

console.log(bad ? `\n${bad} FAILED` : '\nemployer block and second-lane reopen hold on the cases built to break them');
process.exitCode = bad ? 1 : 0;
