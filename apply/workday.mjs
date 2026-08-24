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
    store[host] = { email, password: chars.join(''), created: new Date().toISOString() };
    fs.writeFileSync(file, JSON.stringify(store, null, 2));
    return Object.assign({}, store[host], { fresh: true });
  }
  return Object.assign({}, store[host], { fresh: false });
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
  const overlay = loc.first().locator('xpath=..').locator(A('click_filter')).first();
  if (await overlay.count().catch(() => 0)) {
    const ok = await overlay.click({ timeout: 15000 }).then(() => true).catch(() => false);
    if (ok) return true;
  }
  return await loc.first().click({ timeout: 15000 }).then(() => true).catch(() => false);
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
export async function wdFill(page, field, value, log) {
  if (!value) return false;
  const el = group(page, field).locator('input[type=text], input:not([type]), textarea').first();
  if (!(await el.count().catch(() => 0))) return false;
  if (!(await el.isVisible().catch(() => false))) return false;
  const cur = await el.inputValue().catch(() => '');
  if (String(cur).trim()) return true;
  const ok = await el.fill(String(value)).then(() => true).catch(() => false);
  if (ok && log) log.push(`wd: filled ${field}`);
  return ok;
}

/**
 * Choose an option from a Workday single-select dropdown.
 * @param {import('playwright').Page} page
 * @param {string} field formField-<name> suffix
 * @param {RegExp} want option text to select
 * @param {string[]} [log]
 * @returns {Promise<boolean>}
 */
export async function wdSelect(page, field, want, log) {
  const g = group(page, field);
  if (!(await g.count().catch(() => 0))) return false;
  const btn = g.locator('button[aria-haspopup="listbox"], button').first();
  if (!(await btn.count().catch(() => 0))) return false;
  const current = (await btn.innerText().catch(() => '')).trim();
  if (current && !/^select one$/i.test(current)) return true;
  if (!(await wdClick(btn))) return false;
  await page.waitForTimeout(900);
  const opt = page.locator(`[role="option"], ${A('promptOption')}`).filter({ hasText: want }).first();
  if (!(await opt.count().catch(() => 0))) {
    await page.keyboard.press('Escape').catch(() => {});
    if (log) log.push(`wd: no option matching ${want.source} in ${field}`);
    return false;
  }
  const ok = await opt.click({ timeout: 8000 }).then(() => true).catch(() => false);
  await page.waitForTimeout(700);
  if (ok && log) log.push(`wd: selected ${want.source} in ${field}`);
  return ok;
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
export async function wdPromptPick(page, field, category, leaves, log) {
  const g = group(page, field);
  if (!(await g.count().catch(() => 0))) return false;
  if (/[1-9]\d* items? selected/i.test(await g.innerText().catch(() => ''))) return true;
  const input = g.locator('input').first();
  if (!(await input.count().catch(() => 0))) return false;
  await input.click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const opts = () => page.locator(A('promptOption'));
  const cat = opts().filter({ hasText: category }).first();
  if (await cat.count().catch(() => 0)) {
    await cat.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1800);
  }
  for (const leaf of leaves) {
    const o = opts().filter({ hasText: leaf }).first();
    if (!(await o.count().catch(() => 0))) continue;
    const ok = await o.click({ timeout: 8000 }).then(() => true).catch(() => false);
    if (!ok) continue;
    await page.waitForTimeout(1200);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(600);
    const filled = /[1-9]\d* items? selected/i.test(await g.innerText().catch(() => ''));
    if (log) log.push(`wd: ${field} = ${leaf.source} (${filled ? 'confirmed' : 'NOT confirmed'})`);
    if (filled) return true;
  }
  await page.keyboard.press('Escape').catch(() => {});
  if (log) log.push(`wd: could not pick a value for ${field}`);
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
    document.querySelectorAll('[data-automation-id*="rror"], [role="alert"]').forEach(e => {
      const t = (e.innerText || '').trim();
      if (t && t.length < 300) out.add(t.replace(/\s+/g, ' '));
    });
    (document.body.innerText || '').split(String.fromCharCode(10)).forEach(line => {
      const t = line.trim();
      if (/^error/i.test(t) || /is required and must have a value|please (select|enter)/i.test(t)) {
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
  if (grp.kind === 'radio') {
    const r = g.locator('input[type=radio]');
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
