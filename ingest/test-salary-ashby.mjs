/**
 * Ashby publishes pay as structured compensation, not in the description.
 *
 * Teamworks "Senior Product Success Manager I (Nutrition, Pro)" is the
 * measured case (2026-09-02): descriptionPlain is 5857 characters with no
 * dollar figures, while compensation.summaryComponents carries
 * 90000-120500 USD / 1 YEAR. A reader that only looks at the description
 * stores nothing, the pay lane treats that as unknown, and a $90k role
 * floats above priced postings it should sit below.
 *
 *   node ingest/test-salary-ashby.mjs
 */

import { salaryFromAshbyCompensation, salaryFromText } from './salary-from-posting.mjs';
import { recoverFromJd } from './salary-recover.mjs';
import {
  recoverableUnpriced, hasPublishedSalary, readCachedAshbyCompensation
} from './salary-audit.mjs';
import { strip } from './fit-score.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

/* The real Ashby compensation object for the Teamworks posting, measured
   2026-09-02 against
   https://api.ashbyhq.com/posting-api/job-board/teamworks?includeCompensation=true
   Job id 402d2bdc-81aa-430c-ac1f-ca30c4bfff33. Numbers come from the
   structured fields, never from parsing compensationTierSummary. */
const TEAMWORKS_COMPENSATION = {
  compensationTierSummary: '$90K – $120.5K',
  scrapeableCompensationSalarySummary: '$90K - $120.5K',
  compensationTiers: [
    {
      id: '7881404b-63fc-4c3b-9c17-4f1cef6d465a',
      tierSummary: 'On Target Earnings $90K – $120.5K',
      title: null,
      additionalInformation: null,
      components: [
        {
          id: '6d64384c-e1a1-4061-9c0a-2f3840767aad',
          summary: 'On Target Earnings $90K – $120.5K',
          compensationType: 'Salary',
          interval: '1 YEAR',
          currencyCode: 'USD',
          minValue: 90000,
          maxValue: 120500
        }
      ]
    }
  ],
  summaryComponents: [
    {
      compensationType: 'Salary',
      interval: '1 YEAR',
      currencyCode: 'USD',
      minValue: 90000,
      maxValue: 120500
    }
  ]
};

const SILENT_JD = 'I am the hiring manager. We work with UFC and WWE. Come join us. No figures here.';

const fromStructured = salaryFromAshbyCompensation(TEAMWORKS_COMPENSATION);
check('structured salary present, description silent: the band is read',
  fromStructured.min === 90000 && fromStructured.max === 120500,
  `got ${fromStructured.min}-${fromStructured.max}`);

check('salaryFromText on that silent description still returns null — the bug this exists to catch',
  salaryFromText(SILENT_JD).min === null,
  `got ${salaryFromText(SILENT_JD).min}`);

const summaryOnly = salaryFromAshbyCompensation({
  compensationTierSummary: '$90K – $120.5K',
  scrapeableCompensationSalarySummary: '$90K - $120.5K'
});
check('a summary string with no components is not parsed into a band',
  summaryOnly.min === null && summaryOnly.max === null,
  `got ${summaryOnly.min}-${summaryOnly.max}`);

const equityOnly = salaryFromAshbyCompensation({
  summaryComponents: [
    {
      compensationType: 'Equity',
      interval: '1 YEAR',
      currencyCode: 'USD',
      minValue: 50000,
      maxValue: 150000
    }
  ]
});
check('equity-only components: no salary band is invented',
  equityOnly.min === null && equityOnly.max === null,
  `got ${equityOnly.min}-${equityOnly.max}`);

const bonusOnly = salaryFromAshbyCompensation({
  compensationTiers: [
    {
      components: [
        {
          compensationType: 'Bonus',
          interval: '1 YEAR',
          currencyCode: 'USD',
          minValue: 20000,
          maxValue: 40000
        }
      ]
    }
  ]
});
check('bonus-only components: no salary band is invented',
  bonusOnly.min === null && bonusOnly.max === null,
  `got ${bonusOnly.min}-${bonusOnly.max}`);

const cad = salaryFromAshbyCompensation({
  summaryComponents: [
    {
      compensationType: 'Salary',
      interval: '1 YEAR',
      currencyCode: 'CAD',
      minValue: 180000,
      maxValue: 220000
    }
  ]
});
check('a non-USD currency is refused, not converted',
  cad.min === null && cad.max === null,
  `got ${cad.min}-${cad.max}`);

const hourly = salaryFromAshbyCompensation({
  summaryComponents: [
    {
      compensationType: 'Salary',
      interval: '1 HOUR',
      currencyCode: 'USD',
      minValue: 85,
      maxValue: 120
    }
  ]
});
check('an hourly interval is refused, not multiplied into an annual figure',
  hourly.min === null && hourly.max === null,
  `got ${hourly.min}-${hourly.max}`);

const noComp = salaryFromAshbyCompensation(null);
check('no compensation object at all: null, not a guess',
  noComp.min === null && noComp.max === null);

const emptyComp = salaryFromAshbyCompensation({});
check('an empty compensation object: null, not a guess',
  emptyComp.min === null && emptyComp.max === null);

const tiersOnly = salaryFromAshbyCompensation({
  compensationTiers: TEAMWORKS_COMPENSATION.compensationTiers
});
check('falls back to compensationTiers[].components[] when summaryComponents is missing',
  tiersOnly.min === 90000 && tiersOnly.max === 120500,
  `got ${tiersOnly.min}-${tiersOnly.max}`);

const preferSummary = salaryFromAshbyCompensation({
  summaryComponents: TEAMWORKS_COMPENSATION.summaryComponents,
  compensationTiers: [
    {
      components: [
        {
          compensationType: 'Salary',
          interval: '1 YEAR',
          currencyCode: 'USD',
          minValue: 1,
          maxValue: 2
        }
      ]
    }
  ]
});
check('summaryComponents wins over a different compensationTiers band',
  preferSummary.min === 90000 && preferSummary.max === 120500,
  `got ${preferSummary.min}-${preferSummary.max}`);

const mixed = salaryFromAshbyCompensation({
  summaryComponents: [
    {
      compensationType: 'Equity',
      interval: '1 YEAR',
      currencyCode: 'USD',
      minValue: 40000,
      maxValue: 80000
    },
    {
      compensationType: 'Salary',
      interval: '1 YEAR',
      currencyCode: 'USD',
      minValue: 90000,
      maxValue: 120500
    }
  ]
});
check('a Salary component is used and an Equity sibling is ignored',
  mixed.min === 90000 && mixed.max === 120500,
  `got ${mixed.min}-${mixed.max}`);

/* Kit, measured 2026-09-02: summaryComponents lists $50k EquityCashValue
   first, then $173k Salary. Taking the first number would rule a $173k
   role out as a $50k salary. */
const kit = salaryFromAshbyCompensation({
  compensationTierSummary: '$173K • $50K Equity • Profit Sharing',
  scrapeableCompensationSalarySummary: '$173K',
  summaryComponents: [
    {
      compensationType: 'EquityCashValue',
      interval: '1 YEAR',
      currencyCode: 'USD',
      minValue: 50000,
      maxValue: 50000
    },
    {
      compensationType: 'Salary',
      interval: '1 YEAR',
      currencyCode: 'USD',
      minValue: 173000,
      maxValue: 173000
    }
  ]
});
check('Kit $50k EquityCashValue is ignored; the $173k Salary is the band',
  kit.min === 173000 && kit.max === 173000,
  `got ${kit.min}-${kit.max}`);

const CONFLICT_JD = '<p>The base salary range is $180,000 - $220,000.</p>';
check('salaryFromText would read the description as 180000-220000',
  salaryFromText(strip(CONFLICT_JD)).min === 180000
    && salaryFromText(strip(CONFLICT_JD)).max === 220000);

const recovered = recoverFromJd(CONFLICT_JD, TEAMWORKS_COMPENSATION);
check('structured pay and a different number in the description: structured wins',
  recovered.kind === 'band'
    && recovered.band.min === 90000
    && recovered.band.max === 120500
    && recovered.source === 'ashby:compensation',
  `${recovered.kind} ${recovered.band.min}-${recovered.band.max} source=${recovered.source}`);

const silentRecover = recoverFromJd(SILENT_JD, TEAMWORKS_COMPENSATION);
check('recoverFromJd on a silent description plus structured pay returns the band',
  silentRecover.kind === 'band'
    && silentRecover.band.min === 90000
    && silentRecover.source === 'ashby:compensation',
  `${silentRecover.kind} ${silentRecover.band.min} source=${silentRecover.source}`);

check('recoverFromJd on unread text still recovers when structured pay is present',
  recoverFromJd(null, TEAMWORKS_COMPENSATION).kind === 'band'
    && recoverFromJd(null, TEAMWORKS_COMPENSATION).band.min === 90000);

check('recoverFromJd source for a description band stays posting:recover',
  recoverFromJd(CONFLICT_JD).source === 'posting:recover',
  String(recoverFromJd(CONFLICT_JD).source));

const ROW = {
  dedupe_key: 'teamworks|senior product success manager i (nutrition, pro)',
  status: 'queued',
  company: 'Teamworks',
  title: 'Senior Product Success Manager I (Nutrition, Pro)',
  url: 'https://jobs.ashbyhq.com/teamworks/402d2bdc-81aa-430c-ac1f-ca30c4bfff33',
  salary_min: null,
  salary_max: null
};

const lost = recoverableUnpriced(
  [ROW],
  () => SILENT_JD,
  () => TEAMWORKS_COMPENSATION
);
check('audit FAILS when the Ashby feed publishes structured pay and nothing is stored',
  lost.length === 1
    && lost[0].band.min === 90000
    && lost[0].band.max === 120500
    && lost[0].source === 'ashby:compensation',
  `lost=${lost.length} band=${lost[0] && lost[0].band.min}-${lost[0] && lost[0].band.max} source=${lost[0] && lost[0].source}`);

const stored = recoverableUnpriced(
  [{ ...ROW, salary_min: 90000, salary_max: 120500 }],
  () => SILENT_JD,
  () => TEAMWORKS_COMPENSATION
);
check('audit PASSES when that structured band is stored',
  stored.length === 0, `lost=${stored.length}`);

const noFeed = recoverableUnpriced([ROW], () => SILENT_JD, () => null);
check('audit PASSES when the feed published no structured pay and the description is silent',
  noFeed.length === 0, `lost=${noFeed.length}`);

const submitted = recoverableUnpriced(
  [{ ...ROW, status: 'submitted' }],
  () => SILENT_JD,
  () => TEAMWORKS_COMPENSATION
);
check('a submitted row is history, so structured pay there is not this audit',
  submitted.length === 0, `lost=${submitted.length}`);

check('salary_min = 0 is still not a published salary',
  hasPublishedSalary({ salary_min: 0, salary_max: null }) === false);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ashby-comp-'));
try {
  const named = 'ashby-teamworks-402d2bdc-81aa-430c-ac1f-ca30c4bfff33.compensation.json';
  fs.writeFileSync(
    path.join(tmp, named),
    JSON.stringify({ compensation: TEAMWORKS_COMPENSATION }),
    'utf8'
  );
  const fromCache = readCachedAshbyCompensation(
    'https://jobs.ashbyhq.com/teamworks/402d2bdc-81aa-430c-ac1f-ca30c4bfff33',
    tmp
  );
  check('cache hit on an Ashby compensation sidecar returns the structured object',
    !!(fromCache && fromCache.summaryComponents && fromCache.summaryComponents[0].minValue === 90000));
  const miss = readCachedAshbyCompensation(
    'https://jobs.ashbyhq.com/teamworks/00000000-0000-0000-0000-000000000000',
    tmp
  );
  check('a different Ashby job id is not a sidecar hit', miss === null);
  const gh = readCachedAshbyCompensation(
    'https://job-boards.greenhouse.io/mongodb/jobs/8143805',
    tmp
  );
  check('a Greenhouse URL is not an Ashby compensation hit', gh === null);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(bad
  ? `\n${bad} FAILED`
  : '\nAshby structured pay is read from numbers, never from the summary string, and the audit fails when it would go out unpriced');
process.exitCode = bad ? 1 : 0;
