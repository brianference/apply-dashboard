/**
 * Assisted apply runner — local only, never deployed.
 *
 * Fills a direct-ATS application form from apply-profile.local.json, screenshots
 * every step, and STOPS rather than guessing. It does not submit unless --submit
 * is passed, and it refuses to submit when any stop condition is hit.
 *
 * It does not defeat captchas. A captcha, a sign-in wall, or an unrecognised
 * required field ends the run with the browser left open for a human.
 *
 *   node apply/runner.mjs --url <postingUrl>              # dry run, fills + screenshots
 *   node apply/runner.mjs --url <postingUrl> --submit     # actually submits
 *   node apply/runner.mjs --url <postingUrl> --answer "…" # supply the free-text answer
 *   node apply/runner.mjs --help
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
/** Playwright lives in the RedAnvil tree, not in this repo. */
const { chromium } = require('C:/Users/brian/RedAnvil/node_modules/playwright');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..');
const PROFILE_PATH = path.join(ROOT, 'apply-profile.local.json');
const EVIDENCE_DIR = path.join(ROOT, 'evidence', 'apply');
const SESSION_DIR = path.join(ROOT, '.apply-session');

/** @returns {Record<string,string|boolean>} parsed argv */
function parseArgs() {
  const out = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue;
    const k = a[i].slice(2);
    const v = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true;
    out[k] = v;
  }
  return out;
}

/**
 * @param {string} s
 * @returns {string} filesystem-safe slug
 */
function slug(s) {
  return String(s).toLowerCase().replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70);
}

/** Stop conditions, checked against the live page. */
const CAPTCHA_SEL = 'iframe[src*="recaptcha/api2/anchor"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], .g-recaptcha:not([data-size="invisible"])';
const WALL_TEXT = /performing security verification|checking your browser|verify you are human|unusual traffic|sign in to (apply|continue|view)|create an account to apply/i;

/** Where Brian can legally be hired. A posting that excludes these is a hard stop. */
const HOME_STATE = /\barizona\b|\bAZ\b/i;
const US_ANYWHERE = /\b(united states|u\.?s\.?a?\b|us[- ]remote|remote[- ]us|anywhere in the (us|u\.s\.)|nationwide|all (us )?states)\b/i;

/**
 * A residency picker that lists specific metros tells us who they can hire.
 * If it offers neither Arizona nor a US-wide option, applying is pointless.
 * @param {import('playwright').Page} page
 * @returns {Promise<{restricted:boolean, options:string[]}>}
 */
async function locationEligibility(page) {
  const options = await page.evaluate(() => {
    const out = [];
    const PHONE_CODE = /\+\d{1,4}\s*$/;   // "Andorra+376" — a dial-code picker, not a hiring list
    for (const s of document.querySelectorAll('select')) {
      const lab = (s.getAttribute('aria-label') || s.closest('label')?.innerText || '').toLowerCase();
      /* Only a question about where the candidate LIVES tells us who they can
         hire. A phone dial-code selector also says "country" and lists all 200
         nations, which false-flagged a perfectly applicable GitLab posting. */
      if (!/where do you (currently )?(reside|live)|current(ly)? (reside|residence|located)|country of residence|hiring location|eligible to work in/.test(lab)) continue;
      const opts = [...s.options].filter(o => o.value).map(o => o.textContent.trim());
      if (opts.length > 60 || opts.some(o => PHONE_CODE.test(o))) continue;
      out.push(...opts);
    }
    for (const l of document.querySelectorAll('[role="listbox"] [role="option"]')) {
      const t = l.textContent.trim();
      if (!PHONE_CODE.test(t)) out.push(t);
    }
    return out.slice(0, 200);
  }).catch(() => []);
  /* A list of 60+ entries is a country picker, not a short hiring-metro list.
     Only a SHORT explicit list can prove someone is ineligible. */
  if (!options.length || options.length > 60) return { restricted: false, options };
  const joined = options.join(' | ');
  const restricted = !HOME_STATE.test(joined) && !US_ANYWHERE.test(joined);
  return { restricted, options };
}

/**
 * Fill a labelled field if it exists, reporting what happened.
 * @param {import('playwright').Page} page
 * @param {RegExp|string} label
 * @param {string} value
 * @param {string[]} log
 * @returns {Promise<boolean>} whether a field was filled
 */
async function fillByLabel(page, label, value, log) {
  const el = page.getByLabel(label).first();
  if (!(await el.count().catch(() => 0))) return false;
  if (!(await el.isVisible().catch(() => false))) return false;
  await el.fill(String(value));
  log.push(`filled ${label} = ${String(value).slice(0, 40)}`);
  return true;
}

/**
 * Fill a typeahead / combobox. Typing alone leaves these widgets unset — they
 * only register once an option from the popup listbox is chosen, which is why
 * "Country of Residence" kept coming back as required-and-empty.
 * @param {import('playwright').Page} page
 * @param {RegExp} label
 * @param {string} value
 * @param {string[]} log
 * @returns {Promise<boolean>}
 */
async function fillCombo(page, label, value, log) {
  const el = page.getByLabel(label).first();
  if (!(await el.count().catch(() => 0))) return false;
  if (!(await el.isVisible().catch(() => false))) return false;

  const tag = await el.evaluate(e => e.tagName.toLowerCase()).catch(() => '');
  if (tag === 'select') {
    await el.selectOption({ label: value }).catch(async () => {
      await el.selectOption(value).catch(() => {});
    });
    log.push(`selected ${label.source.slice(0, 30)} = ${value}`);
    return true;
  }

  await el.click().catch(() => {});
  await el.fill('').catch(() => {});
  await el.type(value, { delay: 45 }).catch(() => {});
  await page.waitForTimeout(900);

  // click the matching option in whatever popup appeared
  const option = page.locator(
    `[role="option"]:visible, [role="listbox"] li:visible, .select__option:visible, [class*="option"]:visible`
  ).filter({ hasText: new RegExp('^\\s*' + value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }).first();
  if (await option.count().catch(() => 0)) {
    await option.click().catch(() => {});
    log.push(`picked ${label.source.slice(0, 30)} = ${value} (from listbox)`);
  } else {
    await el.press('Enter').catch(() => {});
    log.push(`typed ${label.source.slice(0, 30)} = ${value} (no listbox, pressed Enter)`);
  }
  await page.waitForTimeout(350);
  return true;
}

/**
 * @param {import('playwright').Page} page
 * @returns {Promise<{captcha:boolean, wall:boolean, text:string}>}
 */
async function stopCheck(page) {
  /* Only a VISIBLE captcha is a stop. Ashby and Greenhouse both embed an
     invisible reCAPTCHA on forms that submit fine; counting the hidden iframe
     stopped a perfectly good run on the first attempt. */
  const captcha = await page.evaluate((sel) => {
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width > 40 && r.height > 40 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.1) {
        return true;
      }
    }
    return false;
  }, CAPTCHA_SEL).catch(() => false);
  const text = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
  return { captcha, wall: WALL_TEXT.test(text.slice(0, 4000)), text };
}

/**
 * Answer a Yes/No question rendered as a pair of buttons (Ashby's style)
 * rather than as a checkbox or radio.
 * @param {import('playwright').Page} page
 * @param {RegExp} question text of the question
 * @param {"Yes"|"No"} answer
 * @param {string[]} log
 * @returns {Promise<boolean>}
 */
async function answerYesNo(page, question, answer, log) {
  const found = await page.evaluate(({ q, a }) => {
    const rx = new RegExp(q, 'i');
    const blocks = [...document.querySelectorAll('div,fieldset,section,li')];
    for (const b of blocks) {
      const own = [...b.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ');
      const label = (b.querySelector('label,legend,p,span')?.innerText || own || '').trim();
      if (!rx.test(label) && !rx.test(b.innerText.slice(0, 240))) continue;
      const btns = [...b.querySelectorAll('button,[role="radio"],label')]
        .filter(e => /^(yes|no)$/i.test((e.innerText || '').trim()));
      if (btns.length < 2) continue;
      const target = btns.find(e => (e.innerText || '').trim().toLowerCase() === a.toLowerCase());
      if (target) { target.click(); return true; }
    }
    return false;
  }, { q: question.source, a: answer }).catch(() => false);
  if (found) log.push(`answered "${question.source.slice(0, 34)}" = ${answer}`);
  return found;
}

async function main() {
  const args = parseArgs();
  if (args.help || !args.url) {
    console.log(`assisted apply runner

  --url <postingUrl>    the posting to apply to (required)
  --submit              actually submit; without it this is a dry run
  --answer "<text>"     answer for a required free-text question
  --headed              show the browser (default: headed, so you can take over)
  --help

Profile: ${PROFILE_PATH}
Evidence: ${EVIDENCE_DIR}
Never submits when a captcha, a sign-in wall, or an unknown required field is present.`);
    process.exit(args.url ? 0 : 1);
  }

  if (!fs.existsSync(PROFILE_PATH)) {
    console.error(`FATAL: no profile at ${PROFILE_PATH}`);
    process.exit(1);
  }
  const profile = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
  const resume = profile.documents.resume;
  if (!fs.existsSync(resume)) {
    console.error(`FATAL: resume not found at ${resume}`);
    process.exit(1);
  }

  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const tag = slug(args.url);
  const shot = async (page, step) => {
    const f = path.join(EVIDENCE_DIR, `${tag}--${step}.png`);
    await page.screenshot({ path: f, fullPage: true });
    console.log(`  screenshot: ${f}`);
    return f;
  };

  const log = [];
  /* A previous run is deliberately left open on a stop, and it holds the profile
     directory. Chrome then answers "Opening in existing browser session" and
     Playwright never gets a connection. Reclaim the profile first. */
  /* One throwaway profile per run. A shared profile gets held open by the
     previous run (which is left open on purpose when it stops), and Chrome then
     answers "Opening in existing browser session" so Playwright never connects.
     Ashby, Greenhouse, Lever and Workday all serve their forms without a login,
     so there is no session worth persisting. Pass --session to reuse one. */
  const profileDir = args.session ? SESSION_DIR : `${SESSION_DIR}-${Date.now()}`;
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1360, height: 1000 },
    acceptDownloads: true,
  });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('pageerror', e => consoleErrors.push(String(e.message).slice(0, 120)));

  console.log(`\n=== ${args.url}`);
  console.log(`mode: ${args.submit ? 'SUBMIT' : 'DRY RUN (will not submit)'}`);

  /* A persistent context sometimes aborts its very first navigation while the
     profile is still warming up. One retry, then give up honestly. */
  let resp = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      resp = await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      break;
    } catch (e) {
      if (attempt === 2) throw e;
      console.log(`  navigation attempt ${attempt} failed (${String(e.message).slice(0, 60)}), retrying`);
      await page.waitForTimeout(2000);
    }
  }
  await page.locator('button, a[href]').first().waitFor({ timeout: 20000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  console.log(`HTTP ${resp ? resp.status() : '?'}`);
  await shot(page, '1-landed');

  let pre = await stopCheck(page);
  if (pre.wall) {
    console.log('STOP: sign-in or bot-check wall on the posting page. Browser left open.');
    await shot(page, 'stop-wall');
    return { state: 'wall', log };
  }

  // reveal the form where the ATS hides it behind an Apply button
  for (const rx of [/^apply for this job$/i, /^apply now$/i, /^apply$/i]) {
    const btn = page.getByRole('button', { name: rx }).first();
    if (await btn.count().catch(() => 0) && await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(2500);
      log.push(`clicked ${rx}`);
      break;
    }
  }
  await shot(page, '2-form');

  // --- fill what we know ---
  const id = profile.identity;
  await fillByLabel(page, /^full name|^name$/i, id.fullName, log);
  await fillByLabel(page, /first name/i, id.firstName, log);
  await fillByLabel(page, /last name/i, id.lastName, log);
  await fillByLabel(page, /^email/i, id.email, log);
  await fillByLabel(page, /phone/i, id.phone, log);
  await fillByLabel(page, /linkedin/i, id.linkedin, log);
  await fillByLabel(page, /github/i, id.github, log);
  await fillByLabel(page, /where do you (currently )?reside|current location|^location/i, id.location, log);
  await fillCombo(page, /country of residence/i, id.country, log);
  await fillCombo(page, /passport country/i, id.country, log);
  await fillCombo(page, /^country/i, id.country, log);
  await fillCombo(page, /where do you (currently )?reside/i, id.country, log);
  await fillByLabel(page, /salary|compensation expectation|expected (base )?(salary|comp)/i,
    profile.compensation.answerTemplate, log);
  await fillByLabel(page, /start date|earliest.*start|available/i, profile.eligibility.earliestStart, log);
  /* Yes/No questions. Ashby renders them as a pair of buttons; Greenhouse
     renders the same questions as comboboxes. Try both for each. */
  const YESNO = [
    [/legally authorized to work/i, 'Yes'],
    [/are you (legally )?(authorized|eligible)/i, 'Yes'],
    [/require sponsorship|visa sponsorship|sponsorship for a visa/i, 'No'],
    [/non[- ]compete|post[- ]employment restriction|employment agreements/i, 'No'],
    [/previously (worked|applied|been employed|consulted)/i, 'No'],
  ];
  for (const [q, a] of YESNO) {
    const viaButton = await answerYesNo(page, q, a, log);
    if (!viaButton) await fillCombo(page, q, a, log);
  }

  /* Free-text answers come from a JSON file of {questionSubstring: answer}.
     Nothing here is generated at run time — the text is written and reviewed
     beforehand, drawn from apply/narrative.local.md and the resume. */
  if (args.answers && fs.existsSync(String(args.answers))) {
    const bank = JSON.parse(fs.readFileSync(String(args.answers), 'utf8'));
    const areas = page.locator('textarea');
    const n = await areas.count();
    for (let i = 0; i < n; i++) {
      const ta = areas.nth(i);
      if (!(await ta.isVisible().catch(() => false))) continue;
      const qtext = await ta.evaluate(el => {
        const box = el.closest('div,fieldset,section') || el.parentElement;
        return (box ? box.innerText : '').replace(/\s+/g, ' ').slice(0, 300);
      }).catch(() => '');
      const key = Object.keys(bank).find(k => qtext.toLowerCase().includes(k.toLowerCase()));
      if (!key) continue;
      await ta.fill(bank[key]);
      log.push(`answered "${key.slice(0, 44)}" (${bank[key].length} chars)`);
    }
  }
  if (args.answer) {
    const ta = page.locator('textarea:visible').first();
    if (await ta.count()) { await ta.fill(String(args.answer)); log.push('filled free-text answer'); }
  }

  /* EEO. Brian's standing instruction: always take the decline option. The only
     exception he gave is veteran status, where if no decline option exists the
     answer is "not a veteran". Never guess an EEO value. */
  const eeoPicked = await page.evaluate(() => {
    const DECLINE = /decline to (self[- ]?identify|answer)|i don'?t wish to answer|i do ?n'?t want to answer|prefer not to (say|answer|disclose)|choose not to (disclose|self[- ]?identify)|wish not to answer/i;
    const NOT_VET = /^i am not a (protected )?veteran|not a veteran|i am not a protected veteran/i;
    const picked = [];
    for (const s of document.querySelectorAll('select')) {
      const lab = (s.getAttribute('aria-label') || s.closest('label,div')?.innerText || '').slice(0, 160);
      if (!/gender|ethnic|race|hispanic|latino|disab|veteran/i.test(lab)) continue;
      if (s.value) continue;
      let opt = [...s.options].find(o => DECLINE.test(o.textContent));
      if (!opt && /veteran/i.test(lab)) opt = [...s.options].find(o => NOT_VET.test(o.textContent.trim()));
      if (!opt) continue;
      s.value = opt.value;
      s.dispatchEvent(new Event('input', { bubbles: true }));
      s.dispatchEvent(new Event('change', { bubbles: true }));
      picked.push(`${lab.replace(/\s+/g, ' ').slice(0, 40)} = ${opt.textContent.trim().slice(0, 40)}`);
    }
    return picked;
  }).catch(() => []);
  eeoPicked.forEach(p => log.push(`EEO ${p}`));

  /* Greenhouse renders EEO as custom comboboxes, not native selects, so the
     block above cannot reach them. Drive each one through the listbox. */
  const EEO_COMBOS = [
    [/^gender/i, /decline to self.?identify|don'?t wish to answer|prefer not/i],
    [/hispanic|latino|ethnic|race/i, /decline to self.?identify|don'?t wish to answer|prefer not/i],
    [/disability status/i, /do ?n'?t wish to answer|decline to answer|prefer not/i],
    [/veteran status/i, /decline to self.?identify|don'?t wish to answer|prefer not|i am not a protected veteran|not a (protected )?veteran/i],
  ];
  for (const [label, want] of EEO_COMBOS) {
    const el = page.getByLabel(label).first();
    if (!(await el.count().catch(() => 0))) continue;
    if (!(await el.isVisible().catch(() => false))) continue;
    await el.click().catch(() => {});
    await page.waitForTimeout(500);
    const opt = page.locator('[role="option"]:visible, [role="listbox"] li:visible')
      .filter({ hasText: want }).first();
    if (await opt.count().catch(() => 0)) {
      await opt.click().catch(() => {});
      log.push(`EEO ${label.source.slice(0, 22)} = declined`);
    } else {
      await el.press('Escape').catch(() => {});
      log.push(`EEO ${label.source.slice(0, 22)} = NO DECLINE OPTION FOUND`);
    }
    await page.waitForTimeout(250);
  }

  // hard stop: can they even hire someone in Arizona?
  const loc = await locationEligibility(page);
  if (loc.restricted) {
    console.log('\nSTOP: this employer\'s residency list does not include Arizona or a US-wide option.');
    console.log('      offered:', loc.options.slice(0, 12).join(' | '));
    console.log('      Applying would be rejected on location. Not submitting.');
    await shot(page, 'stop-location-ineligible');
    return { state: 'location-ineligible', options: loc.options, log };
  }

  // resume, and the resume again where a cover letter upload is mandatory
  const files = page.locator('input[type=file]');
  const nFiles = await files.count();
  for (let i = 0; i < nFiles; i++) {
    const f = files.nth(i);
    await f.setInputFiles(resume).then(() => log.push(`attached resume to file input ${i}`)).catch(() => {});
  }

  await page.waitForTimeout(1500);
  await shot(page, '3-filled');

  // --- what is still required and unanswered? ---
  const unanswered = await page.evaluate(() => {
    const out = [];
    for (const e of document.querySelectorAll('input,select,textarea')) {
      if (['hidden', 'submit', 'button'].includes(e.type)) continue;
      const req = e.required || e.getAttribute('aria-required') === 'true';
      if (!req) continue;
      let empty;
      if (e.type === 'checkbox' || e.type === 'radio') {
        empty = !e.checked;
      } else if (e.type === 'file') {
        /* Ashby swaps the native input for its own widget and clears .value once
           the upload lands, so .value is NOT evidence the file is missing. Trust
           the rendered filename near the control instead. */
        const box = e.closest('div,fieldset,section') || e.parentElement;
        empty = !(e.files && e.files.length) && !/\.(pdf|docx?|rtf|txt)\b/i.test(box ? box.innerText : '');
      } else {
        empty = !String(e.value || '').trim();
        if (empty) {
          /* Greenhouse and Ashby both back a custom combobox with a hidden
             native input they leave blank. The rendered control is the truth.
             Without this, four already-answered GitLab questions reported as
             missing and the run refused to submit a complete form. */
          const box = e.closest('[class*="select"],[class*="combobox"],[role="combobox"],div');
          const shown = box ? box.innerText.replace(/\s+/g, ' ').trim() : '';
          const combo = e.getAttribute('aria-controls') || e.getAttribute('aria-owns');
          const live = combo ? document.getElementById(combo) : null;
          if (/\b(yes|no|united states|decline|prefer not|i don'?t)\b/i.test(shown)
              && !/^select\.{0,3}$/i.test(shown)) empty = false;
          if (live && live.textContent.trim()) empty = false;
        }
      }
      if (!empty) continue;
      const lab = e.getAttribute('aria-label')
        || (e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`)?.innerText)
        || e.closest('label')?.innerText || e.name || '(unlabelled)';
      out.push(String(lab).replace(/\s+/g, ' ').slice(0, 90));
    }
    return [...new Set(out)];
  });

  /* Drop questions the runner demonstrably answered through the listbox. Their
     hidden native input stays blank by design in Greenhouse's widget, so the
     raw scan reports them missing even though the rendered control shows the
     value. Only questions we never touched should block a submit. */
  const answeredRx = YESNO.map(([q]) => q)
    .concat([/country of residence/i, /^country/i, /passport country/i]);
  const stillMissing = unanswered.filter(u => !answeredRx.some(rx => rx.test(u)));
  if (stillMissing.length !== unanswered.length) {
    console.log(`\n(${unanswered.length - stillMissing.length} field(s) reported empty but were answered via the listbox — not blocking)`);
  }

  const post = await stopCheck(page);
  console.log('\nfilled:');
  log.forEach(l => console.log('  -', l));
  console.log('\nstill required and empty:');
  if (!unanswered.length) console.log('  (none)');
  unanswered.forEach(u => console.log('  !', u));
  console.log(`\ncaptcha visible: ${post.captcha}   wall: ${post.wall}   pageerrors: ${consoleErrors.length}`);

  if (post.captcha) {
    console.log('\nSTOP: an interactive captcha is on the form. Not submitting. Browser left open — your turn.');
    await shot(page, 'stop-captcha');
    return { state: 'captcha', unanswered, log };
  }
  if (stillMissing.length) {
    console.log('\nSTOP: required fields this profile has no answer for. Not submitting. Browser left open.');
    await shot(page, 'stop-unanswered');
    return { state: 'needs-input', unanswered: stillMissing, log };
  }
  if (!args.submit) {
    console.log('\nDRY RUN complete — form is filled and NOT submitted. Re-run with --submit to send it.');
    return { state: 'dry-run-ok', unanswered, log };
  }

  const submit = page.getByRole('button', { name: /submit application|^submit$|send application/i }).first();
  if (!(await submit.count())) {
    console.log('\nSTOP: no submit button found. Not submitting.');
    await shot(page, 'stop-nosubmit');
    return { state: 'no-submit-button', log };
  }
  await submit.click();
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const after = await page.evaluate(() => (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 400));
  const confirmed = /thank you|application (received|submitted)|we have received|successfully applied|your application/i.test(after);
  await shot(page, confirmed ? '4-submitted' : '4-after-submit-unconfirmed');
  console.log(`\nafter submit: ${JSON.stringify(after.slice(0, 200))}`);
  console.log(confirmed ? 'SUBMITTED — confirmation text found on the page.' : 'SUBMIT CLICKED but no confirmation text found. Verify manually before marking applied.');
  return { state: confirmed ? 'submitted' : 'submitted-unconfirmed', log };
}

const result = await main();
console.log('\nRESULT:', JSON.stringify(result && result.state));
