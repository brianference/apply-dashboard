/**
 * Workday wizard driver: signs in (creating the candidate account the first time)
 * and walks the multi-page application, filling each page from the profile and
 * the answer bank. It submits only when `submit` is true, and only from the
 * Review page.
 */

import fs from 'node:fs';
import {
  tenantCredentials, saveTenantCredential, markPendingVerification, newPassword,
  wdClick, wdFill, wdSelect, wdPromptPick,
  wdErrors, wdPageInfo, wdDebug, wdFieldGroups, wdAnswerGroup, markCredentialVerified, wdSelectChoose, wdSelectOptions,
  wdSelectByKeyboard,
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
  if ((await page.locator(A('email')).count().catch(() => 0)) > 0
   || (await page.locator(A('formField-source')).count().catch(() => 0)) > 0) return true;

  /* Already signed in on this tenant, so Workday skipped Create Account and
     dropped us straight onto the wizard. Adobe did exactly that and the
     email-field test called it wd-no-apply-path while the screenshot showed
     step 1 of 7, Autofill with Resume, with a file drop and a Next button.
     A visible wizard IS the apply path. */
  const body = await page.locator('body').innerText().catch(() => '');
  const onWizard = /autofill with resume|my information|my experience|voluntary disclosures|self identify/i.test(body)
    && (await page.getByRole('button', { name: /^(next|continue|save and continue)$/i }).count().catch(() => 0)) > 0;
  if (onWizard) { log.push('wd: already signed in, landed on the wizard'); return true; }

  /* ServiceTitan hides the ordinary form behind a social-login gate: the page
     offers "Sign in with Google", "Sign in with LinkedIn" and "Sign in with
     email", and carries no signInLink and no email field until the third one is
     clicked. The screenshot showed step 1 of 8 with the whole progress bar
     rendered, so the wizard was there the entire time and this reported
     wd-no-apply-path. Never take the Google or LinkedIn buttons - those hand
     the tenant an account Brian did not choose to link. */
  const byEmail = page.getByRole('button', { name: /sign in with email|continue with email|use (your )?email/i }).first();
  if (await byEmail.count().catch(() => 0)) {
    log.push('wd: social-login gate, taking "Sign in with email"');
    await wdClick(byEmail);
    await page.waitForTimeout(4000);
    if ((await page.locator(A('email')).count().catch(() => 0)) > 0
     || (await page.locator(A('signInSubmitButton')).count().catch(() => 0)) > 0) return true;
  }
  /* A rendered Workday progress bar is itself the apply path, whatever the
     first step happens to be called. */
  if (/create account\/sign in/i.test(body)
      && (await page.locator(A('progressBar')).count().catch(() => 0)) > 0) {
    log.push('wd: wizard progress bar present, treating as the apply path');
    return true;
  }
  return false;
}

/**
 * Create the candidate account, or sign in when it already exists.
 * @param {import('playwright').Page} page
 * @param {{email:string,password:string,fresh:boolean}} cred
 * @param {string[]} log
 * @returns {Promise<'signed-in'|'blocked'>}
 */
/** The second address Brian authorised for candidate accounts. */
const ALT_EMAIL = 'brianference@gmail.com';

/**
 * Try one email/password against a tenant, either by signing in or by creating
 * the account, and report whether it left us genuinely signed in.
 *
 * No password reaches the log here or anywhere else. The log records the
 * APPROACH and its outcome, never the value -- see apply/redact.mjs and
 * apply/test-redact.local.mjs, which fail if a reporter stops redacting.
 *
 * @param {import('playwright').Page} page
 * @param {{kind:string,email:string,password:string}} a
 * @param {string} applyUrl
 * @param {() => Promise<boolean>} signedIn
 * @param {() => Promise<boolean>} onCreate
 * @param {() => Promise<boolean>} onSignIn
 * @param {string[]} log
 * @param {number} n which approach this is, for the log
 * @returns {Promise<boolean>}
 */
async function tryCredential(page, a, applyUrl, signedIn, onCreate, onSignIn, log, n) {
  await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(4000);
  if (await signedIn()) return true;

  /* Reach the form this approach needs. The two forms are reached by different
     links and a tenant may open on either one. */
  const wantCreate = a.kind === 'create';
  /* Cross a social-login gate first if there is one, by email only. */
  const byEmail = page.getByRole('button', { name: /sign in with email|continue with email|use (your )?email/i }).first();
  if (await byEmail.count().catch(() => 0)) {
    await wdClick(byEmail);
    await page.waitForTimeout(3500);
  }
  for (let i = 0; i < 4; i++) {
    if (wantCreate ? await onCreate() : await onSignIn()) break;
    await wdClick(page.locator(A(wantCreate ? 'createAccountLink' : 'signInLink')));
    await page.waitForTimeout(2500);
  }

  if (wantCreate) {
    if (!(await onCreate())) { log.push(`wd: approach ${n} - could not reach the create-account form`); return false; }
    await page.locator(A('email')).first().fill(a.email).catch(() => {});
    await page.locator(A('password')).first().fill(a.password).catch(() => {});
    await page.locator(A('verifyPassword')).first().fill(a.password).catch(() => {});
    const agree = page.locator(A('createAccountCheckbox')).first();
    if (await agree.count().catch(() => 0)) await agree.check({ force: true }).catch(() => {});
    await wdClick(page.locator(A('createAccountSubmitButton')));
  } else {
    if (!(await onSignIn())) { log.push(`wd: approach ${n} - could not reach the sign-in form`); return false; }
    await page.locator(A('email')).first().fill(a.email).catch(() => {});
    await page.locator(A('password')).first().fill(a.password).catch(() => {});
    await wdClick(page.locator(A('signInSubmitButton')));
  }
  await page.waitForTimeout(9000);
  if (await signedIn()) return true;
  const errs = await wdErrors(page);
  const body = await page.locator('body').innerText().catch(() => '');
  /* Capital One and Vanguard answer a successful CREATE with "An email has
     been sent to you. Please verify your account." The account now EXISTS with
     this password. Reporting a plain failure here threw that password away and
     left a real account nobody could sign into -- strictly worse than before
     the attempt. Say so, and let the caller persist it. */
  if (/verify your account|an email has been sent|check your email to (verify|activate)|verification (email|link) (has been )?sent/i.test(body + ' ' + errs.join(' '))) {
    log.push(`wd: approach ${n} created the account; the tenant wants an emailed verification before it will sign in`);
    return 'needs-verification';
  }
  log.push(`wd: approach ${n} (${a.kind}) did not sign us in${errs.length ? ` - ${errs.join(' | ').slice(0, 140)}` : ''}`);
  return false;
}

async function authenticate(page, cred, applyUrl, log, root, host) {
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

  const gate = page.getByRole('button', { name: /sign in with email|continue with email|use (your )?email/i }).first();
  if (!(await onSignIn()) && (await gate.count().catch(() => 0))) {
    log.push('wd: social-login gate, taking "Sign in with email"');
    await wdClick(gate);
    await page.waitForTimeout(3500);
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
    /* Five approaches before giving up on a tenant, because a blocked account
       retires every posting that tenant has. The store used to hand out a
       password that was never registered -- it was written at generation time,
       not after a confirmed creation -- so "wrong email address or password"
       here usually means the account does not exist at all.
       Nothing below is ever written to the log: see apply/redact.mjs. */
    const attempts = [];
    /* 1: the same credential again. Workday rejects a fill that raced its own
       page script, and the second attempt often simply works. */
    attempts.push({ kind: 'sign-in', email: cred.email, password: cred.password });
    /* 2: the password Brian uses on these sites, which he gave for exactly
       this case ("you can also try password ..."). */
    if (process.env.WD_ALT_PASSWORD) {
      attempts.push({ kind: 'sign-in', email: cred.email, password: process.env.WD_ALT_PASSWORD });
    }
    /* 3: create the account on this email with the stored password. */
    attempts.push({ kind: 'create', email: cred.email, password: cred.password });
    /* 4: create it with a brand-new password. */
    attempts.push({ kind: 'create', email: cred.email, password: newPassword() });
    /* 5: create it on the alternate address Brian authorised. */
    if (cred.email !== ALT_EMAIL) {
      attempts.push({ kind: 'create', email: ALT_EMAIL, password: newPassword() });
    }

    for (let n = 0; n < attempts.length; n++) {
      const a = attempts[n];
      const worked = await tryCredential(page, a, applyUrl, signedIn, onCreate, onSignIn, log, n + 1);
      if (worked === 'needs-verification') {
        /* Persist it: the account is real and this is its password, so once
           Brian clicks the link in his inbox every posting on this tenant runs
           unattended. Marked unverified because no sign-in has proven it yet. */
        if (root && host) { saveTenantCredential(root, host, a, false); markPendingVerification(root, host); }
        /* Stop here. Creating another account on the alternate address would
           leave two unverified accounts on the same tenant and nothing to
           show for it. */
        return 'needs-email-verification';
      }
      if (worked) {
        if (root && host) saveTenantCredential(root, host, a, true);
        log.push(`wd: recovered on approach ${n + 1} (${a.kind})`);
        if (!/\/apply\//.test(page.url())) {
          await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
          await page.waitForTimeout(6000);
        }
        return 'signed-in';
      }
    }
    /* If a stored credential exists but has never been verified, and creation
       could not sign us in either, the account almost certainly EXISTS and is
       waiting on an emailed verification -- that is exactly what this tenant
       said on the previous run. Reporting a generic auth failure sends Brian
       looking for a password problem that is not there. */
    /* The evidence arrives ONCE, on the run that created the account. Every
       later run gets a silent refusal with no error text, which is exactly what
       Capital One did on five postings. The sticky flag is what remembers. */
    if (cred && (cred.pendingVerification || cred.verified === false)) {
      log.push('wd: an unverified account already exists here; the emailed verification link is the blocker');
      return 'needs-email-verification';
    }
    log.push(`wd: all ${attempts.length} sign-in approaches failed for this tenant`);
    return 'blocked';
  }
  /* Signing in on the tenant's standalone /login page lands on the careers home,
     not back in the wizard. Go to the application URL explicitly. */
  if (!/\/apply\//.test(page.url())) {
    await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(6000);
  }
  /* Record that THIS password is now proven, so the store stops handing out
     unverified guesses. */
  if (root && host && !cred.verified) saveTenantCredential(root, host, cred, true);
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
  let picked = await wdPromptPick(
    page, 'source',
    [/job board/i, /job (site|search)/i, /online/i, /^other$/i, /social/i],
    [/third[- ]?part/i, /job board/i, /^linkedin$/i, /social media/i, /^indeed$/i,
     /job alert/i, /company (web ?site|career|marketing)/i, /^other$/i],
    log,
  );
  if (!picked) {
    /* Cisco does not use formField-source. The picker opened the wrong widget
       and reported "options offered: United States of America (+1)", which is
       the phone country code, so the answer never landed, the page would not
       advance, and Brian watched that prompt being clicked over and over.
       Find the field by its LABEL and drive that instead of trusting the id. */
    const byLabel = (await wdFieldGroups(page))
      .find(g => /how did you hear|where did you hear|source of (your )?application|referral source/i.test(g.text));
    if (byLabel) {
      log.push(`wd: "How Did You Hear About Us" is field ${byLabel.field}, not source`);
      picked = await wdPromptPick(
        page, byLabel.field,
        [/job board/i, /job (site|search)/i, /online/i, /^other$/i, /social/i, /career/i],
        /* Real wordings read off the tenants that stopped here. ServiceTitan
           offers "Company marketing / In person event / Job Alert / Social
           Media / Third-party job board" and matched none of the old leaves,
           so a required field was left empty and the posting stopped. Third-
           party job board is the accurate answer -- that is where these
           postings come from. */
        [/third[- ]?part/i, /job board/i, /^linkedin$/i, /social media/i, /^indeed$/i,
         /job alert/i, /company (web ?site|career|marketing)/i, /^other$/i, /^other job board/i],
        log,
      );
      if (!picked && byLabel.kind === 'select') {
        picked = await wdSelect(page, byLabel.field, /job board|online|other|linkedin|indeed|career/i, log);
      }
      /* Keyboard walk, aimed at any of the answers that are true. This is a
         required field on ServiceTitan and it stopped the posting after the
         auth wall had finally been cleared. Aimed, so it cannot leave a wrong
         value: wdSelectByKeyboard only keeps a readback that matches. */
      if (!picked) {
        picked = !!(await wdSelectByKeyboard(
          page, byLabel.field, /linkedin|job board|company (web ?site|career)|online|other|indeed/i, 25, log));
      }
      /* Last resort: type into it. These prompts are typeaheads, and typing the
         real answer then taking the suggestion is how a person answers one. */
      if (!picked) {
        const input = page.locator(`[data-automation-id="formField-${byLabel.field}"] input`).first();
        if (await input.count().catch(() => 0)) {
          await input.click({ timeout: 8000 }).catch(() => {});
          await input.fill('LinkedIn').catch(() => {});
          await page.waitForTimeout(1800);
          const opt = page.locator('[data-wd-opt], [role="option"], [data-automation-id="promptOption"]').first();
          if (await opt.count().catch(() => 0)) {
            await wdClick(opt);
            await page.waitForTimeout(1000);
            picked = /[1-9]\d* items? selected|linkedin/i.test(
              await page.locator(`[data-automation-id="formField-${byLabel.field}"]`).innerText().catch(() => ''));
            if (picked) log.push('wd: How Did You Hear About Us = LinkedIn (typed)');
          }
        }
      }
    }
  }
  if (!picked) log.push('wd: WARNING - "How Did You Hear About Us" left empty');
  await wdSelect(page, 'country', /United States of America/i, log);
  /* force: the resume autofill writes the uppercase header, BRIAN and FERENCE,
     and Cisco then raises "Verify that the field First Name is correctly
     capitalized because it contains more than 2 capital letters." It is an
     alert rather than an error, so the field is never named in the validator
     output and no recovery fires. Brian's fix is the right one and it is now
     unconditional: delete the value and retype it from the profile. */
  await wdFill(page, 'legalName--firstName', id.firstName, log, { force: true });
  await wdFill(page, 'legalName--lastName', id.lastName, log, { force: true });
  await wdFill(page, 'preferredName--firstName', id.firstName, log, { force: true });
  await wdFill(page, 'preferredName--lastName', id.lastName, log, { force: true });
  await wdFill(page, 'addressSection_addressLine1', id.street, log);
  await wdFill(page, 'addressLine1', id.street, log);
  await wdFill(page, 'addressSection_city', id.city, log);
  await wdFill(page, 'city', id.city, log);
  const stateRx = new RegExp(`^${id.state}$`, 'i');
  if (!(await wdSelect(page, 'addressSection_countryRegion', stateRx, log))
   && !(await wdSelect(page, 'countryRegion', stateRx, log))) {
    /* Aimed at ONE value, so this cannot leave a wrong state behind the way an
       unaimed walk left Adobe on Wyoming: wdSelectByKeyboard only accepts a
       readback that matches, and restores "Select One" when none does. 60 steps
       covers a US state list. */
    for (const f of ['countryRegion', 'addressSection_countryRegion']) {
      if (await wdSelectByKeyboard(page, f, stateRx, 60, log)) break;
    }
  }
  /* Country first. Adobe rejected "85331 is not a valid postal code for..." on
     two postings: the ZIP is validated against whatever country the form is
     currently set to, and it is not always the United States by default. */
  for (const f of ['country', 'addressSection_country', 'countryRegionCountry']) {
    if (await wdSelect(page, f, /^united states( of america)?$/i, log)) break;
  }
  await wdFill(page, 'addressSection_postalCode', id.postalCode, log);
  await wdFill(page, 'postalCode', id.postalCode, log);
  /* County is required on a few tenants (KeyBank stopped on it) and rendered
     either as a text box or a picker. Cave Creek, Arizona is in Maricopa
     County -- real, and the only value that belongs here. */
  if (id.county) {
    const rx = new RegExp(`^${id.county}`, 'i');
    let done = false;
    for (const f of ['county', 'addressSection_county', 'countyRegion',
                     'addressSection_countyRegion', 'addressSection_subregion', 'subregion']) {
      if (done) break;
      if (await wdFill(page, f, id.county, log)) { done = true; break; }
      if (await wdSelect(page, f, rx, log)) { done = true; break; }
      if (await wdSelectByKeyboard(page, f, rx, 20, log)) { done = true; break; }
    }
    /* None of those ids exist on KeyBank or Momentive, which both stopped on
       "The field County is required". Find it by its LABEL instead and read the
       real automation id off the page. */
    if (!done) {
      const realId = await page.evaluate(() => {
        for (const g of document.querySelectorAll('[data-automation-id^="formField-"]')) {
          const lab = (g.querySelector('label') || {}).innerText || '';
          if (/^\s*county\s*\*?\s*$/i.test(lab.replace(/\s+/g, ' '))) {
            return g.getAttribute('data-automation-id').replace('formField-', '');
          }
        }
        return null;
      }).catch(() => null);
      if (realId) {
        log.push(`wd: County is field "${realId}" on this tenant`);
        done = (await wdFill(page, realId, id.county, log))
          || (await wdSelect(page, realId, rx, log))
          || !!(await wdSelectByKeyboard(page, realId, rx, 40, log));
      }
    }
    if (!done) log.push(`wd: could not set County to ${id.county}`);
  }
  await wdSelect(page, 'phoneType', /^mobile$/i, log);
  /* The phone country code was never handled, which is the prompt Brian watched
     being clicked over and over: nothing ever chose a value, so it stayed on
     "Select One" and the page would not advance. It is a hierarchical prompt on
     some tenants and a plain select on others, so try both, and match on the
     country name or the +1 dial code. */
  const PHONE_CC = /^united states of america$|^united states$|^usa$|\+1\b/i;
  for (const f of ['countryPhoneCode', 'country_phone_code', 'phoneCountryCode']) {
    if (await wdSelect(page, f, PHONE_CC, log)) break;
    if (await wdPromptPick(page, f, [/^united states/i, /^north america/i], [PHONE_CC], log)) break;
  }
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
  [/(work(ed)?|employed|engaged).{0,90}(temporar|consultant|contingent|contractor|vendor|agency|intern\b|subsidiar|affiliate|in the past|previously|before)/i, /^no$/i],
  /* Widened for Cisco: "Do you have a family relationship (biological, adopted,
     marriage, domestic partnership, civil union, or some other arrangement)
     with ... an employee" puts 90-odd characters of parenthetical between the
     two halves, so the 80-character window could not reach "employee". */
  [/(relative|family (member|relationship)|related to|friend|close personal relationship).{0,200}(work|employ|associate)/i, /^no$/i],
  /* Cisco's full wording runs 250-odd characters of parenthetical before it
     ever reaches the word "employee", so no proximity window catches it. These
     phrases only ever introduce a conflict-of-interest question, and the answer
     is No however the sentence ends. */
  [/family relationship|close personal contact|close personal relationship|immediate family member/i, /^no$/i],
  [/referred by|employee referral/i, /^no$/i],
  /* Widened for the wording that stopped a posting tonight: "Have you entered
     into an agreement with your employer or a prior employer that impacts your
     ability to do business in an..." -- a non-compete question that never says
     non-compete. He is under no such agreement. */
  [/non-?compete|restrictive covenant|post-?employment restriction|entered into an agreement with (your|a) (current |prior |former )?employer/i, /^no$/i],
  [/(agree|consent|acknowledge).{0,90}(terms|privacy|policy|statement|notice)|have you read and/i, /^yes$/i],
  /* Adobe wording that matched none of the above and stopped the wizard on page
     4 of 7 with every earlier page filled. "legal age" carries no digits, so the
     age rule above could not see it. */
  /* Marketing opt-ins. He is job hunting, so being in a company's talent
     community is useful and the question is required to advance. */
  [/talent (community|network|pool)|receive (information|updates|communications) about (opportunities|jobs|roles)|join our talent|future opportunities at/i, /^yes$/i],
  /* The Standard's background-check acknowledgement, which is an attestation
     rather than a yes/no about his history. */
  [/i understand that employment (at|with) .{0,80}(is )?dependent on|dependent on successful completion of a background|contingent (up)?on (a )?(successful )?background/i, /^(yes|i (understand|agree|acknowledge))/i],
  /* The Standard's screening questions. Each answer is checked against the
     resume attached to the same application -- American Express and Equity
     Methods are financial services and The Institutes is insurance education,
     so the first is plainly Yes. */
  [/insurance or financial services industr|experience working in (the )?(insurance|financial services)/i, /^yes/i],
  [/vision for a data\s*(&|and)\s*ai platform|data\s*(&|and)\s*ai platform/i, /^yes/i],
  [/hands[- ]on engineering experience/i, /^yes/i],
  /* HPE's conflict-of-interest disclosure: it asks whether he HAS such a
     conflict, and he does not. */
  [/prohibits employees from engaging in activities that pose a conflict|conflict\(?s\)? of interest for/i, /^no/i],
  [/(signed or accepted|entered into) any agreement with a (current or )?(prior|former|current) employer/i, /^no$/i],
  /* Named-tool experience, LAST among the experience rules so the specific Yes
     answers above win first. Nothing on the resume claims Databricks, and this
     is the one place an application can be made false by guessing generously. */
  [/hands[- ]on experience with|experience with (databricks|snowflake|dbt|looker|sap|workday|servicenow)/i, /^no$/i],
  /* Momentive asks this for state pay-transparency reasons. He lives in
     Arizona. */
  [/resident of alaska or hawaii|do you (currently )?reside in (alaska|hawaii)/i, /^no$/i],
  /* He ran Scrum at SRP and has been a PM since; Jira and Confluence are the
     tooling of that job. */
  [/user stories in jira|jira and confluence|experience (with|using) (jira|confluence|azure devops)|agile ceremonies/i, /^yes/i],
  /* State residency questions, asked for pay-transparency reasons. Arizona. */
  [/resident of (california|colorado|new york|washington|illinois|alaska or hawaii)|are you a (california|colorado|new york|washington|illinois|alaska|hawaii) resident|do you (currently )?reside in/i, /^no$/i],
  /* The rest of HPE's conflict block, read off the rendered page. Every one of
     these is No: SRP ended in 2019 and Arizona Game and Fish in 2010, both
     outside a five-year window as of 2026, and neither was one of the listed
     officer/procurement roles. */
  [/employed or engaged within the past five years by any federal, state or local government|this policy does not apply to part-time student employees/i, /^no$/i],
  [/would be engaging in any of the above listed situations or activities/i, /^no$/i],
  [/served or are serving in a government or public body that has regulatory authority/i, /^no$/i],
  [/is a current .{0,20}employee; or .{0,30}is a government official with regulatory authority/i, /^no$/i],
  /* Notice period rendered as a PICK LIST rather than a text box. Two weeks,
     the same figure the availability date uses, so one application cannot
     contradict itself. */
  [/how much notice|notice period|notice would you (need|require) to give/i, /2 weeks|two weeks|14 days|2-4 weeks/i],
  /* Highest level of education. He holds an MBA and a BS in Information
     Technology, both from University of Phoenix. */
  [/highest level of education|education level (completed|attained)|highest degree/i, /master|mba|graduate degree|post-?graduate/i],
  /* ServiceTitan sells to home-services contractors and asks whether you have
     worked in those trades. He has not -- his background is fintech, cloud and
     insurance education. */
  [/experience in the trade|trades industr|home services industr|hvac|plumbing|electrical contracting/i, /^no$/i],
  /* ServiceTitan asks about its auditor. He has never worked there. */
  [/ever worked at pricewaterhouse|worked (at|for) (pwc|deloitte|kpmg|ernst)/i, /^no$/i],
  /* Relocation. Every posting in this queue is remote and he is not moving. */
  [/willing to relocate|able to relocate|would you relocate|open to relocation/i, /^no$/i],
  /* Residency / citizenship. He is a US citizen working in the US. */
  [/valid residency permit|residency permit in the country|are you a citizen of the (united states|us)|us citizen/i, /^yes/i],
  /* Travel. Normal for a product role and he has no constraint against it. */
  [/willing to travel|able to travel|travel requirement/i, /^yes/i],
  /* Pronouns is an EEO-style question with a decline option on every tenant
     that asks it; the profile's standing policy is to decline. */
  [/select your pronouns|what are your pronouns|preferred pronouns/i, /decline|prefer not|do not wish|not to (answer|disclose)|^other/i],
  /* Export-control citizenship lists. He is a US citizen and holds no other
     citizenship, so every one of these is No. Matched on the sanctioned-country
     roll call rather than on the word "citizen", which also appears in the
     work-authorisation question that takes the opposite answer. */
  [/citizen of (cuba|iran|north korea|syria)|cuba, iran|iran, north korea|sanctioned countr/i, /^no$/i],
  /* KeyBank's restriction question, which is another non-compete in different
     words. He is under no such restriction. */
  [/are you subject to any restriction|subject to any (non-?compete|agreement|covenant)|any restrictions? (that|which) (would|may) (affect|limit|prevent)/i, /^no$/i],
  /* KeyBank asks about candidacy for public office. He is not running. */
  [/currently running for (public )?office|candidate for (public )?office|hold (any )?public office/i, /^no$/i],
  /* KeyBank's public-office and discharge questions, verbatim from the form.
     He has never run for or held public office, and has never been discharged,
     asked to resign, or resigned to avoid termination. */
  [/running for or planning to run for public office|hold, or have you held.{0,40}public office/i, /^no$/i],
  [/discharged, asked to resign, or resigned to avoid termination|asked to resign|resigned to avoid/i, /^no$/i],
  /* KeyBank's regulatory-history question, verbatim. None of the three limbs
     applies to him: no investigation, no resignation under investigation, no
     disciplinary history in financial services. */
  [/are under investigation by your current employer|resigned your employment while under such investigation|alleged violation of .{0,40}(company policies|any laws)/i, /^no$/i],
  /* And the closing acknowledgement, which the application is refused without. */
  [/application acknowledgement|your application will not be accepted if you do not agree/i, /^(yes|i (agree|acknowledge|accept))/i],
  /* KeyBank's consent questions. Declining the AI-evaluation consent risks the
     application not being processed at all, and being considered for other
     roles is what he wants -- both are Yes. */
  [/may use artificial intelligence \(ai\) tools|ai tools provided by a trusted third-party vendor|assist in evaluating candidate qualifications/i, /^(yes|opt[- ]?in|i (consent|agree|acknowledge))/i],
  [/if you are not selected for this position|consider your application for (additional|other)/i, /^(yes|opt[- ]?in|i (agree|consent))/i],
  [/legal age to work|of legal age/i, /^yes$/i],
  [/willing to submit (to )?a? ?background (check|screening)|consent to a background/i, /^yes$/i],
  /* Every posting in this queue is US-remote and he will not relocate, so "can
     you work in the listed location" is yes for a remote role. The relocation
     half of the same sentence is answered No everywhere else in this file, and
     these tenants render it as one combined question -- answering the
     work-in-location half is the accurate reading for a remote posting. */
  [/able to work on a daily basis in the work location|work in the location listed|commute to (the|this) (office|location)/i, /^yes$/i],
  /* "Have you ever worked at Adobe in the following capacity:" is a pick-list of
     employment types, so the honest answer is the none-of-these option rather
     than a yes or a no. He has never worked at any of these employers. */
  [/worked (at|for) .{0,40} in the following capacity|in the following capacit/i, /^(none|none of the above|no|i have not|never)/i],
  /* Salesforce's government and export-control block, which stopped three of
     their postings. The five-year window matters: his resume shows Arizona Game
     and Fish Department to 2010 and SRP to 2019, both public bodies, so "in the
     last 5 years" is accurately No as of 2026. */
  /* The attestation MUST come first. "post-government employment restrictions"
     contains "government employment", so the No rule below matched it and
     answered No to a question that has to be Yes. First match wins in this
     table, and the test caught it before it went out. */
  /* Salesforce's closing attestation, which stopped "Technical Product Manager
     (Remote)" on page 4 with every other question answered. The existing
     acknowledge rule needs the words terms/privacy/policy/notice nearby and
     this one has none of them. */
  [/answered the above questions truthfully|truthfully and accurately|read, reviewed and answered/i, /^(yes|i acknowledge|i agree|i certify|i confirm)/i],
  /* "Regarding future positions at Salesforce, please select one of the
     following options". Being considered for other roles costs nothing and is
     what he wants, so take the affirmative option however it is worded. */
  [/regarding future positions|consider(ed)? (me )?for (other|future|additional)|future (job )?(positions|roles|opportunities)/i, /^(yes|i (would like|agree|consent)|please consider|consider me)/i],
  /* HPE asks this with NO time window, and the truthful answer is Yes: the
     attached resume shows Arizona Game and Fish Department (a state agency,
     2006-2010) and SRP (an Arizona political subdivision, 2010-2019). Brian's
     "say no to government employment" instruction was given about Cisco's
     question, which is scoped to the LAST FIVE YEARS -- both of those fall
     outside it, so No is accurate there and Yes is accurate here. Answering No
     to this one would contradict the resume attached to the same application.
     This rule must sit ABOVE the government No rules, which are all
     five-year-scoped. */
  [/i have (united states |u\.?s\.? )?government or public institution employment experience|public institution employment experience/i, /^yes/i],
  /* HPE's export-control citizenship list ("For any of the countries listed
     below ... Armenia, Azerbaijan, ..."). Anchored on the list preamble rather
     than on "permanent resident status", which also appears in ordinary
     work-authorisation questions that take the opposite answer. */
  [/for any of the countries listed below/i, /^no/i],
  [/post-?government employment restriction|i attest\/confirm|i attest/i, /^(yes|i attest|i confirm)/i],
  /* Cisco's wording, which none of the government rules above could see:
     "Are you currently or previously appointed as a U.S. Government Official,
     or employed by a U.S. Government or Foreign Government". */
  [/government official|employed by a u\.?s\.? government|foreign government|public official/i, /^no$/i],
  [/in the last 5 years, have you been an employee of a u\.?s\.? federal|government employment/i, /^no$/i],
  [/debarred|suspended, proposed for debarment|declared ineligible/i, /^no$/i],
  [/as a u\.?s\.? company that exports|export control|denied part(y|ies) list|sanction(ed|s) (list|party)/i, /^(no|none|i am not)/i],
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
    /* "Minimum Pay Desired" is a salary question that says neither "salary" nor
       "expectation", so it fell through to the yes/no table. It is a number. */
    /* A question is a salary question when it ASKS FOR AN AMOUNT, not merely
       because the word "compensation" appears in it. HPE's conflict-of-interest
       disclosure says "receiving compensation from a customer, business partner,
       supplier, or competitor" and was routed here, where the band chooser found
       "Yes / No" on offer and reported no usable option -- so a required yes/no
       question sat unanswered on four separate runs. */
    const asksAnAmount = /salary|compensation|base pay|pay/i.test(grp.text)
      && /expectation|expected|desired|requirement|minimum|range|how much|what is your|target/i.test(grp.text)
      && !/prohibit|conflict|policy|receiving compensation from|financial interest/i.test(grp.text);
    if (asksAnAmount) {
      if (await answerSalary(page, grp, profile, log)) continue;
      unanswered.push(grp.text.slice(0, 300));
      continue;
    }
    /* "When are you available to start?" is a DATE, not a select and not free
       text: the group reads "current value is MM/DD/YYYY MM / DD / YYYY".
       answerFreeText types a sentence into a segment box and achieves nothing. */
    /* A notice-period question mentions "start date" too, and this branch was
       swallowing it: "how much notice or transition time would you require
       before your start date?" is not a date field, and answerStartDate could
       only fail on it. */
    if (/available to start|start date|earliest (start|available)|when (can|could) you start|availability date/i.test(grp.text)
        && !/how much notice|notice period|transition time|notice would you/i.test(grp.text)) {
      if (await answerStartDate(page, grp, log)) continue;
      unanswered.push(grp.text.slice(0, 300));
      continue;
    }
    if (grp.kind === 'text' || grp.kind === 'textarea') {
      if (await answerFreeText(page, grp, answerBank, log)) continue;
      if (/\*/.test(grp.text)) unanswered.push(grp.text.slice(0, 300));
      continue;
    }
    /* Checkbox groups were skipped outright, so two required questions were
       never even attempted: Adobe's "Have you ever worked at Adobe in the
       following capacity:" and HPE's conflict-of-interest disclosure. Both
       matched a rule; neither was a select or a radio, so the loop walked past
       them and the page then refused to advance on a field nothing had touched. */
    if (grp.kind === 'checkbox') {
      const hitBox = WD_QUESTIONS.find(([q]) => q.test(grp.text));
      if (hitBox && await wdAnswerGroup(page, grp, hitBox[1], log)) continue;
      /* A "select all that apply" list where none applies: the honest answer is
         to tick the none-of-these option if there is one and otherwise leave it,
         which is what "have you ever worked here in the following capacity"
         wants from someone who never has. */
      if (await wdAnswerGroup(page, grp, /^(none|none of the above|not applicable|n\/a|i have not|never)/i, log)) continue;
      if (/\*/.test(grp.text)) unanswered.push(grp.text.slice(0, 300));
      continue;
    }
    /* A rule that matched deserves an attempt whatever the control is. HPE's
       conflict-of-interest disclosure matched its rule and was still reported
       unanswered, because the group came back as neither select nor radio nor
       checkbox and the loop walked straight past it. */
    if (!['select', 'radio'].includes(grp.kind)) {
      const hitAny = WD_QUESTIONS.find(([q]) => q.test(grp.text));
      if (hitAny) {
        if (await wdAnswerGroup(page, grp, hitAny[1], log)) continue;
        if (await wdSelect(page, grp.field, hitAny[1], log)) continue;
        if (await wdSelectByKeyboard(page, grp.field, hitAny[1], 14, log)) continue;
        if (/\*/.test(grp.text)) unanswered.push(grp.text.slice(0, 300));
      }
      continue;
    }
    /* An EEO question can turn up on an Application Questions page. Decline it
       here with the same rule the disclosures page uses rather than reporting
       it unanswered. */
    if (/ethnicity|race|gender|veteran status|are you hispanic|disability status/i.test(grp.text)) {
      const DECLINE = /decline to (self[- ]identify|answer|specify|state)|prefer not to (answer|say|disclose|state)|(do not|don't) (wish|want) to (answer|self[- ]identify|disclose)|i do not wish|choose not to (answer|disclose)|not disclosed?$/i;
      if (await wdAnswerGroup(page, grp, DECLINE, log)) continue;
      if (await wdSelect(page, grp.field, DECLINE, log)) continue;
      unanswered.push(grp.text.slice(0, 300));
      continue;
    }
    /* Years of relevant experience is a band list whose wording differs per
       tenant, so there is no fixed answer to match. Brian's rule is to take the
       band his experience actually falls in; with 20 years on the resume that
       is always the highest band offered. This stopped four Cisco postings. */
    if (/how many years|years of (relevant|related|professional|applicable)|experience do you have|years.{0,30}experience/i.test(grp.text)) {
      if (await answerYears(page, grp, log)) continue;
      unanswered.push(grp.text.slice(0, 300));
      continue;
    }
    const hit = WD_QUESTIONS.find(([q]) => q.test(grp.text));
    if (!hit) { unanswered.push(grp.text.slice(0, 300)); continue; }
    let ok = await wdAnswerGroup(page, grp, hit[1], log);
    /* The rule matched and the option still would not go in. That was the
       single biggest remaining cause: Salesforce's government question on three
       postings, Circle's family-in-government, The Standard's non-compete --
       every one had a correct answer that the picker refused. Walking the list
       by keyboard and deciding from the readback needs no visibility into it. */
    if (!ok && grp.kind === 'select') {
      ok = !!(await wdSelectByKeyboard(page, grp.field, hit[1], 14, log));
    }
    if (!ok) unanswered.push(grp.text.slice(0, 300));
  }
  return unanswered;
}

/**
 * Fill a "when are you available to start?" date.
 *
 * Two weeks out, which is the notice a working candidate actually gives.
 * Nothing here is invented about his history -- it is a forward-looking
 * availability date.
 *
 * The segments auto-advance after two digits, so each one is set with fill()
 * and never with type(). Typing 08 25 2026 into them once produced 2/2/2006.
 *
 * @param {import('playwright').Page} page
 * @param {{field:string,kind:string,text:string}} grp
 * @param {string[]} log
 * @returns {Promise<boolean>}
 */
async function answerStartDate(page, grp, log) {
  const box = page.locator(`[data-automation-id="formField-${grp.field}"]`).first();
  if (!(await box.count().catch(() => 0))) return false;
  const when = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const mm = String(when.getMonth() + 1).padStart(2, '0');
  const dd = String(when.getDate()).padStart(2, '0');
  const yyyy = String(when.getFullYear());

  const seg = async (auto, value) => {
    const el = box.locator(`[data-automation-id="${auto}"]`).first();
    if (!(await el.count().catch(() => 0))) return false;
    await el.fill(value).catch(() => {});
    await page.waitForTimeout(120);
    return true;
  };
  /* Type it first, letting auto-advance carry month -> day -> year. Setting the
     segments one at a time is what put the month into the year box on the work
     experience rows, and "When are you available to start?" came back
     unanswered on three postings. */
  const monthBox = box.locator('[data-automation-id="dateSectionMonth-input"]').first();
  let ok = false;
  if (await monthBox.count().catch(() => 0)) {
    await monthBox.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(150);
    /* Only type into a control the click actually focused: an unfocused click
       sends the keystrokes to whatever else has focus, which is how a Company
       box ended up holding a date. */
    const focused = await monthBox.evaluate(e => e === document.activeElement).catch(() => false);
    if (focused) {
      await page.keyboard.press('Control+a').catch(() => {});
      await page.keyboard.press('Delete').catch(() => {});
      await page.keyboard.type(mm + dd + yyyy, { delay: 45 }).catch(() => {});
    }
    await page.waitForTimeout(400);
    ok = Number(await monthBox.inputValue().catch(() => '')) === Number(mm);
  }
  if (!ok) ok = await seg('dateSectionMonth-input', mm);
  if (ok) {
    await seg('dateSectionDay-input', dd);
    await seg('dateSectionYear-input', yyyy);
  } else {
    /* Positional fallback for tenants that leave the segments unnamed. */
    const ins = box.locator('input');
    const n = await ins.count().catch(() => 0);
    if (n >= 3) {
      await ins.nth(0).fill(mm).catch(() => {});
      await ins.nth(1).fill(dd).catch(() => {});
      await ins.nth(2).fill(yyyy).catch(() => {});
      ok = true;
    } else if (n === 1) {
      await ins.first().fill(`${mm}/${dd}/${yyyy}`).catch(() => {});
      ok = true;
    }
  }
  if (!ok) return false;
  /* Read the month back. A date whose segments auto-advanced wrong reads as a
     plausible value and the form accepts it, so the readback is the only check. */
  const monthBack = await box.locator('[data-automation-id="dateSectionMonth-input"]').first().inputValue().catch(() => mm);
  if (monthBack && monthBack.replace(/^0/, '') !== mm.replace(/^0/, '')) {
    if (log) log.push(`wd: start date read back as month "${monthBack}", expected ${mm} - not accepted`);
    return false;
  }
  if (log) log.push(`wd: available to start = ${mm}/${dd}/${yyyy}`);
  return true;
}

/**
 * Answer a "how many years of experience" band list by taking the highest band
 * offered.
 *
 * Brian's resume runs from 2006, so every band list in this queue tops out
 * below his actual experience and the top band is the honest answer. Reading
 * the options and choosing is the only way: "4+ years", "10+", "More than 5
 * years" and "5-7 years" all appear across these tenants and no fixed pattern
 * matches them all.
 *
 * @param {import('playwright').Page} page
 * @param {{field:string,kind:string,text:string}} grp
 * @param {string[]} log
 * @returns {Promise<boolean>}
 */
async function answerYears(page, grp, log) {
  const box = page.locator(`[data-automation-id="formField-${grp.field}"]`).first();
  if (!(await box.count().catch(() => 0))) return false;

  /** Rank an option by the largest number in it; "+"/"more than" wins ties. */
  const rank = (t) => {
    const nums = (String(t).match(/\d+/g) || []).map(Number);
    if (!nums.length) return /more than|over|at least/i.test(t) ? 0.5 : -1;
    return Math.max(...nums) + (/\+|more than|over|or more/i.test(t) ? 0.5 : 0);
  };

  if (grp.kind === 'radio') {
    const opts = box.locator('input[type="radio"]');
    const n = await opts.count().catch(() => 0);
    let best = -1, bestIdx = -1;
    for (let k = 0; k < n; k++) {
      const id = await opts.nth(k).getAttribute('id').catch(() => null);
      /* Workday puts the option text in label[for=id], not in a wrapping label:
         closest('label') returns empty for every one of these. */
      const t = id ? await page.locator(`label[for="${id}"]`).first().innerText().catch(() => '') : '';
      const r = rank(t);
      if (r > best) { best = r; bestIdx = k; }
    }
    if (bestIdx < 0) return false;
    await opts.nth(bestIdx).check({ force: true }).catch(() => {});
    if (log) log.push(`wd: years of experience = highest band (option ${bestIdx + 1} of ${n})`);
    return true;
  }

  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
  const btn = box.locator('button').first();
  if (!(await wdClick(btn))) return false;
  await page.waitForTimeout(1200);
  const labels = await page.locator('[role="option"], [data-automation-id="promptOption"]').allInnerTexts()
    .then(a => a.map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean))
    .catch(() => []);
  const usable = labels.filter(t => t && !/^select one$/i.test(t));
  if (!usable.length) { await page.keyboard.press('Escape').catch(() => {}); return false; }
  const top = usable.reduce((a, b) => (rank(b) > rank(a) ? b : a));
  const opt = page.locator('[role="option"], [data-automation-id="promptOption"]')
    .filter({ hasText: top }).first();
  await opt.scrollIntoViewIfNeeded().catch(() => {});
  await wdClick(opt);
  await page.waitForTimeout(800);
  const after = (await btn.innerText().catch(() => '')).trim();
  const landed = !!after && !/^select one$/i.test(after);
  if (log) log.push(`wd: years of experience = "${landed ? after : top}"${landed ? '' : ' (FAILED to land)'} from ${usable.length} bands`);
  return landed;
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
    /* A question that asks for a MINIMUM gets the floor, not the target.
       Answering $200,000 to "Minimum Pay Desired" states something he has not
       said: his floor is $180,000 and that is the number that is true of a
       minimum. A numeric-looking box also gets digits, not "$200,000". */
    const wantsMinimum = /minimum|lowest|floor/i.test(grp.text);
    const amount = wantsMinimum ? floorUsd : targetUsd;
    const numericOnly = /pay|salary|compensation/i.test(grp.text)
      && !/expectation|describe|explain|comment/i.test(grp.text)
      && /desired|minimum|requirement|amount/i.test(grp.text);
    const value = numericOnly ? String(amount) : (wantsMinimum ? `$${amount.toLocaleString('en-US')}` : answerTemplate);
    const ok = await wdFill(page, grp.field, value, log);
    if (ok) log.push(`wd: ${wantsMinimum ? 'minimum pay' : 'salary expectation'} = ${value}`);
    return ok;
  }
  if (grp.kind !== 'select') return false;
  const res = await wdSelectChoose(page, grp.field, (labels) => {
    /** @type {{label:string,lo:number,hi:number}[]} */
    const bands = [];
    for (const label of labels) {
      const k = /\dk\b/i.test(label);
      const nums = (label.match(/\d[\d,]*/g) || [])
        .map(n => Number(n.replace(/,/g, '')))
        .map(v => (k && v < 1000 ? v * 1000 : v))
        .filter(v => v >= 1000);
      if (!nums.length) continue;
      /* "Under $50K" is an open BOTTOM and "$400K+" an open TOP. Treating both
         as [n, Infinity] made "Under $50K" look like it contained a $200K
         target, and it is the first option in the list. */
      if (nums.length === 1) {
        if (/under|less than|below|up to/i.test(label)) bands.push({ label, lo: 0, hi: nums[0] });
        else bands.push({ label, lo: nums[0], hi: Infinity });
      } else {
        bands.push({ label, lo: nums[0], hi: nums[nums.length - 1] });
      }
    }
    /* Highest band whose floor is at or below the target and whose ceiling
       clears the profile floor. Profile rule: aim for targetUsd, never below
       floorUsd, never the top of a posted range. */
    const best = bands
      .filter(b => b.lo <= targetUsd && b.hi >= floorUsd)
      .sort((a, b) => b.lo - a.lo)[0];
    return best ? best.label : null;
  }, log);
  return res.ok;
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
  /* A free-text question that tells you what to write when it does not apply.
     HPE's sponsorship box says "If this does not apply, indicate not applicable
     (N/A)" and was getting the word "No", which is not one of the answers it
     offered. He needs sponsorship nowhere. */
  if (/indicate all locations or countries|require sponsorship for employment/i.test(grp.text)
      && /not applicable|n\/a/i.test(grp.text)) {
    const ok = await wdFill(page, grp.field, 'N/A', log);
    if (ok) { log.push('wd: sponsorship locations = N/A'); return true; }
  }
  /* Notice period. Two weeks is the answer he would give and the same figure
     the availability date uses, so the two cannot contradict each other on one
     application. */
  if (/how much notice|notice period|notice would you (need|require)|how soon (could|can) you start/i.test(grp.text)) {
    const ok = await wdFill(page, grp.field, 'Two weeks', log);
    if (ok) { log.push('wd: notice period = Two weeks'); return true; }
  }
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
  /* "Decline to State" is NVIDIA's wording and it matched none of the original
     alternatives, so a field that DID offer a decline fell through to the
     answer-anyway fallback. It is the same intent, so match it first. */
  const DECLINE = /decline to (self[- ]identify|answer|specify|state)|prefer not to (answer|say|disclose|state)|(do not|don't) (wish|want) to (answer|self[- ]identify|disclose)|i do not wish|choose not to (answer|disclose)|not disclosed?$/i;
  for (const grp of await wdFieldGroups(page)) {
    /* The disability form's "Please check one of the boxes below" is a checkbox
       group, not a select or a radio group, so an earlier version left the one
       required field on the page untouched and the wizard refused to advance.
       Leaving an EEO field blank is the profile's documented fallback when no
       decline option exists, so a miss here is not an error. */
    let declined = grp.kind === 'select'
      ? await wdSelect(page, grp.field, DECLINE, log)
      : await wdAnswerGroup(page, grp, DECLINE, log);
    /* Last resort for a list whose options cannot be read at all. Cisco's
       ethnicity picker offered "(none)" while the two controls either side of
       it listed normally, so there was nothing to match and a required field
       stayed on "Select One". Walking it by keyboard needs no visibility. */
    /* ONLY on a field that is actually an EEO question. fillDisclosures walks
       every group on the page, and letting the keyboard walker loose on all of
       them set Adobe's STATE dropdown to Wyoming -- which then produced "85331
       is not a valid postal code for Wyoming". A matcher that changes nothing
       when it misses is safe to run everywhere; one that picks an option is
       not. */
    const isEEO = /ethnicity|race|gender|veteran|disab|hispanic|latino|self[- ]identif/i.test(grp.text);
    if (!declined && grp.kind === 'select' && isEEO) {
      declined = !!(await wdSelectByKeyboard(page, grp.field, DECLINE, 14, log));
    }
    if (declined) continue;

    /* Brian's instruction, 2026-08-24: decline where the form allows it, and
       where it does not, answer anyway so the application can go through.
       Workday makes gender and ethnicity REQUIRED with no decline option on
       several tenants, which stopped NVIDIA and Warner Bros at page 5 of 6.
       The order below is deterministic rather than random, so what went out is
       auditable: prefer anything that reads as not-disclosing, then anything
       that reads as unknown or other, and only then the last option offered. */
    /* Brian instruction, 2026-08-24: decline where the form allows it, and
       where it does not, answer anyway so the application can go through.
       Workday makes gender and ethnicity REQUIRED with no decline option on
       several tenants, which stopped NVIDIA and Warner Bros at page 5 of 6.

       wdSelectChoose opens the list ONCE and hands over what is on offer.
       Opening it repeatedly with different regexes left the widget
       unresponsive, so gender stayed empty while ethnicity went through even
       though both are the same kind of control. The order is deterministic
       rather than random so what went out is auditable, and the choice is
       logged with the full list of options that were offered. */
    /* An agreement checkbox is not an EEO question and has no decline option by
       design. NVIDIA words it "By selecting the checkbox, you agree to our Terms
       and Conditions and Applicant Privacy Policy" and makes it required, and it
       was the last thing standing between a fully filled form and a submit. */
    if (/you agree to|terms and conditions|privacy (policy|notice)|i (agree|acknowledge|consent)/i.test(grp.text)
      && (grp.kind === 'checkbox' || grp.kind === 'radio')) {
      const ticked = await wdAnswerGroup(page, grp, /.*/, log);
      log.push(ticked ? 'wd: agreed to the terms checkbox' : 'wd: FAILED to tick the terms checkbox');
      continue;
    }
    if (!/gender|ethnic|race|hispanic|latino|disab|veteran/i.test(grp.text)) continue;
    const res = await wdSelectChoose(page, grp.field, (labels) => {
      const find = (rx) => labels.find(l => rx.test(l));
      return find(/prefer not|not disclos|unknown|not specified|undisclosed|decline/i)
        || find(/^other$|two or more/i)
        || labels[labels.length - 1]
        || null;
    }, log);
    log.push(res.ok
      ? 'wd: EEO "' + grp.text.slice(0, 40) + '" had no decline option, chose "' + res.picked + '" per Brian instruction'
      : 'wd: EEO "' + grp.text.slice(0, 40) + '" could not be answered; offered: ' + res.labels.slice(0, 8).join(' / '));
  }
  const terms = page.locator('[data-automation-id="agreementCheckbox"], [data-automation-id*="termsAndConditions"] input[type=checkbox], input[type=checkbox][id*="gree"]').first();
  if (await terms.count().catch(() => 0)) { await terms.check({ force: true }).catch(() => {}); log.push('wd: ticked terms acknowledgement'); }

  /* NVIDIA words it "By selecting the checkbox, you agree to our Terms and
     Conditions and Applicant Privacy Policy" and gives it none of the automation
     ids above, so the required box stayed unticked and the page refused to
     advance. Find any remaining unticked checkbox whose own text is an agreement
     and tick it. */
  const agreed = await page.evaluate(() => {
    const rx = /you agree to|terms and conditions|privacy (policy|notice)|i (agree|acknowledge|consent)/i;
    let n = 0;
    for (const box of document.querySelectorAll('input[type=checkbox]')) {
      if (box.checked) continue;
      const scope = box.closest('[data-automation-id^="formField-"], fieldset, div');
      if (!scope || !rx.test(scope.innerText || '')) continue;
      box.setAttribute('data-wd-agree', '1');
      n++;
    }
    return n;
  }).catch(() => 0);
  for (let i = 0; i < agreed; i++) {
    const b = page.locator('[data-wd-agree="1"]').first();
    await b.check({ force: true }).catch(() => {});
    await b.evaluate(e => e.removeAttribute('data-wd-agree')).catch(() => {});
    log.push('wd: ticked an agreement checkbox');
  }
  // The disability form asks for name and today's date.
  await wdFill(page, 'name', profile.identity.fullName, log);
  const today = new Date();
  const mm = page.locator('[data-automation-id="dateSectionMonth-input"]').first();
  const dd = page.locator('[data-automation-id="dateSectionDay-input"]').first();
  const yy = page.locator('[data-automation-id="dateSectionYear-input"]').first();
  if (await mm.count().catch(() => 0)) {
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const d = String(today.getDate()).padStart(2, '0');
    const y = String(today.getFullYear());
    const reads = async () => [
      (await mm.inputValue().catch(() => '')).trim(),
      (await dd.inputValue().catch(() => '')).trim(),
      (await yy.inputValue().catch(() => '')).trim(),
    ];
    /* Only compare the segments this tenant actually renders. Some sign-off
       dates are MM/YYYY with no day box, and requiring a day there produced
       "reads 8//2026, wanted 08/25/2026" on a field that was in fact complete. */
    const hasDay = (await dd.count().catch(() => 0)) > 0;
    const right = async () => {
      const [a, b, c] = await reads();
      return Number(a) === Number(m)
        && (!hasDay || Number(b) === Number(d))
        && Number(c) === Number(y);
    };
    /* Type it, the way the work-experience dates had to be typed. Setting the
       segments one at a time put values in the wrong boxes there ("11/2025"
       came back "12/2011") and left two postings on "The field Date is
       required" here. Auto-advance carries month -> day -> year. */
    await mm.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(150);
    if (await mm.evaluate(e => e === document.activeElement).catch(() => false)) {
      await page.keyboard.press('Control+a').catch(() => {});
      await page.keyboard.press('Delete').catch(() => {});
      await page.keyboard.type(m + d + y, { delay: 45 }).catch(() => {});
    }
    await page.waitForTimeout(400);

    if (!(await right())) {
      await mm.fill(m).catch(() => {});
      await dd.fill(d).catch(() => {});
      await yy.fill(y).catch(() => {});
      await page.waitForTimeout(300);
    }
    /* Typing the run together gave "8//2026": month and year landed and the DAY
       was skipped, and fill() on the day box did not take either. Focus each
       segment and type into it. */
    if (!(await right())) {
      for (const [box, value] of [[mm, m], [dd, d], [yy, y]]) {
        if (!(await box.count().catch(() => 0))) continue;
        await box.click({ timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(120);
        if (!(await box.evaluate(e => e === document.activeElement).catch(() => false))) continue;
        await page.keyboard.press('Control+a').catch(() => {});
        await page.keyboard.press('Delete').catch(() => {});
        await page.keyboard.type(value, { delay: 70 }).catch(() => {});
        await page.waitForTimeout(200);
      }
      await page.waitForTimeout(300);
    }
    const [a, b, c] = await reads();
    log.push(await right()
      ? `wd: signed the self-identification date ${m}/${d}/${y}`
      : `wd: self-identification date would not take - reads ${a}/${b}/${c}, wanted ${m}/${d}/${y}`);
  }
}

/**
 * Fill Workday's My Experience rows from the resume-parsed history.
 *
 * Strict tenants (Autodesk, Adobe, Blackbaud) make Company, Job Title, From and
 * To required, and the Autofill-with-Resume parse leaves those boxes blank, so
 * the wizard stopped on "The field Company is required and must have a value."
 * Every value here comes from profile.experience.history, parsed out of the
 * exact PDF attached to the application. Nothing is invented: if the profile
 * carries no parsed history the page is left alone.
 *
 * @param {import('playwright').Page} page
 * @param {object} profile
 * @param {string[]} log
 * @returns {Promise<void>}
 */
async function fillWorkExperience(page, profile, log) {
  const history = profile.experience && profile.experience.history;
  if (!Array.isArray(history) || !history.length) {
    log.push('wd: no resume-parsed work history in the profile, leaving My Experience alone');
    return;
  }
  const MONTHS = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  };
  /** @param {string} v @returns {{month:string,year:string}|null} */
  const split = (v) => {
    const m = String(v || '').match(/([A-Za-z]{3})?\s*(\d{4})/);
    if (!m) return null;
    return { month: m[1] ? MONTHS[m[1].toLowerCase()] || '01' : '01', year: m[2] };
  };

  /* Address the CONTROLS directly rather than the workExperience-N wrapper.
     Adobe reported three "The field Company is required" errors while scoping
     by wrapper filled exactly one row: the wrapper count and the number of
     rendered rows do not agree across tenants. Counting the company inputs
     themselves is unambiguous. */
  /* Workday puts the automation id on a formField- WRAPPER, not on the input.
     Selecting [data-automation-id="companyName"] found nothing and reported
     "0 experience row(s)" while the debug dump listed five of them, because the
     dump reads formField-* wrappers. Match the wrapper, then type into the
     control inside it. */
  const companies = page.locator('[data-automation-id="formField-companyName"], [data-automation-id="formField-company"]');
  const count = await companies.count().catch(() => 0);
  const rows = Math.min(Math.max(count, 1), history.length);
  log.push('wd: ' + count + ' experience row(s) on the page, filling ' + rows);

  /* Learned once, reused for every row: see putDateAt. */
  let preferredDate;
  for (let i = 0; i < rows; i++) {
    const job = history[i];
    /** @param {string} auto @param {string} value */
    const put = async (auto, value) => {
      if (!value) return;
      /* Try the wrapper first, then the bare id: tenants differ over which one
         carries the automation id. */
      let all = page.locator('[data-automation-id="formField-' + auto + '"]');
      let n = await all.count().catch(() => 0);
      if (!n) {
        all = page.locator('[data-automation-id="' + auto + '"]');
        n = await all.count().catch(() => 0);
      }
      if (!n) return;
      const box = all.nth(Math.min(i, n - 1));
      const input = box.locator('input, textarea').first();
      const el = (await input.count().catch(() => 0)) ? input : box;
      await el.fill(String(value)).catch(() => {});
      await page.waitForTimeout(120);
    };
    await put('jobTitle', job.title);
    /* KeyBank makes Role Description required. Use what the resume actually
       says about the role -- never invented copy. */
    if (job.summary || job.description) await put('roleDescription', job.summary || job.description);
    /* KeyBank makes the per-row Location required. Where he did the work is a
       fact about him, not a guess about the employer: he has been in the
       Phoenix metro throughout, so his own city and state is the truthful
       answer and the only one available. */
    if (profile.identity && profile.identity.city && profile.identity.state) {
      await put('location', job.location || `${profile.identity.city}, ${profile.identity.state}`);
    }
    await put('companyName', job.company);
    await put('company', job.company);

    /**
     * Set one work-experience date. Autodesk stopped on "The field From is
     * required" with the row otherwise filled, because it does not carry the
     * bare startDate-dateSectionMonth-input id the other tenants use -- the
     * segment inputs live INSIDE a formField wrapper named for the label.
     * Four ways in, tried in order; every one is a different selector shape,
     * not the same one retried.
     * @param {string[]} wrappers candidate formField names for this date
     * @param {string} month two digits
     * @param {string} year four digits
     */
    const putDate = async (wrappers, month, year) => {
      if (!month || !year) return false;
      for (const w of wrappers) {
        /* 1: the wrapper, then the segment inputs by their own automation id. */
        const boxes = page.locator('[data-automation-id="formField-' + w + '"]');
        const n = await boxes.count().catch(() => 0);
        if (!n) continue;
        const box = boxes.nth(Math.min(i, n - 1));
        const mm = box.locator('[data-automation-id="dateSectionMonth-input"]').first();
        const yy = box.locator('[data-automation-id="dateSectionYear-input"]').first();
        if (await mm.count().catch(() => 0)) {
          /* fill(), never type(): the segments auto-advance after two digits,
             which is how a typed 08 25 2026 became 2/2/2006. */
          await mm.fill(month).catch(() => {});
          await yy.fill(year).catch(() => {});
          await page.waitForTimeout(150);
          if ((await mm.inputValue().catch(() => '')).trim()) return true;
        }
        /* 2: positional inputs inside the wrapper (month first, year last). */
        const ins = box.locator('input');
        const k = await ins.count().catch(() => 0);
        if (k >= 2) {
          await ins.first().fill(month).catch(() => {});
          await ins.nth(k - 1).fill(year).catch(() => {});
          await page.waitForTimeout(150);
          if ((await ins.first().inputValue().catch(() => '')).trim()) return true;
        }
      }
      /* 3: the flat ids the other tenants use. */
      const flat = wrappers[0];
      await put(flat + '-dateSectionMonth-input', month);
      await put(flat + '-dateSectionYear-input', year);
      /* 4: a spinbutton pair labelled Month / Year anywhere in this row. */
      const spin = page.locator('[role="spinbutton"]');
      if ((await spin.count().catch(() => 0)) >= 2) {
        await spin.first().fill(month).catch(() => {});
        await page.waitForTimeout(120);
      }
      return false;
    };

    const from = split(job.from);
    const to = /present|current/i.test(String(job.to || '')) ? null : split(job.to);

    /* Set "I currently work here" BEFORE the dates, and set it in BOTH
       directions. Autofill-with-Resume ticks it on rows it reads as current,
       and a ticked box REMOVES that row's To field -- rows 2 and 3 have real
       end dates and reported "(none)" because their To box was not on the page
       at all. Unticking restores it. Paired by document order for the same
       reason the dates are: the boxes do not line up with the row indices. */
    const currentIndex = await page.evaluate((idx) => {
      const q = '[data-automation-id="formField-companyName"], [data-automation-id="formField-company"]';
      const companies = [...document.querySelectorAll(q)];
      const here = companies[idx];
      if (!here) return -1;
      const next = companies[idx + 1];
      const boxes = [...document.querySelectorAll('[data-automation-id="currentlyWorkHere"], input[type="checkbox"]')];
      for (let t = 0; t < boxes.length; t++) {
        const el = boxes[t];
        const after = !!(here.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
        const before = !next || !!(next.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING);
        if (after && before) return t;
      }
      return -1;
    }, i).catch(() => -1);

    let current = null;
    if (currentIndex >= 0) {
      current = page.locator('[data-automation-id="currentlyWorkHere"], input[type="checkbox"]').nth(currentIndex);
      const want = !to;
      const is = await current.isChecked().catch(() => false);
      if (is !== want) {
        await (want ? current.check({ force: true }) : current.uncheck({ force: true })).catch(() => {});
        await page.waitForTimeout(600);
      }
      let now = await current.isChecked().catch(() => false);
      /* check()/uncheck() are element-level and the aria-hidden click_filter
         overlay swallows them, which is the same thing that made Sign In look
         like it worked and do nothing. Row 2 refused to untick this way while
         its box sat there unchanged. Fall back to the coordinate-click ladder,
         aiming at the label when there is one -- the input itself is often
         zero-sized. */
      for (let tries = 0; tries < 2 && now !== want; tries++) {
        const id = await current.getAttribute('id').catch(() => null);
        const label = id ? page.locator(`label[for="${id}"]`).first() : null;
        if (label && (await label.count().catch(() => 0))) await wdClick(label);
        else await wdClick(current);
        await page.waitForTimeout(700);
        now = await current.isChecked().catch(() => false);
      }
      if (now !== want) {
        log.push(`wd: row ${i + 1} "I currently work here" would not go to ${want ? 'ticked' : 'unticked'}`);
      } else if (want) {
        log.push(`wd: row ${i + 1} marked as current`);
      }
    }

    if (from) {
      const k = await putDateAt(page, i, ['startDate', 'from'], from.month, from.year, log, preferredDate);
      if (k === false) await putDate(['startDate', 'from', 'startDate--dateSection'], from.month, from.year);
      else preferredDate = k;
    }
    if (to) {
      const k = await putDateAt(page, i, ['endDate', 'to'], to.month, to.year, log, preferredDate);
      if (k === false) await putDate(['endDate', 'to', 'endDate--dateSection'], to.month, to.year);
      else preferredDate = k;
    }
    log.push('wd: experience ' + (i + 1) + ' = ' + job.title + ' at ' + job.company);
  }

  /* READ THE DATES BACK. Five postings stopped on "Must end after start date"
     with every row apparently filled: the segments auto-advance after two
     digits, so a value that did not land leaves the end date at something
     earlier than the start and the form reports a date order problem rather
     than an empty field. The log said "experience N = title at company" either
     way, which is why it took five failures to notice. */
  const readBack = async (auto, k) => {
    /* Paired by document order, exactly as putDateAt fills them. Reading by a
       shared index reported row 3's end date as row 2's. */
    const at = await page.evaluate(([idx, name]) => {
      const q = '[data-automation-id="formField-companyName"], [data-automation-id="formField-company"]';
      const companies = [...document.querySelectorAll(q)];
      const here = companies[idx];
      if (!here) return -1;
      const next = companies[idx + 1];
      const targets = [...document.querySelectorAll(`[data-automation-id="formField-${name}"]`)];
      for (let t = 0; t < targets.length; t++) {
        const el = targets[t];
        const after = !!(here.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
        const before = !next || !!(next.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING);
        if (after && before) return t;
      }
      return -1;
    }, [k, auto]).catch(() => -1);
    if (at < 0) return null;
    const box = page.locator('[data-automation-id="formField-' + auto + '"]').nth(at);
    const mm = await box.locator('[data-automation-id="dateSectionMonth-input"]').first().inputValue().catch(() => '');
    const yy = await box.locator('[data-automation-id="dateSectionYear-input"]').first().inputValue().catch(() => '');
    if (!mm && !yy) return null;
    return { mm, yy, num: (Number(yy) || 0) * 100 + (Number(mm) || 0) };
  };

  for (let i = 0; i < rows; i++) {
    const job = history[i];
    const from = split(job.from);
    const to = /present|current/i.test(String(job.to || '')) ? null : split(job.to);
    const gotFrom = await readBack('startDate', i);
    const gotTo = await readBack('endDate', i);
    const wantFrom = from ? Number(from.year) * 100 + Number(from.month) : null;
    const wantTo = to ? Number(to.year) * 100 + Number(to.month) : null;

    if (from && gotFrom && gotFrom.num !== wantFrom) {
      log.push(`wd: row ${i + 1} start read back as ${gotFrom.mm}/${gotFrom.yy}, wanted ${from.month}/${from.year} - refilling`);
      const k = await putDateAt(page, i, ['startDate', 'from'], from.month, from.year, log, preferredDate);
      if (k !== false) preferredDate = k;
    }
    if (to && gotTo && gotTo.num !== wantTo) {
      log.push(`wd: row ${i + 1} end read back as ${gotTo.mm}/${gotTo.yy}, wanted ${to.month}/${to.year} - refilling`);
      const k = await putDateAt(page, i, ['endDate', 'to'], to.month, to.year, log, preferredDate);
      if (k !== false) preferredDate = k;
    }
    /* The specific failure the tenants complain about, checked directly. */
    const f2 = await readBack('startDate', i);
    const t2 = await readBack('endDate', i);
    /* One line per row, always. Without it a bad date is invisible until the
       tenant reports "Enter a date between 1900 and 2100" and there is no way
       to tell WHICH row carries it. */
    log.push(`wd: row ${i + 1} dates = ${f2 ? f2.mm + '/' + f2.yy : '(none)'} -> ${t2 ? t2.mm + '/' + t2.yy : '(none/present)'}`);
    void 0;
    if (f2 && from && (Number(f2.yy) < 1900 || Number(f2.yy) > 2100)) {
      log.push(`wd: row ${i + 1} start year ${f2.yy} is out of range - redriving`);
      await putDateAt(page, i, ['startDate', 'from'], from.month, from.year, log);
    }
    if (t2 && to && (Number(t2.yy) < 1900 || Number(t2.yy) > 2100)) {
      log.push(`wd: row ${i + 1} end year ${t2.yy} is out of range - redriving`);
      await putDateAt(page, i, ['endDate', 'to'], to.month, to.year, log);
    }
    if (f2 && t2 && t2.num <= f2.num) {
      log.push(`wd: row ${i + 1} still ends on or before it starts (${f2.mm}/${f2.yy} -> ${t2.mm}/${t2.yy})`);
    }
  }

  /* Company and Job Title must still hold what we wrote. A date typed into a
     control that was not focused lands in the nearest text box instead: row 1's
     Company came back holding "112025". Nothing downstream checks these, so a
     corrupted company name would go out on a real application. */
  for (let i = 0; i < rows; i++) {
    const job = history[i];
    for (const [auto, want] of [['companyName', job.company], ['company', job.company], ['jobTitle', job.title]]) {
      if (!want) continue;
      const all = page.locator('[data-automation-id="formField-' + auto + '"]');
      const n = await all.count().catch(() => 0);
      if (!n || i >= n) continue;
      const input = all.nth(i).locator('input, textarea').first();
      if (!(await input.count().catch(() => 0))) continue;
      const got = (await input.inputValue().catch(() => '')).trim();
      if (got === String(want).trim()) continue;
      log.push(`wd: row ${i + 1} ${auto} read back as "${got}", rewriting "${want}"`);
      await input.fill(String(want)).catch(() => {});
      await page.waitForTimeout(150);
    }
  }

  /* Dump EVERY date box on the page, including any the row pass never reached.
     "Error-From Enter a date between 1900 and 2100" named no row, and the
     per-row report showed seven perfectly good From values -- so the offending
     box belongs to a row the pass does not know about. */
  const every = await page.evaluate(() => {
    const out = [];
    for (const name of ['startDate', 'endDate', 'from', 'to']) {
      const boxes = [...document.querySelectorAll(`[data-automation-id="formField-${name}"]`)];
      boxes.forEach((b, k) => {
        const m = b.querySelector('[data-automation-id="dateSectionMonth-input"]');
        const y = b.querySelector('[data-automation-id="dateSectionYear-input"]');
        const mv = m ? m.value : '';
        const yv = y ? y.value : '';
        if (mv || yv) out.push(`${name}[${k}]=${mv}/${yv}`);
      });
    }
    return out;
  }).catch(() => []);
  if (every.length) log.push(`wd: every date box on the page: ${every.join(' ')}`);
}

/**
 * Set one date wrapper on a given row. Shared by the fill pass and the repair
 * pass so both drive the field the same way.
 * @param {import('playwright').Page} page
 * @param {number} i row index
 * @param {string[]} wrappers candidate formField names
 * @param {string} month two digits
 * @param {string} year four digits
 * @returns {Promise<boolean>}
 */
async function putDateAt(page, i, wrappers, month, year, log, prefer) {
  /* Scope to THIS ROW, not to a page-wide nth(). Ticking "I currently work
     here" HIDES that row's To field, so a seven-row form renders only six
     endDate wrappers and every index after the ticked row is off by one: row
     2's end date went into row 3's box, rows 5 and 6 lost theirs entirely, and
     a stray value drew "Enter a date between 1900 and 2100". The row container
     is the nearest ancestor that holds this row's Company field. */
  /* Pair each row with its OWN date box by document order rather than by a
     shared index. Ticking "I currently work here" HIDES that row's To field, so
     a seven-row form renders only six endDate wrappers and every index after
     the ticked row is off by one: row 2's end date went into row 3's box, rows
     5 and 6 lost theirs entirely, and a stray value drew "Enter a date between
     1900 and 2100". A row's date box is the one that sits after this row's
     Company field and before the next row's. */
  const indexFor = (wname) => page.evaluate(([idx, name]) => {
    const q = '[data-automation-id="formField-companyName"], [data-automation-id="formField-company"]';
    const companies = [...document.querySelectorAll(q)];
    const here = companies[idx];
    if (!here) return -1;
    const next = companies[idx + 1];
    const targets = [...document.querySelectorAll(`[data-automation-id="formField-${name}"]`)];
    for (let t = 0; t < targets.length; t++) {
      const el = targets[t];
      const after = !!(here.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
      const before = !next || !!(next.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING);
      if (after && before) return t;
    }
    return -1;
  }, [i, wname]).catch(() => -1);

  for (const w of wrappers) {
    const all = page.locator('[data-automation-id="formField-' + w + '"]');
    const n = await all.count().catch(() => 0);
    if (!n) continue;
    const k = await indexFor(w);
    /* -1 means this row genuinely has no such box -- a ticked "currently work
       here" removes the To field. Reaching for another row's box is how the
       wrong row got the value in the first place. */
    if (k < 0) continue;
    const box = all.nth(k);
    const mm = box.locator('[data-automation-id="dateSectionMonth-input"]').first();
    const yy = box.locator('[data-automation-id="dateSectionYear-input"]').first();
    if (!(await mm.count().catch(() => 0))) continue;

    /** Read the pair back. The only thing that decides whether a fill worked. */
    const read = async () => ({
      m: (await mm.inputValue().catch(() => '')).trim(),
      y: (await yy.inputValue().catch(() => '')).trim(),
    });
    const right = (v) => Number(v.m) === Number(month) && Number(v.y) === Number(year);

    /* The four techniques. Which one a tenant accepts is a property of the
       TENANT, not of the row, so the caller learns the winner on the first
       date and passes it back as `prefer` for the rest. Running all four on
       every row cost about two minutes per posting and blew the per-posting
       timeout outright -- the Splunk posting crashed on it. */
    /** Type into `el` ONLY if the click actually focused it. */
    const typeInto = async (el, text) => {
      await el.click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(150);
      const focused = await el.evaluate(e => e === document.activeElement).catch(() => false);
      /* Refusing to type is the whole point. When the click was swallowed by
         the click_filter overlay the keystrokes went to whatever DID have
         focus: row 1's Company box ended up holding "112025" and row 7's From
         read 01/8232. A date that fails to land is recoverable; a company name
         overwritten with a date is not, because nothing downstream checks it. */
      if (!focused) return false;
      await page.keyboard.press('Control+a').catch(() => {});
      await page.keyboard.press('Delete').catch(() => {});
      await page.keyboard.type(text, { delay: 45 }).catch(() => {});
      return true;
    };

    const techniques = [
      /* 1: fill() each segment. It targets the element directly, so a missed
         click cannot spray characters into a neighbouring field. Month first. */
      async () => {
        await mm.fill('').catch(() => {});
        await yy.fill('').catch(() => {});
        await mm.fill(String(month)).catch(() => {});
        await page.waitForTimeout(120);
        await yy.fill(String(year)).catch(() => {});
      },
      /* 2: the same, year first, for tenants that validate the pair the instant
         the month lands and reject it against an empty year. */
      async () => {
        await yy.fill('').catch(() => {});
        await mm.fill('').catch(() => {});
        await yy.fill(String(year)).catch(() => {});
        await page.waitForTimeout(120);
        await mm.fill(String(month)).catch(() => {});
      },
      /* 3: type the whole date into the month segment and let the widget's own
         auto-advance carry it into the year, which is what a person does. */
      async () => { await typeInto(mm, String(month) + String(year)); },
      /* 4: type each segment, in case they are ordered year-then-month here. */
      async () => {
        await typeInto(yy, String(year));
        await typeInto(mm, String(month));
      },
    ];

    /* Try the known-good one first, then the rest. */
    const order = Number.isInteger(prefer)
      ? [prefer, ...techniques.map((_, k) => k).filter(k => k !== prefer)]
      : techniques.map((_, k) => k);

    let v = { m: '', y: '' };
    for (const k of order) {
      await techniques[k]();
      await page.waitForTimeout(300);
      v = await read();
      if (right(v)) return k;
    }
    if (log) log.push(`wd: date ${w}[${i}] would not take ${month}/${year} - best was ${v.m}/${v.y}`);
  }
  return false;
}

/**
 * Deal with the Education panel on My Experience.
 *
 * This is what stopped Cisco's "Product Manager" one screen short: the panel
 * renders empty and its School or University field is REQUIRED, so Save and
 * Continue refuses forever while the log shows every work-experience row filled.
 *
 * Five approaches, in order, because there is nobody to ask overnight:
 *   1. the school typeahead - type the real school and take an exact match
 *   2. the same typeahead with a shorter query, for tenants that only match a prefix
 *   3. a plain text school input, which some tenants use instead of a lookup
 *   4. keyboard - ArrowDown + Enter on whatever the lookup did offer
 *   5. delete the row, which is what Brian said to do when the lookup is broken
 *      ("the education is on the resume so okay to leave off"). Cisco's school
 *      search answers "No Items." for every query, so 1-4 cannot ever succeed there.
 *
 * @param {import('playwright').Page} page
 * @param {object} profile
 * @param {string[]} log
 * @returns {Promise<void>}
 */
async function fillEducation(page, profile, log) {
  const schools = (profile.experience && profile.experience.education) || [];
  for (let guard = 0; guard < 6; guard++) {
    const panel = page.locator('[data-automation-id="formField-school"], [data-automation-id="formField-schoolName"]').first();
    if (!(await panel.count().catch(() => 0))) {
      if (guard === 0) log.push('wd: no education panel on this page');
      return;
    }
    const want = schools[guard] ? schools[guard].school : (schools[0] && schools[0].school);
    let filled = false;

    if (want) {
      const input = panel.locator('input').first();
      if (await input.count().catch(() => 0)) {
        /* Approaches 1, 2 and 4 all run through the same lookup, differing in
           the query and in how the result is taken. */
        for (const query of [want, want.split(/\s+/).slice(-1)[0], want.split(/\s+/)[0]]) {
          if (filled || !query) continue;
          await input.click({ timeout: 8000 }).catch(() => {});
          await input.fill('').catch(() => {});
          await input.type(query, { delay: 60 }).catch(() => {});
          await page.waitForTimeout(2000);
          const noItems = await page.locator('text=/no items/i').count().catch(() => 0);
          if (noItems) continue;
          const opt = page.locator('[role="option"], [data-automation-id="promptOption"]')
            .filter({ hasText: want }).first();
          if (await opt.count().catch(() => 0)) {
            await opt.scrollIntoViewIfNeeded().catch(() => {});
            await wdClick(opt);
          } else {
            /* Approach 4: take whatever it offered by keyboard. */
            await page.keyboard.press('ArrowDown').catch(() => {});
            await page.keyboard.press('Enter').catch(() => {});
          }
          await page.waitForTimeout(1200);
          const shown = (await panel.innerText().catch(() => '')).replace(/\s+/g, ' ');
          if (shown.toLowerCase().includes(want.toLowerCase().slice(0, 10))) {
            filled = true;
            log.push(`wd: education school = ${want}`);
          }
        }
      }
      /* Approach 3: a free-text school field under a different id. */
      if (!filled) {
        const plain = page.locator('[data-automation-id="formField-schoolName"] input').first();
        if (await plain.count().catch(() => 0)) {
          await plain.fill(want).catch(() => {});
          await page.waitForTimeout(400);
          filled = !!(await plain.inputValue().catch(() => ''));
          if (filled) log.push(`wd: education school (text field) = ${want}`);
        }
      }
    }

    if (filled) return;

    /* Approach 5: delete the row. Find the Delete that belongs to the education
       panel, not to a work-experience row, by walking up from the school field. */
    const marked = await page.evaluate(() => {
      const school = document.querySelector('[data-automation-id="formField-school"], [data-automation-id="formField-schoolName"]');
      if (!school) return false;
      let p = school;
      for (let i = 0; i < 8 && p; i++) {
        const del = [...p.querySelectorAll('button')].find(b => /^delete$/i.test((b.innerText || '').trim()));
        if (del) { del.setAttribute('data-wd-del', '1'); return true; }
        p = p.parentElement;
      }
      return false;
    }).catch(() => false);
    if (!marked) {
      log.push('wd: education row could not be filled and has no Delete button');
      return;
    }
    const del = page.locator('[data-wd-del="1"]').first();
    await wdClick(del);
    await page.waitForTimeout(2200);
    const left = await page.locator('[data-automation-id="formField-school"], [data-automation-id="formField-schoolName"]').count().catch(() => 0);
    log.push(`wd: deleted an education row (lookup unusable), ${left} left`);
    if (!left) return;
  }
}

/**
 * Clear and retype every field a validation error names.
 *
 * Brian's observation, and it holds generally: Workday will insist a field is
 * required while showing the value that is in it. Its validator watches for
 * events a programmatic fill does not always raise, so deleting the value and
 * typing it again clears the complaint. Salesforce does this with "How Did You
 * Hear About Us?" and several tenants do it with first and last name.
 *
 * @param {import('playwright').Page} page
 * @param {string[]} errs error strings from wdErrors
 * @param {object} profile
 * @param {object} answerBank
 * @param {string[]} log
 * @returns {Promise<number>} how many fields were re-driven
 */
async function retypeNamedFields(page, errs, profile, answerBank, log) {
  const id = profile.identity;
  const blob = errs.join(' ').toLowerCase();
  let fixed = 0;

  /** @param {string} auto @param {string} value */
  const redo = async (auto, value) => {
    if (!value) return;
    const box = page.locator(A(auto)).first();
    if (!(await box.count().catch(() => 0))) return;
    const input = box.locator('input, textarea').first();
    const el = (await input.count().catch(() => 0)) ? input : box;
    await el.click().catch(() => {});
    await el.fill('').catch(() => {});
    await page.waitForTimeout(150);
    await el.type(String(value), { delay: 45 }).catch(() => {});
    await page.waitForTimeout(200);
    fixed++;
    log.push(`wd: retyped ${auto}`);
  };

  if (/first name|legal name/.test(blob)) await redo('legalName--firstName', id.firstName);
  if (/last name|legal name/.test(blob)) await redo('legalName--lastName', id.lastName);
  if (/address/.test(blob)) await redo('addressSection_addressLine1', id.street);
  if (/postal|zip/.test(blob)) await redo('addressSection_postalCode', id.postalCode);
  if (/phone/.test(blob)) await redo('phone-number', id.phone);
  if (/email/.test(blob)) await redo('email', id.email);

  /* "How Did You Hear About Us?" is a hierarchical prompt, not a text box, so
     retyping cannot help: it has to be re-driven through the picker. */
  if (/how did you hear/.test(blob)) {
    const picked = await wdPromptPick(
      page, 'source',
      [/job board/i, /job (site|search)/i, /online/i, /^other$/i, /social/i, /referral/i, /career/i],
      [/^other$/i, /^other job board/i, /^linkedin$/i, /^indeed$/i, /company (web ?site|career)/i, /^job board/i],
      log,
    );
    if (picked) { fixed++; log.push('wd: re-drove How Did You Hear About Us'); }
  }
  return fixed;
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

  /* If openApplyManually already reported the wizard, this tenant recognised
     the session and there is no sign-in form to reach. Running authenticate
     anyway reported wd-auth-blocked on Adobe while the candidate was in fact
     signed in and standing on step 1 of 7. */
  /* Trust the cookie only if the page still shows a signed-in account menu.
     Adobe ended two runs on a signed-out job-search page carrying a
     create-account form: the wizard was reachable from a stale session that
     dropped partway through, and the submit went nowhere. */
  let alreadyIn = log.some(l => l === 'wd: already signed in, landed on the wizard');
  if (alreadyIn) {
    const reallyIn = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-automation-id="utilityMenuButton"]'))
        .some(e => (e.innerText || '').includes('@'))).catch(() => false);
    if (!reallyIn) {
      log.push('wd: the wizard was reachable but no account menu is present - signing in properly');
      alreadyIn = false;
    }
  }
  const auth = alreadyIn ? 'signed-in' : await authenticate(page, cred, applyUrl, log, root, host);
  markCredentialVerified(root, host, auth === 'signed-in');
  if (auth === 'needs-email-verification') {
    await shot('wd-2-needs-verification');
    return {
      state: 'wd-email-verification',
      detail: `A candidate account now exists on ${host} and the tenant emailed a verification link to ${cred.email}. Click it once and every posting on this tenant runs unattended.`,
    };
  }
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
    if (/my experience|work experience/i.test(name)) {
      await fillWorkExperience(page, profile, log);
      /* Education lives on the same screen and its School field is required
         even when the panel renders empty. This is what left Cisco's Product
         Manager stuck on page 3 with every work row filled. */
      await fillEducation(page, profile, log);
    }
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
    /* Also run it when the page merely CONTAINS EEO fields. Four postings
       stopped on "The field Please select your ethnicity. is required" because
       the page was called something else and fillDisclosures never ran on it. */
    const eeoOnPage = /ethnicity|race|gender|veteran|disability|self[- ]identif/i
      .test(await page.locator('body').innerText().catch(() => ''));
    if (/voluntary disclosure|self identify|self-identif|disability/i.test(name) || eeoOnPage) {
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
      /* Read the WHOLE page, not the first 1500 characters. Autodesk's
         "Application Submitted" modal is rendered after the Candidate Home
         content, so a 1500-character prefix captured "You have no tasks. My
         Applications ... Active (1)" and nothing else -- the run was recorded
         as submitted-unconfirmed while the screenshot showed the confirmation
         modal and a My Applications row reading Under Review, August 25, 2026.
         Truncating the evidence is not the same as not having it. */
      const after = await page.locator('body').innerText().catch(() => '');
      const CONFIRMED = /you have (already )?(applied|submitted)|thank you for (applying|submitting your application)|application (was |has been )?(submitted|received)|we('| ha)ve received your application/i;
      /* A My Applications table listing this application with a submitted date
         is confirmation in its own right, and it survives the modal closing. */
      const listed = /my applications/i.test(after) && /active \(\s*[1-9]/i.test(after);
      /* "Under review" ONLY inside a My Applications table. On its own it is
         not evidence -- it appears in job listings and marketing copy, and a
         bare match would have recorded an application that never went in. */
      const reviewing = /my applications/i.test(after) && /under review/i.test(after);
      /* A page offering Sign In or Create Account is a SIGNED-OUT page, and a
         signed-out page cannot be a confirmation whatever else it says. Adobe
         ended two runs on a job-search page with a create-account form and a
         "Congratulations!" marketing modal over it. */
      const signedOut = /create account/i.test(after)
        && /verify new password|password requirements/i.test(after);
      const confirmed = !signedOut && (CONFIRMED.test(after) || listed || reviewing);
      if (signedOut) log.push('wd: the page after submit is SIGNED OUT - not a confirmation');
      const evidence = (after.match(CONFIRMED) || [''])[0] || (listed ? 'listed under My Applications' : '');
      log.push(`wd: submit ${confirmed ? `confirmed by "${evidence}"` : 'NOT confirmed on the page'}`);
      return { state: confirmed ? 'submitted' : 'submitted-unconfirmed', detail: after.replace(/\s+/g, ' ').slice(0, 300) };
    }

    /* "Save and Continue" does not always take on the first click - the button
       is an aria-hidden <button> under a click_filter overlay, and a click that
       lands while Workday is still re-rendering the page is dropped silently.
       A fully valid page with no error banner that simply did not move is that,
       not a blocker, so retry before giving up. */
    const before = page.url() + '|' + info.step;
    let errs = [];
    let nowInfo = info;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await wdClick(page.locator(A('pageFooterNextButton')));
      await page.waitForTimeout(6000);
      errs = await wdErrors(page);
      nowInfo = await wdPageInfo(page);
      if (page.url() + '|' + nowInfo.step !== before) break;
      if (errs.length) break;
      log.push(`wd: Save and Continue did not take on attempt ${attempt}, retrying`);
      await page.waitForTimeout(2500);
    }
    if (nowInfo.step === info.step && errs.length) {
      /* Brian's fix, and it generalises: when Workday complains about a field
         that visibly HAS a value, clearing it and retyping makes the complaint
         go away. Workday's own validator misses a programmatic fill that did not
         fire the events it watches for. Re-drive every field the errors name,
         then try Next once more before giving up. */
      /* An error naming the school field is never a retype problem: the panel
         is empty and its lookup is broken. Run the education ladder, which
         ends by deleting the row. */
      if (errs.some(e => /school|university|education|degree/i.test(e))) {
        await fillEducation(page, profile, log);
        await wdClick(page.locator(A('pageFooterNextButton')));
        await page.waitForTimeout(6000);
        errs = await wdErrors(page);
        nowInfo = await wdPageInfo(page);
        if (nowInfo.step !== info.step || !errs.length) continue;
      }
      const retyped = await retypeNamedFields(page, errs, profile, answerBank, log);
      if (retyped) {
        await wdClick(page.locator(A('pageFooterNextButton')));
        await page.waitForTimeout(6000);
        errs = await wdErrors(page);
        nowInfo = await wdPageInfo(page);
        if (nowInfo.step !== info.step || !errs.length) {
          log.push(`wd: cleared ${retyped} field(s) by retyping and moved on`);
          continue;
        }
      }
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
