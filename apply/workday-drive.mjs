/**
 * Workday wizard driver: signs in (creating the candidate account the first time)
 * and walks the multi-page application, filling each page from the profile and
 * the answer bank. It submits only when `submit` is true, and only from the
 * Review page.
 */

import fs from 'node:fs';
import {
  tenantCredentials, wdClick, wdFill, wdSelect, wdPromptPick,
  wdErrors, wdPageInfo, wdDebug, wdFieldGroups, wdAnswerGroup, markCredentialVerified, wdSelectOptions,
} from './workday.mjs';

const A = id => `[data-automation-id="${id}"]`;

/**
 * Open the posting, dismiss the cookie banner, click Apply and choose the
 * manual path, landing on the Create Account / Sign In page.
 * @param {import('playwright').Page} page
 * @param {string} url posting url
 * @param {string[]} log
 * @returns {Promise<boolean>} whether the account page was reached
 */
async function openApplyManually(page, url, log) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3500);
  const cookie = page.getByRole('button', { name: /accept cookies|accept all/i }).first();
  if (await cookie.count().catch(() => 0)) { await cookie.click().catch(() => {}); await page.waitForTimeout(800); }

  if (/the page you are looking for doesn't exist/i.test(await page.locator('body').innerText().catch(() => ''))) {
    log.push('wd: posting is gone (Workday 404 page)');
    return false;
  }
  await page.getByRole('link', { name: /^apply$/i })
    .or(page.getByRole('button', { name: /^apply$/i })).first()
    .click({ timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(3500);
  /* Take the "Autofill with Resume" path, not "Apply Manually". Stricter
     tenants (Autodesk) make Job Title / Company / From / To required on My
     Experience, and nothing in the profile carries structured employment
     history. Workday parses his real resume PDF into those fields itself, which
     is the only source for them that is not invented. Both routes land on the
     same Create Account / Sign In page. */
  const entry = page.getByRole('button', { name: /autofill with resume/i }).first();
  if (await entry.count().catch(() => 0)) {
    await entry.click({ timeout: 15000 }).catch(() => {});
  } else {
    await page.getByRole('button', { name: /apply manually/i }).first().click({ timeout: 15000 }).catch(() => {});
  }
  await page.waitForTimeout(6000);
  return (await page.locator(A('email')).count().catch(() => 0)) > 0
      || (await page.locator(A('formField-source')).count().catch(() => 0)) > 0;
}

/**
 * Create the candidate account, or sign in when it already exists.
 * @param {import('playwright').Page} page
 * @param {{email:string,password:string,fresh:boolean}} cred
 * @param {string[]} log
 * @returns {Promise<'signed-in'|'blocked'>}
 */
async function authenticate(page, cred, applyUrl, log) {
  const A_ = A;
  const onCreate = async () => (await page.locator(A_('verifyPassword')).count().catch(() => 0)) > 0;
  const onSignIn = async () => (await page.locator(A_('signInSubmitButton')).count().catch(() => 0)) > 0;
  /* The ONLY trustworthy "we are signed in" signal is the utility menu, which
     carries the account email. An earlier version treated "the create-account
     form vanished" as success — NVIDIA bounces a fresh account straight to a
     standalone /login page, so the run marched into the wizard loop
     unauthenticated and reported a bogus wd-stuck. */
  /* NOT just "a utilityMenuButton exists": Autodesk renders a language picker
     with that same automation id on the signed-OUT create-account page, so the
     bare presence check returned true for an anonymous visitor and the run
     marched into the wizard unauthenticated. The account menu is the one whose
     label is the candidate's email address. */
  const signedIn = async () => await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-automation-id="utilityMenuButton"]'))
      .some(e => (e.innerText || '').includes('@'))).catch(() => false);

  if (cred.fresh && await onCreate()) {
    await page.locator(A_('email')).first().fill(cred.email);
    await page.locator(A_('password')).first().fill(cred.password);
    await page.locator(A_('verifyPassword')).first().fill(cred.password);
    const agree = page.locator(A_('createAccountCheckbox')).first();
    if (await agree.count().catch(() => 0)) await agree.check({ force: true }).catch(() => {});
    await wdClick(page.locator(A_('createAccountSubmitButton')));
    await page.waitForTimeout(9000);
    if (await signedIn()) { log.push('wd: created candidate account'); return 'signed-in'; }
    const errs = await wdErrors(page);
    log.push(`wd: create-account did not sign us in${errs.length ? ` (${errs.join(' | ').slice(0, 160)})` : ''}; trying sign-in`);
  }

  for (let i = 0; i < 4 && !(await onSignIn()) && !(await signedIn()); i++) {
    await wdClick(page.locator(A_('signInLink')));
    await page.waitForTimeout(2500);
  }
  if (await signedIn()) { log.push('wd: already signed in'); return 'signed-in'; }
  if (!(await onSignIn())) { log.push('wd: could not reach the sign-in form'); return 'blocked'; }
  await page.locator(A_('email')).first().fill(cred.email);
  await page.locator(A_('password')).first().fill(cred.password);
  await wdClick(page.locator(A_('signInSubmitButton')));
  await page.waitForTimeout(9000);
  if (!(await signedIn())) {
    log.push(`wd: sign-in failed: ${(await wdErrors(page)).join(' | ').slice(0, 200)}`);
    return 'blocked';
  }
  /* Signing in on the tenant's standalone /login page lands on the careers home,
     not back in the wizard. Go to the application URL explicitly. */
  if (!/\/apply\//.test(page.url())) {
    await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(6000);
  }
  log.push('wd: signed in');
  return 'signed-in';
}

/**
 * Fill the "My Information" page.
 * @param {import('playwright').Page} page
 * @param {object} profile
 * @param {string[]} log
 */
async function fillMyInformation(page, profile, log) {
  const id = profile.identity;
  /* "Online job board" is the answer bank's value. The leaf list is per tenant,
     so prefer the generic "Other" under Job Boards over naming a specific board
     that nothing in the profile says he used. */
  const picked = await wdPromptPick(
    page, 'source',
    [/job board/i, /job (site|search)/i, /online/i, /^other$/i, /social/i],
    [/^other$/i, /^other job board/i, /^linkedin$/i, /^indeed$/i, /company (web ?site|career)/i],
    log,
  );
  if (!picked) log.push('wd: WARNING - "How Did You Hear About Us" left empty');
  await wdSelect(page, 'country', /United States of America/i, log);
  await wdFill(page, 'legalName--firstName', id.firstName, log);
  await wdFill(page, 'legalName--lastName', id.lastName, log);
  await wdFill(page, 'addressSection_addressLine1', id.street, log);
  await wdFill(page, 'addressLine1', id.street, log);
  await wdFill(page, 'addressSection_city', id.city, log);
  await wdFill(page, 'city', id.city, log);
  await wdSelect(page, 'addressSection_countryRegion', new RegExp(`^${id.state}$`, 'i'), log);
  await wdSelect(page, 'countryRegion', new RegExp(`^${id.state}$`, 'i'), log);
  await wdFill(page, 'addressSection_postalCode', id.postalCode, log);
  await wdFill(page, 'postalCode', id.postalCode, log);
  await wdSelect(page, 'phoneType', /^mobile$/i, log);
  await wdFill(page, 'phoneNumber', id.phone, log);
  // "Have you previously worked for <company>?" — always No for these employers.
  for (const f of ['candidateIsPreviousWorker', 'previousWorker']) {
    const no = page.locator(A(`formField-${f}`)).locator('input[type=radio][value="false"], label:has-text("No") input[type=radio]').first();
    if (await no.count().catch(() => 0)) { await no.check({ force: true }).catch(() => {}); log.push(`wd: ${f} = No`); }
  }
}

/**
 * Attach the resume on the "My Experience" page.
 * @param {import('playwright').Page} page
 * @param {string} resumePath
 * @param {string[]} log
 */
async function attachResume(page, resumePath, log) {
  const name = resumePath.split(/[\/]/).pop();
  if ((await page.locator('body').innerText().catch(() => '')).includes(name)) return false;
  const inputs = page.locator('input[type=file]');
  const n = await inputs.count().catch(() => 0);
  if (!n) return false;
  for (let i = 0; i < n; i++) {
    await inputs.nth(i).setInputFiles(resumePath).catch(() => {});
    await page.waitForTimeout(5000);
  }
  const landed = (await page.locator('body').innerText().catch(() => '')).includes(name);
  log.push(landed ? `wd: attached ${name}` : `wd: RESUME UPLOAD NOT CONFIRMED`);
  return landed;
}


/**
 * Standing answers, matched against the QUESTION WORDING because Workday gives
 * tenant-specific questions opaque GUID field ids. Order matters: the
 * sponsorship test must run before the work-authorisation test, since both
 * mention working legally.
 * Sources: apply-profile.local.json eligibility/policy blocks.
 * @type {[RegExp,RegExp][]}
 */
const WD_QUESTIONS = [
  /* Sponsorship first: the sponsorship question and the work-authorisation
     question both talk about working legally, and they take opposite answers.
     Real wording seen in the queue: "Will you now or at any point in the future
     require Alteryx to commence 'sponsor' an immigration case or initiate a
     visa transfer in order to employ you". */
  [/sponsor|immigration case|visa transfer|work (permit|visa)/i, /^no$/i],
  [/authoriz(ed|ation)|legally (entitled|permitted|eligible)|eligible to work|right to work/i, /^yes$/i],
  [/age of (18|eighteen)|at least (18|eighteen)|over (the age of )?(18|eighteen)|are you (18|eighteen)/i, /^yes$/i],
  [/(work(ed)?|employed|engaged).{0,90}(temporar|consultant|contingent|contractor|vendor|agency|intern|subsidiar|affiliate|in the past|previously|before)/i, /^no$/i],
  [/(relative|family member|related to|friend).{0,80}(work|employ)/i, /^no$/i],
  [/referred by|employee referral/i, /^no$/i],
  [/non-?compete|restrictive covenant|post-?employment restriction/i, /^no$/i],
  [/(agree|consent|acknowledge).{0,90}(terms|privacy|policy|statement|notice)|have you read and/i, /^yes$/i],
];


/**
 * Answer the tenant-specific questions on an Application Questions page.
 * Anything unmatched is returned so the caller can stop honestly instead of
 * submitting a half-filled form.
 * @param {import('playwright').Page} page
 * @param {string[]} log
 * @returns {Promise<string[]>} unanswered question wordings
 */
async function answerQuestions(page, profile, answerBank, log) {
  const unanswered = [];
  for (const grp of await wdFieldGroups(page)) {
    if (/salary|compensation|base pay|pay expectation/i.test(grp.text)) {
      if (await answerSalary(page, grp, profile, log)) continue;
      unanswered.push(grp.text.slice(0, 120));
      continue;
    }
    if (grp.kind === 'text' || grp.kind === 'textarea') {
      if (await answerFreeText(page, grp, answerBank, log)) continue;
      if (/\*/.test(grp.text)) unanswered.push(grp.text.slice(0, 120));
      continue;
    }
    if (!['select', 'radio'].includes(grp.kind)) continue;
    const hit = WD_QUESTIONS.find(([q]) => q.test(grp.text));
    if (!hit) { unanswered.push(grp.text.slice(0, 120)); continue; }
    const ok = await wdAnswerGroup(page, grp, hit[1], log);
    if (!ok) unanswered.push(grp.text.slice(0, 120));
  }
  return unanswered;
}

/**
 * Answer a salary-expectation question. Tenants render it either as a free-text
 * box or as a list of bands, so the band has to be chosen from what is offered.
 * Profile rule: aim for targetUsd, never answer below floorUsd, never take the
 * top of a posted range.
 * @param {import('playwright').Page} page
 * @param {{field:string,kind:string,text:string}} grp
 * @param {object} profile
 * @param {string[]} log
 * @returns {Promise<boolean>}
 */
async function answerSalary(page, grp, profile, log) {
  const { floorUsd, targetUsd, answerTemplate } = profile.compensation;
  if (grp.kind === 'text' || grp.kind === 'textarea') {
    const ok = await wdFill(page, grp.field, answerTemplate, log);
    if (ok) log.push('wd: salary expectation answered from the profile template');
    return ok;
  }
  if (grp.kind !== 'select') return false;
  const opts = await wdSelectOptions(page, grp.field);
  log.push(`wd: salary bands offered: ${opts.join(' / ').slice(0, 220)}`);
  /** @type {{label:string,lo:number,hi:number}[]} */
  const bands = [];
  for (const label of opts) {
    const k = /k/i.test(label);
    const nums = (label.match(/\d[\d,]*/g) || [])
      .map(n => Number(n.replace(/,/g, '')))
      .map(v => (k && v < 1000 ? v * 1000 : v))
      .filter(v => v >= 1000);
    if (!nums.length) continue;
    /* "Under $50K" is an open BOTTOM and "$400K+" an open TOP. Treating both as
       [n, Infinity] made "Under $50K" look like it contained a $200K target,
       and it is the first option in the list. */
    if (nums.length === 1) {
      if (/under|less than|below|up to/i.test(label)) bands.push({ label, lo: 0, hi: nums[0] });
      else bands.push({ label, lo: nums[0], hi: Infinity });
    } else {
      bands.push({ label, lo: nums[0], hi: nums[nums.length - 1] });
    }
  }
  if (!bands.length) return false;
  /* Highest band whose floor is still at or below the target, and whose ceiling
     clears the profile's floor. Profile rule: aim for targetUsd, never below
     floorUsd, never the top of a posted range. */
  const chosen = bands
    .filter(b => b.lo <= targetUsd && b.hi >= floorUsd)
    .sort((a, b) => b.lo - a.lo)[0];
  if (!chosen) return false;
  const ok = await wdSelect(page, grp.field, chosen.label, log);
  if (ok) log.push(`wd: salary band = ${chosen.label}`);
  return ok;
}

/**
 * Fill a free-text application question from the answer bank, matching on the
 * question wording. Nothing is generated here: every answer is pre-written in
 * apply/answers.general.local.json.
 * @param {import('playwright').Page} page
 * @param {{field:string,text:string}} grp
 * @param {Record<string,string>} bank
 * @param {string[]} log
 * @returns {Promise<boolean>}
 */
async function answerFreeText(page, grp, bank, log) {
  const q = grp.text.toLowerCase();
  const key = Object.keys(bank).filter(k => k !== '_comment').find(k => q.includes(k.toLowerCase()));
  if (!key) return false;
  const ok = await wdFill(page, grp.field, bank[key], log);
  if (ok) log.push(`wd: answered "${key.slice(0, 44)}" (${bank[key].length} chars)`);
  return ok;
}

/**
 * Voluntary Disclosures / Self Identify pages. The profile's standing policy is
 * to decline every EEO question, and to tick the terms acknowledgement.
 * @param {import('playwright').Page} page
 * @param {object} profile
 * @param {string[]} log
 */
async function fillDisclosures(page, profile, log) {
  const DECLINE = /decline to (self[- ]identify|answer|specify)|prefer not to (answer|say|disclose)|do not wish to (answer|self[- ]identify)|don't wish to answer|i do not wish/i;
  for (const grp of await wdFieldGroups(page)) {
    if (grp.kind === 'select') await wdSelect(page, grp.field, DECLINE, log);
    if (grp.kind === 'radio') await wdAnswerGroup(page, grp, DECLINE, log);
  }
  const terms = page.locator('[data-automation-id="agreementCheckbox"], [data-automation-id*="termsAndConditions"] input[type=checkbox], input[type=checkbox][id*="gree"]').first();
  if (await terms.count().catch(() => 0)) { await terms.check({ force: true }).catch(() => {}); log.push('wd: ticked terms acknowledgement'); }
  // The disability form asks for name and today's date.
  await wdFill(page, 'name', profile.identity.fullName, log);
  const today = new Date();
  const mm = page.locator('[data-automation-id="dateSectionMonth-input"]').first();
  if (await mm.count().catch(() => 0)) {
    await mm.fill(String(today.getMonth() + 1)).catch(() => {});
    await page.locator('[data-automation-id="dateSectionDay-input"]').first().fill(String(today.getDate())).catch(() => {});
    await page.locator('[data-automation-id="dateSectionYear-input"]').first().fill(String(today.getFullYear())).catch(() => {});
    log.push('wd: signed the self-identification date');
  }
}

/**
 * Drive the whole Workday application.
 * @param {object} opts
 * @param {import('playwright').Page} opts.page
 * @param {string} opts.url posting url
 * @param {string} opts.root repo root
 * @param {object} opts.profile
 * @param {Record<string,string>} [opts.answerBank] pre-written free-text answers
 * @param {boolean} opts.submit
 * @param {(step:string)=>Promise<string>} opts.shot screenshot helper
 * @param {string[]} opts.log
 * @returns {Promise<{state:string,detail?:string}>}
 */
export async function runWorkday({ page, url, root, profile, answerBank = {}, submit, shot, log }) {
  const host = new URL(url).host;
  const cred = tenantCredentials(root, host, profile.identity.email);
  log.push(`wd: tenant ${host}, credentials ${cred.fresh ? 'generated' : 'reused'}`);

  if (!(await openApplyManually(page, url, log))) {
    await shot('wd-1-no-apply');
    return { state: 'wd-no-apply-path' };
  }
  await shot('wd-1-account');
  const applyUrl = page.url();

  const auth = await authenticate(page, cred, applyUrl, log);
  markCredentialVerified(root, host, auth === 'signed-in');
  if (auth === 'blocked') {
    await shot('wd-2-auth-blocked');
    return { state: 'wd-auth-blocked', detail: 'candidate account could not be created or signed in for this tenant' };
  }
  await shot('wd-2-signed-in');

  const seen = [];
  let recovered = 0;
  for (let step = 0; step < 14; step++) {
    await page.waitForTimeout(1500);
    /* Workday throws a bare "Something went wrong. Please refresh the page"
       when a wizard page is re-entered on a resumed application. It really does
       clear on a reload, so retry twice before giving up. */
    if (/something went wrong/i.test(await page.locator('body').innerText().catch(() => '')) && recovered < 2) {
      recovered += 1;
      log.push(`wd: "Something went wrong" - reloading (${recovered})`);
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(7000);
    }
    const info = await wdPageInfo(page);
    /* The progress bar prints every step name on every page, so testing the page
       text for "Review" matched on page 1 and short-circuited the whole wizard.
       Use the name of the CURRENT step only. */
    const name = info.stepName || info.heading.slice(0, 60);
    const label = `${info.step} :: ${name}`;
    seen.push(label);
    log.push(`wd: page ${step + 1} - ${label}`);
    await wdDebug(page, `page-${step + 1}`);
    await shot(`wd-p${step + 1}`);

    if (/my information/i.test(name)) await fillMyInformation(page, profile, log);
    /* The resume input appears on My Experience on the manual route and on a
       dedicated upload page on the autofill route, so attach wherever an empty
       file input shows up rather than keying on the step name. */
    await attachResume(page, profile.documents.resume, log);
    if (/application question|additional question|questionnaire/i.test(name)) {
      const missed = await answerQuestions(page, profile, answerBank, log);
      if (missed.length) {
        await shot(`wd-p${step + 1}-unanswered`);
        return { state: 'wd-unknown-question', detail: missed.join(' | ').slice(0, 400) };
      }
    }
    if (/voluntary disclosure|self identify|self-identif|disability/i.test(name)) {
      await fillDisclosures(page, profile, log);
    }

    const hasNext = (await page.locator(A('pageFooterNextButton')).count().catch(() => 0)) > 0;
    if (/review/i.test(name) || !hasNext) {
      const submitBtn = page.getByRole('button', { name: /^submit$/i }).first();
      if (!(await submitBtn.count().catch(() => 0))) {
        return { state: 'wd-stuck', detail: `no next or submit button on: ${label}` };
      }
      if (!submit) { await shot('wd-review-dry'); return { state: 'wd-review-reached-dry-run' }; }
      await wdClick(submitBtn);
      await page.waitForTimeout(9000);
      await shot('wd-submitted');
      const after = (await page.locator('body').innerText().catch(() => '')).slice(0, 1500);
      const confirmed = /you have (already )?(applied|submitted)|thank you for applying|application (was )?(submitted|received)|we('| ha)ve received your application/i.test(after);
      return { state: confirmed ? 'submitted' : 'submitted-unconfirmed', detail: after.replace(/\s+/g, ' ').slice(0, 300) };
    }

    const before = page.url() + '|' + info.step;
    await wdClick(page.locator(A('pageFooterNextButton')));
    await page.waitForTimeout(6000);
    const errs = await wdErrors(page);
    const nowInfo = await wdPageInfo(page);
    if (nowInfo.step === info.step && errs.length) {
      await shot(`wd-p${step + 1}-errors`);
      return { state: 'wd-validation-blocked', detail: errs.join(' | ').slice(0, 400) };
    }
    if (page.url() + '|' + nowInfo.step === before && !errs.length) {
      await shot(`wd-p${step + 1}-nomove`);
      return { state: 'wd-stuck', detail: `page did not advance from ${label}` };
    }
  }
  return { state: 'wd-too-many-pages', detail: seen.join(' -> ') };
}
