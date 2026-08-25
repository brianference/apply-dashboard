/**
 * Workday (myworkdayjobs.com) application flow.
 *
 * Workday differs from Greenhouse/Ashby/Lever in three ways the generic runner
 * cannot handle:
 *   1. The posting page carries no form at all. "Apply" opens a modal, and the
 *      form only exists after a candidate account is created or signed in.
 *   2. Every real <button> is aria-hidden and covered by a
 *      div[data-automation-id="click_filter"] overlay, so a plain .click() is
 *      intercepted forever and times out.
 *   3. The application is a multi-page wizard (4 to 7 pages depending on the
 *      tenant), not a single form.
 *
 * Credentials are generated per tenant and stored in
 * apply/workday-accounts.local.json, which is gitignored. Passwords are never
 * logged.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const A = id => `[data-automation-id="${id}"]`;

/* Every shape Workday renders an option in. The narrow
   '[role="option"], promptOption' pair read Cisco's ethnicity list as EMPTY
   while gender and veteran status, the controls either side of it on the same
   page, listed fine -- and an empty list is indistinguishable from a field
   that offers nothing, so the posting stopped on a required field whose answer
   was on screen. */
const OPTION_SEL = [
  '[role="option"]',
  '[data-automation-id="promptOption"]',
  '[data-automation-label]',
  '[role="listbox"] li',
  '[data-automation-widget="wd-popup"] li',
  'ul[role="listbox"] > *',
].map(sel => sel + ':visible').join(', ');
const DEBUG = process.env.WD_DEBUG === '1';

/**
 * Path of the gitignored per-tenant credential store.
 * @param {string} root repo root
 * @returns {string}
 */
export function accountStorePath(root) {
  return path.join(root, 'apply', 'workday-accounts.local.json');
}

/**
 * Return the stored credentials for a Workday tenant, generating and persisting
 * a new password the first time. The password is never written to a log.
 * @param {string} root repo root
 * @param {string} host tenant host, e.g. nvidia.wd5.myworkdayjobs.com
 * @param {string} email candidate email
 * @returns {{email:string,password:string,created:string,fresh:boolean}}
 */
export function tenantCredentials(root, host, email) {
  const file = accountStorePath(root);
  const store = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  if (!store[host]) {
    const lower = 'abcdefghijkmnpqrstuvwxyz';
    const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const digits = '23456789';
    const specials = '!@#$%^&*';
    const pick = s => s[crypto.randomInt(s.length)];
    const chars = [pick(upper), pick(lower), pick(digits), pick(specials)];
    while (chars.length < 20) chars.push(pick(lower + upper + digits + specials));
    for (let i = chars.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      const t = chars[i]; chars[i] = chars[j]; chars[j] = t;
    }
    /* verified:false until a sign-in actually succeeds with it. The store used
       to record the generated password as though creation had worked, so seven
       postings across four tenants reused a password that was never registered
       and every one reported "wrong email address or password". A credential is
       a CLAIM until a sign-in confirms it. */
    store[host] = { email, password: chars.join(''), created: new Date().toISOString(), verified: false };
    fs.writeFileSync(file, JSON.stringify(store, null, 2));
    return Object.assign({}, store[host], { fresh: true });
  }
  return Object.assign({}, store[host], { fresh: false });
}

/**
 * Generate a password that satisfies Workday's rules. Never logged, never
 * printed: see apply/redact.mjs.
 * @returns {string}
 */
export function newPassword() {
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const specials = '!@#$%^&*';
  const pick = s => s[crypto.randomInt(s.length)];
  const chars = [pick(upper), pick(lower), pick(digits), pick(specials)];
  while (chars.length < 20) chars.push(pick(lower + upper + digits + specials));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    const t = chars[i]; chars[i] = chars[j]; chars[j] = t;
  }
  return chars.join('');
}

/**
 * Persist a tenant credential, recording whether it has been PROVEN to work.
 * @param {string} root repo root
 * @param {string} host tenant hostname
 * @param {{email:string,password:string}} cred
 * @param {boolean} verified whether a sign-in succeeded with it
 * @returns {void}
 */
export function saveTenantCredential(root, host, cred, verified) {
  const file = accountStorePath(root);
  const store = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  store[host] = {
    email: cred.email,
    password: cred.password,
    created: (store[host] && store[host].created) || new Date().toISOString(),
    verified: !!verified,
    verifiedAt: verified ? new Date().toISOString() : undefined,
  };
  fs.writeFileSync(file, JSON.stringify(store, null, 2));
}

/**
 * Click a Workday control. The real <button> is aria-hidden and sits under a
 * div[data-automation-id="click_filter"] overlay that swallows pointer events,
 * so clicking the button directly never lands and times out after 30s.
 * @param {import('playwright').Locator} loc
 * @returns {Promise<boolean>} whether a click was dispatched
 */
export async function wdClick(loc) {
  if (!(await loc.count().catch(() => 0))) return false;
  const el = loc.first();

  /* Approach 1: click the coordinates. Proven on Cisco while walking the form
     by hand - the aria-hidden click_filter overlay swallows an element click,
     and Sign In looked like it worked while doing nothing. Hitting the centre
     of the button's own box goes through the overlay rather than round it. */
  await el.scrollIntoViewIfNeeded().catch(() => {});
  const box = await el.boundingBox().catch(() => null);
  if (box && box.width > 0 && box.height > 0) {
    const page = el.page();
    const ok = await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      .then(() => true).catch(() => false);
    if (ok) return true;
  }

  /* Approach 2: the overlay itself, where one is rendered as a sibling. */
  const overlay = el.locator('xpath=..').locator(A('click_filter')).first();
  if (await overlay.count().catch(() => 0)) {
    const ok = await overlay.click({ timeout: 15000 }).then(() => true).catch(() => false);
    if (ok) return true;
  }

  /* Approach 3: the element, then forced. */
  if (await el.click({ timeout: 10000 }).then(() => true).catch(() => false)) return true;
  return await el.click({ force: true, timeout: 8000 }).then(() => true).catch(() => false);
}

/**
 * The form-field group wrapper Workday puts around every labelled control.
 * @param {import('playwright').Page} page
 * @param {string} field formField-<name> suffix
 * @returns {import('playwright').Locator}
 */
const group = (page, field) => page.locator(A(`formField-${field}`)).first();

/**
 * Fill a plain text input inside a Workday form field group, leaving any value
 * already there alone.
 * @param {import('playwright').Page} page
 * @param {string} field
 * @param {string} value
 * @param {string[]} [log]
 * @returns {Promise<boolean>}
 */
export async function wdFill(page, field, value, log, { force = false } = {}) {
  if (!value) return false;
  const el = group(page, field).locator('input[type=text], input:not([type]), textarea').first();
  if (!(await el.count().catch(() => 0))) return false;
  if (!(await el.isVisible().catch(() => false))) return false;
  const cur = await el.inputValue().catch(() => '');
  /* force overwrites what Workday's resume autofill already put there. Brian's
     resume header is uppercase, so the parse fills BRIAN and FERENCE and Cisco
     raises "Verify that the field First Name is correctly capitalized because
     it contains more than 2 capital letters." That is an ALERT, not an error,
     so the name never appears in the validator output and the retype recovery
     never fires. The profile spelling has to win outright.

     Clear, then TYPE rather than fill: Workday watches for the events a
     programmatic fill does not always raise, which is why deleting and
     retyping by hand clears the alert. */
  if (String(cur).trim()) {
    if (!force || String(cur).trim() === String(value).trim()) return true;
    await el.click().catch(() => {});
    await el.fill('').catch(() => {});
    await page.waitForTimeout(150);
    const typed = await el.type(String(value), { delay: 45 }).then(() => true).catch(() => false);
    await el.blur().catch(() => {});
    if (typed && log) log.push(`wd: retyped ${field} over "${String(cur).slice(0, 20)}"`);
    return typed;
  }
  const ok = await el.fill(String(value)).then(() => true).catch(() => false);
  if (ok && log) log.push(`wd: filled ${field}`);
  return ok;
}

/**
 * Choose an option from a Workday single-select dropdown.
 * @param {import('playwright').Page} page
 * @param {string} field formField-<name> suffix
 * @param {RegExp|string} want option text to select (string = substring match)
 * @param {string[]} [log]
 * @returns {Promise<boolean>}
 */
export async function wdSelect(page, field, want, log) {
  /* Dismiss anything already open. A leftover popup is why the source picker
     reported 'options offered: United States of America (+1)' - it read the
     phone country code list that was still on screen - and why State and Phone
     Device Type silently failed on Cisco. */
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
  const g = group(page, field);
  if (!(await g.count().catch(() => 0))) return false;
  const btn = g.locator('button[aria-haspopup="listbox"], button').first();
  if (!(await btn.count().catch(() => 0))) return false;
  const current = (await btn.innerText().catch(() => '')).trim();
  if (current && !/^select one$/i.test(current)) return true;
  if (!(await wdClick(btn))) return false;
  await page.waitForTimeout(900);

  /* Read ONLY the popup that is open and on top. A page-wide read returned the
     still-open source and phone-code lists and reported Adobe's State options
     as "LinkedIn / United States of America (+1)" while Arizona sat on screen. */
  let labels = await readOpenOptions(page, await btn.elementHandle().catch(() => null));
  for (let attempt = 2; attempt <= 3 && !labels.length; attempt++) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400 * attempt);
    if (!(await wdClick(btn))) break;
    await page.waitForTimeout(900 * attempt);
    labels = await readOpenOptions(page, await btn.elementHandle().catch(() => null));
  }

  const label = want instanceof RegExp ? want.source : String(want);
  const test = want instanceof RegExp ? (t) => want.test(t) : (t) => t === String(want);
  let k = labels.findIndex(test);
  /* Second attempt at matching: drop the END anchor. Salesforce answers a
     yes/no question with "No, I have not", so an anchored /^no$/ finds nothing
     while the right option is sitting there. Only relax the TAIL -- keeping ^
     means "No" can never match "Do you know...". */
  if (k < 0 && want instanceof RegExp && /\$$/.test(want.source)) {
    const relaxed = new RegExp(want.source.replace(/\$$/, '\b'), want.flags);
    k = labels.findIndex(t => relaxed.test(t));
  }
  if (k < 0) {
    /* An UNREADABLE list and a list with no matching entry are different
       problems and the message above cannot tell them apart. When nothing at
       all came back, dump the trigger's own markup once so the next run has
       something to work from instead of another guess. */
    if (!labels.length && log) {
      const shape = await btn.evaluate((b) => {
        const id = b.getAttribute('aria-controls') || b.getAttribute('aria-owns');
        const pop = id ? document.getElementById(id) : null;
        return {
          btn: b.outerHTML.slice(0, 200),
          controls: id || '(none)',
          popFound: !!pop,
          popKids: pop ? [...pop.children].slice(0, 3).map(c => c.outerHTML.slice(0, 120)) : [],
        };
      }).catch(() => null);
      if (shape) log.push(`wd: ${field} list unreadable - trigger ${shape.btn} | aria-controls=${shape.controls} found=${shape.popFound} | ${shape.popKids.join(' ')}`.slice(0, 700));
    }
    await page.keyboard.press('Escape').catch(() => {});
    if (log) log.push(`wd: no option matching ${label} in ${field}; offered: ${labels.slice(0, 20).join(' / ').slice(0, 240) || '(none)'}`);
    return false;
  }

  const opt = page.locator(`[data-wd-opt="${k}"]`).first();
  await opt.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(200);
  const ok = await wdClick(opt);
  await page.waitForTimeout(700);
  /* Trust the READBACK, not the click. A click that lands mid-re-render is
     dropped silently and still returns true. */
  const after = (await btn.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  const landed = ok && !!after && !/^select one$/i.test(after);
  if (log) log.push(`wd: ${landed ? `${field} = "${after}"` : `FAILED to select ${label} in ${field} (offered: ${labels.slice(0, 12).join(' / ').slice(0, 160)})`}`);
  return landed;
}

/**
 * Pick a value in a Workday multi-select prompt (e.g. "How Did You Hear About
 * Us?"). These are hierarchical: clicking the box lists CATEGORIES
 * ("Applied", "Job Boards", "Referred", "Sourced") and the real values only
 * appear after drilling into one. Typing into the box does not reach the
 * leaves, which is why an earlier version reported success while leaving the
 * required field empty and the page refused to advance.
 * @param {import('playwright').Page} page
 * @param {string} field formField-<name> suffix
 * @param {RegExp} category top-level category to open
 * @param {RegExp[]} leaves leaf options to try, in order of preference
 * @param {string[]} [log]
 * @returns {Promise<boolean>}
 */
export async function wdPromptPick(page, field, categories, leaves, log) {
  const g = group(page, field);
  if (!(await g.count().catch(() => 0))) return false;
  const selected = async () => /[1-9]\d* items? selected/i.test(await g.innerText().catch(() => ''));
  if (await selected()) return true;
  const input = g.locator('input').first();
  if (!(await input.count().catch(() => 0))) return false;

  const opts = () => page.locator(A('promptOption'));
  const listOptions = async () => await opts().allInnerTexts()
    .then(a => a.map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean))
    .catch(() => []);

  const tryLeaves = async () => {
    for (const leaf of leaves) {
      const o = opts().filter({ hasText: leaf }).first();
      if (!(await o.count().catch(() => 0))) continue;
      if (!(await o.click({ timeout: 8000 }).then(() => true).catch(() => false))) continue;
      await page.waitForTimeout(1200);
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(600);
      if (await selected()) {
        if (log) log.push(`wd: ${field} = ${leaf.source}`);
        return true;
      }
      await input.click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1200);
    }
    return false;
  };

  /* Escape first, every time. Without it the reader picks up whatever popup is
     still on screen: the source picker on Cisco reported "options offered:
     United States of America (+1)" because it was reading the phone
     country-code list left open by the field above it. */
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);
  await input.click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const top = await listOptions();

  /* Some tenants list the values flat; most nest them one level under a
     category. Try flat first, then each candidate category. */
  if (await tryLeaves()) return true;
  for (const cat of categories) {
    const c = opts().filter({ hasText: cat }).first();
    if (!(await c.count().catch(() => 0))) continue;
    await c.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1800);
    if (await tryLeaves()) return true;
    /* Back out to the category list before trying the next one. */
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(600);
    await input.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
  /* Last resort: take whatever the prompt offers. "How Did You Hear About Us?"
     is required on Circle and Salesforce and their category names matched none
     of the patterns, so four postings stopped on a field whose answer does not
     matter to the application. Walk the first category and take its first leaf;
     if the list is flat, take the first entry. Logged either way. */
  await input.click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1500);
  for (let depth = 0; depth < 2; depth++) {
    const first = opts().first();
    if (!(await first.count().catch(() => 0))) break;
    const label = (await first.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    await first.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
    if (await selected()) {
      if (log) log.push(`wd: ${field} = "${label}" (took the first option offered)`);
      return true;
    }
    await input.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }

  await page.keyboard.press('Escape').catch(() => {});
  if (log) log.push(`wd: could not pick ${field}; options offered: ${top.slice(0, 20).join(' / ')}`);
  return false;
}

/**
 * Read the visible validation errors on the current wizard page.
 * @param {import('playwright').Page} page
 * @returns {Promise<string[]>}
 */
export async function wdErrors(page) {
  return await page.evaluate(() => {
    const out = new Set();
    /* Workday's field-level errors carry no role=alert and no "errorMessage"
       automation id, so an earlier version reported zero errors on a page that
       was visibly refusing to advance. Match the rendered error text too. */
    /* role=alert is also how Workday announces SUCCESS. The resume upload toast
       reads "BrianFerence_Resume_August.pdf successfully uploaded", and taking
       it as an error stopped NVIDIA as wd-validation-blocked on a page that had
       filled correctly and had nothing wrong with it. A success notice is not a
       validation failure. */
    const SUCCESS_NOTICE = /successfully|uploaded|saved|complete|no error/i;
    const REAL_ERROR = /error|required|must have a value|please (select|enter|correct|fix)|invalid|not valid/i;
    document.querySelectorAll('[data-automation-id*="rror"], [role="alert"]').forEach(e => {
      const t = (e.innerText || '').trim();
      if (!t || t.length >= 300) return;
      if (SUCCESS_NOTICE.test(t) && !REAL_ERROR.test(t)) return;
      out.add(t.replace(/\s+/g, ' '));
    });
    (document.body.innerText || '').split(String.fromCharCode(10)).forEach(line => {
      const t = line.trim();
      if (/^error\b/i.test(t) || /is required and must have a value|please (select|enter)/i.test(t)) {
        if (t.length < 300) out.add(t.replace(/\s+/g, ' '));
      }
    });
    return Array.from(out).slice(0, 15);
  }).catch(() => []);
}

/**
 * Describe the current wizard page, for logging and for deciding what to fill.
 * @param {import('playwright').Page} page
 * @returns {Promise<{url:string,step:string,stepName:string,heading:string,fields:string[],buttons:string[],text:string}>}
 */
export async function wdPageInfo(page) {
  return await page.evaluate(() => {
    const fields = [];
    document.querySelectorAll('[data-automation-id^="formField-"]').forEach(g => {
      const name = g.getAttribute('data-automation-id').replace('formField-', '');
      const lbl = ((g.querySelector('label') || {}).innerText || '').replace(/\s+/g, ' ').trim();
      const kinds = Array.from(g.querySelectorAll('input:not([type=hidden]),textarea,select,button')).map(e => {
        const t = e.tagName.toLowerCase();
        if (t === 'button') return e.getAttribute('aria-haspopup') === 'listbox' ? 'SELECT' : 'BTN';
        if (e.type === 'radio' || e.type === 'checkbox') return `${e.type.toUpperCase()}:${(e.getAttribute('aria-label') || e.value || '').slice(0, 30)}`;
        if (e.type === 'password') return 'PASSWORD';
        if (e.type === 'file') return 'FILE';
        if (t === 'textarea') return 'TEXTAREA';
        return 'TEXT';
      });
      fields.push(`${name} | "${lbl.slice(0, 70)}" | ${Array.from(new Set(kinds)).join(',')}`);
    });
    /* The progress bar lists EVERY step name on every page, so scanning the
       page text for "Review" matched on page 1 of 4. Read the current step from
       the "current step N of M" label and take the name that follows it. */
    const labels = Array.from(document.querySelectorAll('label')).map(e => (e.innerText || '').trim());
    const stepIdx = labels.findIndex(t => /^current step \d+ of \d+$/i.test(t));
    const stepEl = stepIdx >= 0 ? labels[stepIdx] : '';
    const stepName = stepIdx >= 0 ? (labels[stepIdx + 1] || '') : '';
    const h = Array.from(document.querySelectorAll('h1,h2,h3')).map(e => (e.innerText || '').trim()).filter(Boolean);
    return {
      url: location.href,
      step: stepEl,
      stepName,
      heading: h.join(' | ').slice(0, 200),
      fields: fields.slice(0, 90),
      buttons: Array.from(document.querySelectorAll('button')).map(b => `${(b.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 30)}[${b.getAttribute('data-automation-id') || ''}]`).filter(b => b.length > 2).slice(0, 50),
      text: (document.body.innerText || '').replace(/\n{2,}/g, '\n').slice(0, 3500),
    };
  }).catch(() => ({ url: page.url(), step: '', stepName: '', heading: '', fields: [], buttons: [], text: '' }));
}

/**
 * Emit a full page dump when WD_DEBUG=1. No-op otherwise.
 * @param {import('playwright').Page} page
 * @param {string} label
 * @returns {Promise<void>}
 */
export async function wdDebug(page, label) {
  if (!DEBUG) return;
  const i = await wdPageInfo(page);
  console.log(`\n########## [${label}] ${i.step} ${i.url}\nFIELDS:\n${i.fields.join('\n')}\nBTNS: ${JSON.stringify(i.buttons)}\nTEXT:\n${i.text}\n`);
}

/**
 * List every form-field group on the page with its visible label text, so a
 * question can be matched by wording. Workday gives tenant-specific questions
 * opaque GUID automation ids, so matching by id is impossible.
 * @param {import('playwright').Page} page
 * @returns {Promise<{field:string,text:string,kind:string}[]>}
 */
export async function wdFieldGroups(page) {
  return await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('[data-automation-id^="formField-"]').forEach(g => {
      const field = g.getAttribute('data-automation-id').replace('formField-', '');
      const text = (g.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      let kind = 'text';
      if (g.querySelector('button[aria-haspopup="listbox"]')) kind = 'select';
      else if (g.querySelector('input[type=radio]')) kind = 'radio';
      else if (g.querySelector('input[type=checkbox]')) kind = 'checkbox';
      else if (g.querySelector('textarea')) kind = 'textarea';
      else if (g.querySelector('[data-automation-id="multiSelectContainer"]')) kind = 'multiselect';
      out.push({ field, text, kind });
    });
    return out;
  }).catch(() => []);
}

/**
 * Answer one question identified by its label wording rather than its id.
 * @param {import('playwright').Page} page
 * @param {{field:string,kind:string}} grp
 * @param {RegExp} want desired option / radio label
 * @param {string[]} [log]
 * @returns {Promise<boolean>}
 */
export async function wdAnswerGroup(page, grp, want, log) {
  const g = group(page, grp.field);
  if (grp.kind === 'select') return await wdSelect(page, grp.field, want, log);
  if (grp.kind === 'radio' || grp.kind === 'checkbox') {
    /* Workday's EEO "check one of the boxes below" groups are checkboxes that
       behave like radios, so the same label-matching walk has to cover both. */
    const r = g.locator('input[type=radio], input[type=checkbox]');
    const n = await r.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const lbl = await r.nth(i).evaluate(el => {
        const own = el.getAttribute('aria-label') || '';
        const byId = el.id ? (document.querySelector(`label[for="${el.id}"]`) || {}).innerText : '';
        return (own || byId || el.value || '').trim();
      }).catch(() => '');
      if (want.test(lbl)) {
        await r.nth(i).check({ force: true }).catch(() => {});
        if (log) log.push(`wd: ${grp.field} radio = ${lbl.slice(0, 30)}`);
        return true;
      }
    }
    return false;
  }
  return false;
}

/**
 * Record whether a stored tenant password has actually been proven to sign in.
 * A fresh "Create Account" that silently bounces to the sign-in page leaves an
 * unproven password behind, and the next run would reuse it forever.
 * @param {string} root repo root
 * @param {string} host tenant host
 * @param {boolean} verified
 * @returns {void}
 */
export function markCredentialVerified(root, host, verified) {
  const file = accountStorePath(root);
  if (!fs.existsSync(file)) return;
  const store = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!store[host]) return;
  /* One schema. This used to write `unverified` while saveTenantCredential
     wrote `verified`, so neither could see the other: Capital One's entry read
     "verified=(unset)" on the run after the tenant had plainly said "An email
     has been sent to you. Please verify your account.", and five postings were
     reported as a password problem that did not exist. */
  store[host].verified = !!verified;
  if (verified) {
    store[host].verifiedAt = new Date().toISOString();
    delete store[host].unverified;
    delete store[host].pendingVerification;   /* signing in proves it is done */
  } else {
    store[host].unverified = true;
  }
  fs.writeFileSync(file, JSON.stringify(store, null, 2));
}

/**
 * Record that this tenant created the account and is waiting on an emailed
 * verification link. Sticky: only a successful sign-in clears it, because the
 * evidence arrives ONCE -- on the run that created the account -- and every
 * later run just sees a silent refusal with no error text at all.
 * @param {string} root
 * @param {string} host
 * @returns {void}
 */
export function markPendingVerification(root, host) {
  const file = accountStorePath(root);
  if (!fs.existsSync(file)) return;
  const store = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!store[host]) return;
  store[host].pendingVerification = new Date().toISOString();
  store[host].verified = false;
  fs.writeFileSync(file, JSON.stringify(store, null, 2));
}

/**
 * Read the option labels a Workday single-select offers, then close it again.
 * Used where the right answer depends on what is on offer (salary bands).
 * @param {import('playwright').Page} page
 * @param {string} field
 * @returns {Promise<string[]>}
 */
/**
 * Choose from a Workday dropdown using only the KEYBOARD, for lists whose
 * options cannot be read at all.
 *
 * Cisco's ethnicity picker reported "offered: (none)" on the same page where
 * gender and veteran status listed normally, so there was nothing to match
 * against and a required field stayed on "Select One". This walks the list one
 * entry at a time and decides from the READBACK -- the value the trigger shows
 * afterwards -- which needs no visibility into the popup at all.
 *
 * @param {import('playwright').Page} page
 * @param {string} field formField-<name> suffix
 * @param {RegExp} want the answer to accept
 * @param {number} [max] how many entries to walk
 * @param {string[]} [log]
 * @returns {Promise<string|null>} the value that landed, or null
 */
/**
 * Read the options of the popup that is actually OPEN AND ON TOP, and tag them
 * so one can be clicked by index.
 *
 * Reading options page-wide is why Adobe's State dropdown reported
 * "LinkedIn / LinkedIn / United States of America (+1)" -- the popups from the
 * source picker and the phone country code above it were still open and still
 * visible, so a page-wide query returned their entries and Arizona, which was
 * on screen, matched nothing. Filtering by :visible does not help when the
 * stale popups are themselves visible; only taking the LAST one does.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<string[]>} the labels, in order, each tagged data-wd-opt=<index>
 */
export async function readOpenOptions(page, btnHandle) {
  /* First choice: follow the trigger's OWN aria-controls / aria-owns to its
     listbox. That is the spec-correct link between a button and its popup and
     it needs no guessing at all. The topmost-visible-box heuristic below is a
     fallback: it read Adobe's lists as "(none)" because their popup is not one
     of the shapes it looks for. */
  if (btnHandle) {
    const viaAria = await btnHandle.evaluate((btn, sel) => {
      const id = btn.getAttribute('aria-controls') || btn.getAttribute('aria-owns');
      const pop = id ? document.getElementById(id) : null;
      if (!pop) return null;
      document.querySelectorAll('[data-wd-opt]').forEach(e => e.removeAttribute('data-wd-opt'));
      const labels = [];
      for (const o of pop.querySelectorAll(sel)) {
        const t = (o.innerText || '').replace(/\s+/g, ' ').trim();
        if (!t) continue;
        o.setAttribute('data-wd-opt', String(labels.length));
        labels.push(t);
      }
      return labels;
    }, '[role="option"], [data-automation-id="promptOption"], [data-automation-label], li').catch(() => null);
    if (viaAria && viaAria.length) return viaAria;
  }
  return await page.evaluate((sel) => {
    document.querySelectorAll('[data-wd-opt]').forEach(e => e.removeAttribute('data-wd-opt'));
    const boxes = [...document.querySelectorAll('[role="listbox"], [data-automation-id="promptOptions"], [data-automation-widget="wd-popup"], ul')]
      .filter(e => {
        const r = e.getBoundingClientRect();
        if (r.width < 40 || r.height < 20) return false;
        const st = getComputedStyle(e);
        return st.visibility !== 'hidden' && st.display !== 'none';
      });
    const pop = boxes[boxes.length - 1];
    if (!pop) return [];
    const opts = [...pop.querySelectorAll(sel)];
    const labels = [];
    opts.forEach((o, i) => {
      const t = (o.innerText || '').replace(/\s+/g, ' ').trim();
      if (!t) return;
      o.setAttribute('data-wd-opt', String(labels.length));
      labels.push(t);
    });
    return labels;
  }, '[role="option"], [data-automation-id="promptOption"], [data-automation-label], li').catch(() => []);
}

export async function wdSelectByKeyboard(page, field, want, max = 14, log) {
  const g = group(page, field);
  if (!(await g.count().catch(() => 0))) return null;
  const btn = g.locator('button').first();
  if (!(await btn.count().catch(() => 0))) return null;

  const seen = [];
  /* BOTH directions. Re-opening a dropdown highlights its CURRENT value, so a
     down-only walk can never reach an entry that sits above it: Adobe's answer
     was "Yes" with the field already on "No", and fourteen ArrowDowns saw
     nothing but "No" and gave up on a question whose answer was one key away. */
  for (const key of ['ArrowDown', 'ArrowUp']) {
    let exhausted = false;
    for (let step = 1; step <= max && !exhausted; step++) {
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(250);
      if (!(await wdClick(btn))) { exhausted = true; break; }
      await page.waitForTimeout(700);
      /* ONE key per iteration. Re-opening highlights the value the field is
         already on, so pressing `step` arrows each time advanced cumulatively
         and visited positions 1, 3, 6, 10, 15 -- it went Alaska, Arkansas,
         California and skipped ARIZONA, the answer, sitting between the first
         two. One step from the current value visits every entry in order. */
      await page.keyboard.press(key).catch(() => {});
      await page.waitForTimeout(120);
      await page.keyboard.press('Enter').catch(() => {});
      await page.waitForTimeout(600);
      const now = (await btn.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (!now || /^select one$/i.test(now)) continue;
      if (want.test(now)) {
        if (log) log.push(`wd: ${field} = "${now}" (chosen by keyboard, ${step} x ${key})`);
        return now;
      }
      if (seen.includes(now)) { exhausted = true; break; }  /* this direction is done */
      seen.push(now);
    }
  }
  /* Nothing matched, and the walk has LEFT the field holding whatever the last
     step selected. That is how Adobe's State ended up on Wyoming. Put it back
     to "Select One" -- it is the first entry in these lists, so opening and
     pressing Enter without arrowing lands on it -- and confirm by readback. */
  /* Home jumps to the first entry, which is "Select One". Pressing Enter
     without moving keeps whatever the walk last landed on -- that is how the
     State field was left reading Vermont, and then "85331 is not a valid postal
     code for Vermont". */
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(250);
  if (await wdClick(btn)) {
    await page.waitForTimeout(600);
    await page.keyboard.press('Home').catch(() => {});
    await page.waitForTimeout(200);
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(500);
  }
  const left = (await btn.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  if (log) {
    log.push(`wd: ${field} keyboard walk found nothing${seen.length ? `; saw: ${seen.join(' / ').slice(0, 200)}` : ''}`);
    if (left && !/^select one$/i.test(left)) {
      log.push(`wd: ${field} is LEFT ON "${left}" after the walk - not a chosen answer`);
    }
  }
  return null;
}

export async function wdSelectOptions(page, field) {
  const g = group(page, field);
  if (!(await g.count().catch(() => 0))) return [];
  const btn = g.locator('button[aria-haspopup="listbox"], button').first();
  /* Open it up to three times with a growing wait. Cisco's ethnicity list came
     back "offered: (none)" on the same page where gender and veteran status
     both listed fine -- the popup for the field directly under an already-open
     one either does not open or renders empty, and a single attempt reports an
     empty list as though the field had no options at all. */
  let opts = [];
  for (let attempt = 1; attempt <= 3 && !opts.length; attempt++) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400 * attempt);
    if (!(await wdClick(btn))) continue;
    await page.waitForTimeout(900 * attempt);
    opts = (await readOpenOptions(page, await btn.elementHandle().catch(() => null))).filter(t => !/^select one$/i.test(t));
  }
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(500);
  return opts;
}

/**
 * Open a Workday single-select once, let the caller choose from what is
 * actually on offer, click it, and CONFIRM the trigger no longer reads
 * "Select One". Opening the list twice (once to read, once to pick) left the
 * popup covering the trigger, so the second open was swallowed and the field
 * stayed empty while the caller believed it had answered.
 * @param {import('playwright').Page} page
 * @param {string} field formField-<name> suffix
 * @param {(labels:string[])=>(string|null)} choose
 * @param {string[]} [log]
 * @returns {Promise<{ok:boolean,labels:string[],picked:string|null}>}
 */
export async function wdSelectChoose(page, field, choose, log) {
  const g = group(page, field);
  if (!(await g.count().catch(() => 0))) return { ok: false, labels: [], picked: null };
  const btn = g.locator('button[aria-haspopup="listbox"], button').first();
  if (!(await btn.count().catch(() => 0))) return { ok: false, labels: [], picked: null };
  const before = (await btn.innerText().catch(() => '')).trim();
  if (before && !/^select one$/i.test(before)) return { ok: true, labels: [], picked: before };
  const list = page.locator(OPTION_SEL);
  /* Same three-attempt open as wdSelectOptions, and for the same reason: the
     field directly under an already-open popup lists nothing on the first try.
     Cisco's ethnicity reported "offered: (none)" on a page where gender and
     veteran status both listed fine, and an empty list is indistinguishable
     from a field with no options. */
  let labels = [];
  let opened = false;
  for (let attempt = 1; attempt <= 3 && !labels.length; attempt++) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(350 * attempt);
    if (!(await wdClick(btn))) continue;
    opened = true;
    await page.waitForTimeout(900 * attempt);
    /* Only the popup that is open and on top - see readOpenOptions. */
    labels = await readOpenOptions(page, await btn.elementHandle().catch(() => null));
  }
  if (!opened) {
    if (log) log.push(`wd: could not open the ${field} dropdown`);
    return { ok: false, labels: [], picked: null };
  }
  const picked = choose(labels);
  if (!picked) {
    await page.keyboard.press('Escape').catch(() => {});
    if (log) log.push(`wd: no usable option for ${field}; offered: ${labels.slice(0, 15).join(' / ').slice(0, 200)}`);
    return { ok: false, labels, picked: null };
  }
  const at = labels.indexOf(picked);
  const target = at >= 0 ? page.locator(`[data-wd-opt="${at}"]`).first() : list.filter({ hasText: picked }).first();
  await target.scrollIntoViewIfNeeded().catch(() => {});
  await wdClick(target);
  await page.waitForTimeout(900);
  const after = (await btn.innerText().catch(() => '')).trim();
  const ok = !!after && !/^select one$/i.test(after);
  if (log) log.push(`wd: ${field} = ${picked} (${ok ? 'confirmed' : 'NOT confirmed'})`);
  return { ok, labels, picked };
}
