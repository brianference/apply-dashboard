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
import { runWorkday } from './workday-drive.mjs';

const require = createRequire(import.meta.url);
/** Playwright lives in the RedAnvil tree, not in this repo. */
const { chromium } = require('C:/Users/brian/RedAnvil/node_modules/playwright');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..');
const PROFILE_PATH = path.join(ROOT, 'apply-profile.local.json');
const EVIDENCE_DIR = path.join(ROOT, 'evidence', 'apply');
const SESSION_DIR = path.join(ROOT, '.apply-session');

/**
 * Escape a string for safe use inside a RegExp.
 * @param {string} s
 * @returns {string}
 */
function escapeRx(s) {
  return String(s).split('').map(c => '.*+?^${}()|[]\\'.includes(c) ? '\\' + c : c).join('');
}

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
const WALL_TEXT = /performing security verification|checking your browser|verify you are human|unusual traffic|sign in to (apply|continue|view)|create an account to apply|verification required|slide right to secure|we detected unusual activity/i;

/**
 * Employer careers sites that are a skin over a Greenhouse board. The posting
 * URL carries the Greenhouse job id as `gh_jid`, but the page itself is a
 * client-rendered SPA whose form only appears after an iframe loads -- and for
 * three of these five the vanity page never exposes the board token in its HTML
 * at all, so the token cannot be sniffed and has to be known.
 *
 * Every token here was confirmed against the Greenhouse boards API: a GET of
 * /v1/boards/<token>/jobs/<gh_jid> returns 200 and its `absolute_url` points
 * back at the host on the left. `greenhouseEmbedUrl` re-runs that check at
 * runtime, so a token that stops matching stops rewriting instead of sending
 * the run to some other company's form.
 */
const GH_VANITY_BOARDS = {
  'stripe.com': 'stripe',
  'samsara.com': 'samsara',
  'coinbase.com': 'coinbase',
  'pinterestcareers.com': 'pinterest',
  'instacart.careers': 'instacart',
  'fivetran.com': 'fivetran',
  'cribl.io': 'cribl',
  'careers.upstart.com': 'upstart',
  'jobs.elastic.co': 'elastic',
};

/**
 * Resolve a vanity careers URL to the plain Greenhouse application form.
 *
 * `job-boards.greenhouse.io/<token>/jobs/<id>` is NOT usable here: Greenhouse
 * 302s it straight back to the employer's own careers page, which is where we
 * started. The form that actually renders standalone is the embed endpoint.
 *
 * @param {string} url posting URL as it appears in the queue
 * @returns {Promise<{url:string, why:string}|null>} null when this is not a
 *   known vanity board, or when the board token could not be confirmed.
 */
async function greenhouseEmbedUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const jid = u.searchParams.get('gh_jid');
  if (!jid || !/^\d+$/.test(jid)) return null;
  const host = u.hostname.replace(/^www\./, '');
  const board = GH_VANITY_BOARDS[host];
  if (!board) return null;

  /* Confirm the token really owns this job id before redirecting the run. */
  let job;
  try {
    const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${jid}`,
      { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    job = await r.json();
  } catch {
    return null;
  }
  let absHost = '';
  try { absHost = new URL(job.absolute_url).hostname.replace(/^www\./, ''); } catch { return null; }
  if (absHost !== host) return null;

  return {
    url: `https://job-boards.greenhouse.io/embed/job_app?for=${board}&token=${jid}`,
    why: `greenhouse vanity board "${board}" (confirmed: boards-api absolute_url is ${absHost})`,
  };
}

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
 * Tag the first control that sits under a given question text, so it can be
 * driven by Playwright. Ashby renders several controls with no id, no name and
 * no aria-label, which makes getByLabel useless on them.
 * @param {import('playwright').Page} page
 * @param {RegExp} question
 * @param {string} attr data-attribute name to stamp
 * @param {string} sel which controls count
 * @returns {Promise<boolean>}
 */
async function tagNear(page, question, attr, sel) {
  return page.evaluate(({ src, attr, sel }) => {
    const rx = new RegExp(src, 'i');
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const found = [];
    let n;
    while ((n = w.nextNode())) {
      if (!rx.test(n.textContent)) continue;
      let el = n.parentElement;
      for (let up = 0; up < 5 && el; up++) {
        const c = el.querySelector(sel);
        if (c) { found.push(c); break; }
        el = el.parentElement;
      }
    }
    if (!found.length) return false;
    /* The sidebar has its own "Location" heading, and taking the first match
       tagged a control next to that instead of the form field. Prefer an EMPTY
       control, and prefer a combobox over a plain text input. */
    /* NEVER pick a control that identifies itself as something else. Headway's
       sidebar carries its own "Location" heading; walking up from that reached a
       container holding the whole form, and querySelector returned the FIRST
       input in it -- Full Name. The runner then wrote the home city, state and
       country into the candidate's name. Preferring an empty control was
       not enough, because Full Name is empty at that point too. */
    const OWN_LABEL_IS_SOMETHING_ELSE = /(full |legal |first |last |preferred )?name|e-?mail|phone|resume|cv|linkedin|github|portfolio|website|url|salary|compensation|pronoun|company|employer|title/i;
    const labelOf = (c) => {
      const byFor = c.id ? document.querySelector(`label[for="${CSS.escape(c.id)}"]`) : null;
      return String(
        c.getAttribute('aria-label')
        || (byFor && byFor.innerText)
        || (c.closest('label') && c.closest('label').innerText)
        || c.placeholder
        || c.name
        || ''
      ).replace(/\s+/g, ' ').trim();
    };
    const safe = found.filter(c => {
      const lab = labelOf(c);
      return !(lab && OWN_LABEL_IS_SOMETHING_ELSE.test(lab));
    });
    if (!safe.length) return false;
    const empty = safe.filter(c => !String(c.value || '').trim());
    const pool = empty.length ? empty : safe;
    const combo = pool.filter(c => c.getAttribute('role') === 'combobox');
    const pick = (combo.length ? combo : pool)[0];
    pick.setAttribute(attr, '1');
    return true;
  }, { src: question.source, attr, sel }).catch(() => false);
}

/**
 * Answer a Yes/No question whose options are plain buttons, using a REAL
 * Playwright click. A scripted element.click() inside page.evaluate did not
 * register with Ashby's React handler — the log said answered, the rendered
 * control stayed unselected, and the form refused to submit.
 * @param {import('playwright').Page} page
 * @param {RegExp} question
 * @param {"Yes"|"No"} answer
 * @param {string[]} log
 * @returns {Promise<boolean>}
 */
async function clickYesNo(page, question, answer, log) {
  /* Tag EVERY unanswered group matching the question, not just the first.
     Docker asks about work authorization twice with different wording, and
     answering only one left the form rejecting the submit. */
  const count = await page.evaluate(({ src }) => {
    const rx = new RegExp(src, 'i');
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const groups = new Set();
    let n;
    while ((n = w.nextNode())) {
      if (!rx.test(n.textContent)) continue;
      let el = n.parentElement;
      for (let up = 0; up < 5 && el; up++) {
        const btns = [...el.querySelectorAll('button')]
          .filter(b => /^(yes|no)$/i.test((b.innerText || '').trim()));
        /* EXACTLY one Yes/No pair. Allowing up to four buttons let an ancestor
           holding two separate questions match, so the sponsorship answer "No"
           overwrote the work-authorization "Yes" and Docker kept rejecting it. */
        if (btns.length === 2) { groups.add(el); break; }
        if (btns.length > 2) break;
        el = el.parentElement;
      }
    }
    let i = 0;
    for (const g of groups) {
      /* skip a group that already has a selection: aria-pressed/checked, or a
         button styled as active via aria-current */
      const btns = [...g.querySelectorAll('button')]
        .filter(b => /^(yes|no)$/i.test((b.innerText || '').trim()));
      const answered = btns.some(b => b.getAttribute('aria-pressed') === 'true'
        || b.getAttribute('aria-checked') === 'true' || b.dataset.state === 'checked');
      if (answered) continue;
      g.setAttribute('data-yn-group', String(++i));
      btns.forEach(b => b.setAttribute('data-yn', (b.innerText || '').trim().toLowerCase()));
    }
    return i;
  }, { src: question.source }).catch(() => 0);
  if (!count) return false;

  let clicked = 0;
  for (let i = 1; i <= count; i++) {
    const target = page.locator(`[data-yn-group="${i}"] [data-yn="${answer.toLowerCase()}"]`).first();
    if (!(await target.count().catch(() => 0))) continue;
    await target.click().catch(() => {});
    await page.waitForTimeout(200);
    clicked++;
  }
  await page.evaluate(() => {
    document.querySelectorAll('[data-yn-group]').forEach(e => e.removeAttribute('data-yn-group'));
    document.querySelectorAll('[data-yn]').forEach(e => e.removeAttribute('data-yn'));
  }).catch(() => {});
  if (clicked) log.push(`clicked ${question.source.slice(0, 34)} = ${answer} (${clicked} group${clicked > 1 ? 's' : ''})`);
  return clicked > 0;
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
  /* Restrict to real form controls. getByLabel(/linkedin/i) matched Autodesk's
     LinkedIn SOCIAL ICON (an <a>), and fill() then hung waiting for a link to
     become editable until the whole run was killed - which is why every Workday
     posting recorded zero submissions. */
  const el = page.locator('input, textarea, select').filter({ hasNot: page.locator('[type=hidden]') })
    .and(page.getByLabel(label)).first();
  if (!(await el.count().catch(() => 0))) return false;
  if (!(await el.isVisible().catch(() => false))) return false;
  const editable = await el.evaluate(e => {
    const t = e.tagName;
    return (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') && !e.disabled && !e.readOnly;
  }).catch(() => false);
  if (!editable) return false;
  await el.fill(String(value), { timeout: 10000 }).catch(() => {});
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
 * Some employers put a custom-branded careers page in front of Greenhouse
 * rather than showing the bare job-boards.greenhouse.io template directly.
 * The visible "Apply" control there is decorative; the real form lives in a
 * same-page iframe at a URL like .../embed/job_app?for=<company>&token=<id>.
 * Instacart is a confirmed case: the top document has zero form fields and
 * zero apply buttons, so every fill and the submit-button search silently
 * found nothing and the run wrongly reported "no submit button found."
 * @param {import('playwright').Page} page
 * @returns {Promise<import('playwright').Page|import('playwright').Frame>}
 */
/**
 * Is a bot-check wall standing anywhere on this page, including inside a frame?
 *
 * stopCheck reads the TOP-LEVEL body text, and SmartRecruiters' wall leaves that
 * string empty: the "Verification Required / Slide right to secure your access"
 * page is served by DataDome inside a geo.captcha-delivery.com iframe. Measured
 * on ServiceNow 744000144573740 -- top-level innerText was "", the frame held
 * the whole notice -- so the run filed a wall nobody can pass as
 * "needs-account-or-wizard", a gate a human could have cleared.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<string|null>} what was seen, or null when the page is clear
 */
async function wallInAnyFrame(page) {
  for (const f of page.frames()) {
    /* DataDome only, and only by URL. Listing hcaptcha.com here made the
       INVISIBLE badge on the iCIMS wizard ("Protected by hCaptcha", a strip in
       the footer) read as a wall, and a form that was one email field away from
       opening got reported as unpassable. A rendered challenge is caught by
       CAPTCHA_SEL, which measures the box. DataDome is different in kind: it
       replaces the whole document with an interstitial. */
    if (/geo\.captcha-delivery\.com/i.test(f.url())) {
      return `bot-check iframe: ${f.url().slice(0, 60)}`;
    }
    const txt = await f.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
    if (WALL_TEXT.test(txt.slice(0, 4000))) return `wall text in ${f.url().slice(0, 60)}`;
  }
  return null;
}

async function getFormFrame(page) {
  for (const f of page.frames()) {
    if (!/\/embed\/job_app|greenhouse\.io\/embed/i.test(f.url())) continue;
    const n = await f.locator('input,select,textarea').count().catch(() => 0);
    if (n > 0) return f;
  }
  /* Not every embedded ATS is Greenhouse. iCIMS serves its whole application
     inside icims_content_iframe, and the top document holds nothing but the
     employer chrome, so the run saw a page with no form. Take any child frame
     carrying a real cluster of controls -- four, so a lone search box or a
     cookie toggle in some widget frame cannot pass for an application. */
  let best = null;
  let bestCount = 3;
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    if (/recaptcha|hcaptcha|captcha-delivery|doubleclick|googletagmanager|analytics/i.test(f.url())) continue;
    const n = await f.locator('input:not([type=hidden]),select,textarea').count().catch(() => 0);
    if (n > bestCount) { best = f; bestCount = n; }
  }
  return best || page;
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


/** States where a human is expected to take over — never auto-close for these
 * in interactive (non-batch) use. In --batch mode there is no human watching,
 * so every state closes; leaving the browser open per posting is exactly what
 * piled up 20+ orphaned Chrome processes and stalled an unattended run. */
const HUMAN_TURN_STATES = new Set([
  /* The tenant created the account and emailed a verification link. One click
     in Brian's inbox unblocks every posting on that tenant, so this is a human
     turn, not a defect. */
  'wd-email-verification',
  'wall', 'captcha', 'needs-input', 'needs-consent-decision',
  'location-ineligible', 'no-submit-button',
  /* Every one of these ends with a filled form that a human could finish in the
     open window. They were missing, so a Workday run that stopped one field
     short closed the browser on its way out and there was nothing left to look
     at. Cisco stopped on "How Did You Hear About Us?" and vanished. */
  'wd-validation-blocked', 'wd-unknown-question', 'wd-stuck', 'wd-auth-blocked',
  'needs-email-code', 'code-unconfirmed', 'submitted-unconfirmed', 'captcha-blocked',
]);

/**
 * Close the browser context unless this is an interactive stop meant for a
 * human, then return the result. Centralised so every exit path is covered —
 * nine separate early returns previously never closed anything, so even a
 * clean "submitted" run left Chrome running until something else killed it.
 * @param {import('playwright').BrowserContext} ctx
 * @param {boolean} batchMode
 * @param {object} result
 * @returns {Promise<object>}
 */
async function finish(ctx, batchMode, result) {
  /* --keep-open decouples the browser's lifetime from the run's outcome. The
     runner owning Chrome and disposing of it on exit is the reason every window
     Brian tried to inspect disappeared mid-diagnosis: in batch mode leaveOpen
     was false unconditionally, so not even a human-turn state kept it up. */
  const keepOpen = process.argv.includes('--keep-open');
  const leaveOpen = keepOpen || (!batchMode && HUMAN_TURN_STATES.has(result.state));
  if (keepOpen) console.log('\n--keep-open: leaving the browser up. Close it yourself when done.');
  if (!leaveOpen) {
    await ctx.close().catch(() => {});
    /* Closing the context is not enough on Windows: Chrome's child processes
       can outlive it, and the throwaway profile directory is left on disk.
       23 orphaned .apply-session-* dirs and 100+ chrome.exe accumulated this
       way. Kill anything still holding THIS run's profile, then remove it. */
    await cleanupProfile();
  }
  return result;
}

/** Profile directory this run owns, set once the context launches. */
let ACTIVE_PROFILE_DIR = null;
let cleanedUp = false;

/**
 * Kill any chrome still holding this run's own profile dir, then delete it.
 * Scoped to this run's unique directory so no other browser is touched.
 * @returns {Promise<void>}
 */
async function cleanupProfile() {
  if (cleanedUp || !ACTIVE_PROFILE_DIR) return;
  cleanedUp = true;
  const dirName = path.basename(ACTIVE_PROFILE_DIR);
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${dirName}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
    ], { stdio: 'ignore', timeout: 20000 });
  } catch { /* best effort */ }
  for (let i = 0; i < 3; i++) {
    try { fs.rmSync(ACTIVE_PROFILE_DIR, { recursive: true, force: true }); break; }
    catch { await new Promise(r => setTimeout(r, 700)); }
  }
}

async function main() {
  const args = parseArgs();
  if (args.help || !args.url) {
    console.log(`assisted apply runner

  --url <postingUrl>    the posting to apply to (required)
  --submit              actually submit; without it this is a dry run
  --answer "<text>"     answer for a required free-text question
  --headed              show the browser (default: headed, so you can take over)
  --batch               unattended mode: always close the browser on exit, even on a stop
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
  let uploadFailed = false;
  /* A previous run is deliberately left open on a stop, and it holds the profile
     directory. Chrome then answers "Opening in existing browser session" and
     Playwright never gets a connection. Reclaim the profile first. */
  /* One throwaway profile per run. A shared profile gets held open by the
     previous run (which is left open on purpose when it stops), and Chrome then
     answers "Opening in existing browser session" so Playwright never connects.
     Ashby, Greenhouse, Lever and Workday all serve their forms without a login,
     so there is no session worth persisting. Pass --session to reuse one. */
  const profileDir = args.session ? SESSION_DIR : `${SESSION_DIR}-${Date.now()}`;
  ACTIVE_PROFILE_DIR = profileDir;
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1360, height: 1000 },
    acceptDownloads: true,
  });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('pageerror', e => consoleErrors.push(String(e.message).slice(0, 120)));

  /* Watch the form POST's status code. Anthropic's Greenhouse board answers the
     submit with HTTP 428 (Precondition Required) -- reCAPTCHA Enterprise
     refusing an automated submission -- while the page just re-renders the job
     description with no error text at all. Without this the run reported
     "submitted-unconfirmed" and the batch retired the posting, so a wall that
     needs a human looked identical to a form the runner filled wrong. */
  const submitRejections = [];
  /* Every application POST, not only the failing ones. Clicking Submit on the
     Greenhouse iframe embedded in Instacart's careers page fires NO request at
     all -- the click is swallowed -- and the page then looks exactly like a
     silent success: form still there, no banner, no error. That reported as
     "submitted-unconfirmed", which is the state the batch retires a posting
     on. A submit that never left the browser must never be able to reach it. */
  const appPosts = [];
  page.on('response', (r) => {
    if (r.request().method() !== 'POST') return;
    const u = r.url();
    if (!/greenhouse\.io|ashbyhq\.com|lever\.co|myworkday|smartrecruiters|icims/i.test(u)) return;
    if (/snowplow|analytics|segment|sentry|recaptcha|amazonaws\.com|\/tp2/i.test(u)) return;
    appPosts.push({ status: r.status(), url: u.slice(0, 120) });
  });
  page.on('response', (r) => {
    if (r.request().method() !== 'POST') return;
    const u = r.url();
    if (/snowplow|analytics|segment|sentry|recaptcha|amazonaws\.com/i.test(u)) return;
    if (r.status() >= 400) submitRejections.push({ status: r.status(), url: u.slice(0, 120) });
  });

  /* APPLY_TRACE=1 dumps the application POST and its response. A form that
     looks complete in a screenshot and still comes back "Missing entry for
     required field" can only be told apart from a stale banner by reading what
     actually went over the wire. */
  if (process.env.APPLY_TRACE === '1') {
    page.on('request', r => {
      if (r.method() !== 'POST') return;
      console.log(`\n[trace] POST ${r.url().slice(0, 120)}\n[trace] body: ${String(r.postData() || '').slice(0, 3000)}`);
    });
    page.on('response', async r => {
      if (r.request().method() !== 'POST') return;
      const body = await r.text().catch(() => '');
      console.log(`\n[trace] <= ${r.status()} ${r.url().slice(0, 100)}\n[trace] resp: ${body.slice(0, 1500)}`);
    });
  }

  console.log(`\n=== ${args.url}`);
  console.log(`mode: ${args.submit ? 'SUBMIT' : 'DRY RUN (will not submit)'}`);

  /* Workday serves no form on the posting page at all: "Apply" opens a modal,
     the form only exists behind a candidate account, and the application is a
     4-to-7 page wizard. None of that fits the single-form path below, so the
     whole flow lives in apply/workday-drive.mjs. */
  if (/myworkdayjobs\.com/i.test(args.url)) {
    let wdBank = {};
    if (args.answers && fs.existsSync(String(args.answers))) {
      try { wdBank = JSON.parse(fs.readFileSync(String(args.answers), 'utf8')); } catch { /* keep empty */ }
    }
    const wd = await runWorkday({
      page,
      url: args.url,
      root: ROOT,
      profile,
      answerBank: wdBank,
      submit: !!args.submit,
      shot: (step) => shot(page, step),
      log,
    });
    console.log(`\nWORKDAY LOG:\n${log.filter(l => l.startsWith('wd:')).join('\n')}`);
    console.log(`
WORKDAY: ${wd.state}${wd.detail ? ' - ' + wd.detail : ''}`);
    return await finish(ctx, !!args.batch, { state: wd.state, detail: wd.detail, log });
  }

  /* Lever serves the job description and the application form at two different
     URLs. The posting page carries no inputs at all, so the runner read it as
     "this ATS needs an account or a wizard" and skipped every Lever posting in
     the queue -- 47 of them. The form lives at <posting>/apply. */
  let landing = args.url;

  /* Stripe, Samsara, Coinbase, Pinterest and Instacart all run their careers
     site as a skin over Greenhouse. Pointed at the vanity URL the runner landed
     on a marketing page with no form -- Greenhouse even 302s its own
     /<board>/jobs/<id> URL back to that same page -- so 28 queued postings
     looked unapplyable. The embed endpoint serves the real form standalone. */
  const ghForm = await greenhouseEmbedUrl(landing);
  if (ghForm) {
    /* Go to the bare embed form rather than the employer page. Both render the
       same Greenhouse application, but they do not submit the same. Clicking
       Submit inside the iframe on Instacart's careers page fires no request at
       all -- measured: zero application POSTs, RESULT submit-no-request -- while
       the same form loaded directly does POST and comes back with an answer we
       can act on (a 428 asking for the emailed security code). A stop we can
       explain beats a click that quietly does nothing. */
    landing = ghForm.url;
    console.log(`greenhouse: ${ghForm.why}`);
    console.log(`greenhouse: going to the application form at ${landing}`);
  }

  if (/jobs\.lever\.co/i.test(landing) && !/\/apply\/?$/.test(landing)) {
    landing = landing.replace(/\/+$/, '') + '/apply';
    console.log(`lever: going to the application form at ${landing}`);
  }

  /* A persistent context sometimes aborts its very first navigation while the
     profile is still warming up. One retry, then give up honestly. */
  let resp = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      resp = await page.goto(landing, { waitUntil: 'domcontentloaded', timeout: 45000 });
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
    return await finish(ctx, !!args.batch, { state: 'wall', log });
  }

  /* Workday opens a "Start Your Application" modal offering Autofill with
     Resume / Apply Manually / Use My Last Application before any form exists.
     Take the resume-autofill path; without this the runner saw a page with no
     fields and every Workday posting produced nothing. */
  for (const rx of [/autofill with resume/i, /apply manually/i]) {
    /* These are not role=button in Workday's markup, so getByRole found nothing
       and the modal stayed up. Match on visible text instead. */
    const b = page.locator('button, a, [role="button"], div[tabindex]')
      .filter({ hasText: rx }).first();
    if (await b.count().catch(() => 0) && await b.isVisible().catch(() => false)) {
      await b.click().catch(() => {});
      await page.waitForTimeout(3500);
      log.push(`workday: chose ${rx.source}`);
      break;
    }
  }

  /* Reveal the form where the ATS hides it behind an Apply button.
     SmartRecruiters does not use the word "apply" at all -- ServiceNow's
     posting offers a green "I'm interested" LINK, so a button-only search for
     /^apply$/ found nothing, the page kept its search box and cookie inputs,
     and the zero-form guard (which counts inputs, not form inputs) let the run
     report dry-run-ok having filled nothing at all. Match links too. */
  const APPLY_CTA = [/^apply for this job( online)?$/i, /^apply now$/i, /^apply( online)?$/i, /^i'?m interested$/i, /^apply for this (position|role)$/i];
  /* Search the frames as well as the top document. iCIMS puts the entire
     posting -- description, "Apply for this job online" button and all -- inside
     an icims_content_iframe, so a top-level-only search found no CTA, the page
     kept zero form fields, and five Applied Systems postings were filed as
     needing an account when the form is one click away. */
  const ctaFrames = [page, ...page.frames().filter(f => f !== page.mainFrame())];
  let clickedCta = false;
  for (const rx of APPLY_CTA) {
    for (const scope of ctaFrames) {
      const cta = scope.getByRole('button', { name: rx }).or(scope.getByRole('link', { name: rx })).first();
      if (!(await cta.count().catch(() => 0))) continue;
      if (!(await cta.isVisible().catch(() => false))) continue;
      await cta.click().catch(() => {});
      await page.waitForTimeout(3000);
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      log.push(`clicked ${rx}`);
      clickedCta = true;
      break;
    }
    if (clickedCta) break;
  }
  await shot(page, '2-form');

  /* Everything from here on operates on `target`: the real form frame when the
     employer embeds Greenhouse inside a custom careers page, otherwise `page`
     itself (the common case) - target === page then, so nothing changes for
     any posting that isn't using this pattern. */
  let target = await getFormFrame(page);

  /* Second chance at the embed form. The landing step above already redirects
     a known vanity board there, so this only fires when that lookup was
     skipped or the page turned out to carry no form after all. Pinterest and
     Samsara serve their own iframe as embed/job_app?for=<board>&validityToken
     =<...> rather than &token=<id>; both render the same application, and a
     Pinterest submit was refused the same way through either one, so the
     token is not what decides it. */
  if (ghForm) {
    const onPage = await page.locator('input,select,textarea').count().catch(() => 0);
    if (target === page && onPage < 4 && page.url() !== ghForm.url) {
      console.log(`greenhouse: no form on the employer page, falling back to ${ghForm.url}`);
      log.push('greenhouse: employer page had no form, used the embed URL');
      await page.goto(ghForm.url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      for (const rx of [/^apply for this job$/i, /^apply now$/i, /^apply$/i]) {
        const btn = page.getByRole('button', { name: rx }).first();
        if (await btn.count().catch(() => 0) && await btn.isVisible().catch(() => false)) {
          await btn.click().catch(() => {});
          await page.waitForTimeout(2500);
          break;
        }
      }
      await shot(page, '2b-embed-form');
      target = await getFormFrame(page);
    }
  }
  if (target !== page) log.push(`form lives in a nested ATS iframe: ${target.url().slice(0, 70)}`);

  // --- fill what we know ---
  const id = profile.identity;
  await fillByLabel(target, /^full name|^name$/i, id.fullName, log);
  await fillByLabel(target, /first name/i, id.firstName, log);
  await fillByLabel(target, /last name/i, id.lastName, log);
  await fillByLabel(target, /^email/i, id.email, log);
  await fillByLabel(target, /phone/i, id.phone, log);
  await fillByLabel(target, /linkedin/i, id.linkedin, log);
  await fillByLabel(target, /github/i, id.github, log);
  await fillByLabel(target, /^website|personal website|portfolio( url| link)?$|^url$|web ?site/i, id.website || id.github, log);
  /* Ashby tenants word this many ways. "Please enter your current working
     location" and "Where are you currently based?" both missed the old
     pattern and blocked several Headway and bjak postings. */
  await fillByLabel(target, /where do you (currently )?reside|current location|^location|current working location|working location|currently based|where are you based|based out of/i, id.location, log);
  await fillByLabel(target, /physical mailing address|mailing address|street address|address line ?1|^address$/i, id.mailingAddress || '', log);
  await fillByLabel(target, /^city$/i, id.city || '', log);
  await fillByLabel(target, /^state$|state \/ province|state\/province/i, id.state || '', log);
  await fillByLabel(target, /zip|postal code/i, id.postalCode || '', log);
  await fillCombo(target, /country of residence/i, id.country, log);
  await fillCombo(target, /passport country/i, id.country, log);
  await fillCombo(target, /^country/i, id.country, log);
  await fillCombo(target, /where do you (currently )?reside/i, id.country, log);
  /* Expectation questions are fine to answer. SALARY HISTORY is not: asking for
     it is unlawful in a growing number of jurisdictions, the answer can only
     anchor an offer downwards, and nothing in the profile authorises one. The
     old pattern matched a bare /salary/, so "What was your salary at your last
     employer" would have been answered with his target figure. Refuse those and
     let the run stop honestly instead. */
  await fillByLabel(target,
    /^(?!.*\b(current|previous|last|prior|most recent|history|currently (make|earn|paid))\b).*(salary|compensation expectation|expected (base )?(salary|comp)|desired (salary|compensation))/i,
    profile.compensation.answerTemplate, log);
  await fillByLabel(target, /start date|earliest.*start|available/i, profile.eligibility.earliestStart, log);
  /* Yes/No questions. Ashby renders them as a pair of buttons; Greenhouse
     renders the same questions as comboboxes. Try both for each. */
  const YESNO = [
    [/legally authorized to work/i, 'Yes'],
    [/are you (currently )?(legally )?(authorized|eligible)/i, 'Yes'],
    /* "immigration sponsorship" is the wording Affirm and Smartsheet use, and
       it matched none of the visa patterns -- thirteen postings across those two
       employers stopped on a question the profile already answers. */
    /* sponsors?hip is deliberate. Headway's own form reads "require visa
       sponsorhip", and the correct spelling matched nothing, blocking five of
       their postings. */
    /* Kraken asks "will you now or in the future NEED sponsorship", which the
       require-only pattern missed across four of their postings. */
    [/(require|need|request).{0,16}sponsors?hip|visa sponsors?hip|sponsors?hip for a visa|require employment visa|immigration sponsors?hip|sponsors?hip for (work|employment)|sponsors?hip to work/i, 'No'],
    [/non[- ]compete|post[- ]employment restriction|employment agreements|post[- ]employment,? contractual|contractual or other restrictions|restrictive covenant/i, 'No'],
    /* Relationship-to-the-employer gates. All are No for him: he has no prior
       tie to any of these companies and is not a customer or partner of one. */
    [/know any(one|body) who works at|anyone currently (working|employed) at|referred by (an|a current) employee/i, 'No'],
    [/current user of|used .{0,20}in the past 12 months|been employed by a partner or customer|customer or partner of/i, 'No'],
    /* Consent and contact-preference gates. Declining these blocks the submit
       on some boards and helps on none. */
    /* "I understand and agree that Headway may contact additional references"
       and a bare "Consent" label both blocked submits. */
    [/applicant privacy notice|privacy notice|^i consent|data privacy (policy|notice)|i understand and agree|understand and agree|^\s*consent\s*\*?\s*$/i, 'Yes'],
    [/would like to be contacted about future|future .{0,25}(employment )?opportunities|add me to .{0,20}talent/i, 'Yes'],
    /* Experience gates. Two years with the PM title plus the Amex years running
       the role as an Engineering Manager clear a 5+ bar; see narrative.local.md
       "Seniority framing". */
    [/\b5\+? (years )?of product management|5\+ years.{0,25}product/i, 'Yes'],
    /* He is in Arizona and is not entitled to work in Canada. */
    [/entitled to work in canada|authorized to work in canada|eligible to work in canada/i, 'No'],
    /* Years-of-experience gates. Two years with the Product Manager title plus
       the Oracle and American Express years running the role clear these; see
       narrative.local.md "Seniority framing". */
    [/more than \d+ years|\d+\+? years.{0,30}(experience|working)|at least \d+ years/i, 'Yes'],
    /* "Have you used OUR product" is a customer question, not an experience
       one. He has not been a customer of any of these; apply-profile.local.json
       records that explicitly for Chili Piper. */
    [/have you (used|been a user of) .{0,40}(product|platform|app)|used (our|a) .{0,25}product in the last/i, 'No'],
    /* Background-check and reference consents. Refusing these blocks the submit
       and helps on nothing. 1Password asks four postings the same question. */
    /* MeridianLink words it "I understand that as permitted by law, MeridianLink
       will conduct an investigative consumer report", and OpenAI uses "I hereby
       certify that I have not knowingly withheld". Both are attestations the
       submit will not proceed without. */
    [/offers of employment are conditional|conditional on satisfactory|background (check|screening|investigation)|investigative consumer report|consumer report|i understand that as permitted by law|i hereby certify|have not knowingly withheld|certify that .{0,40}(true|accurate|complete)/i, 'Yes'],
    /* Conflict-of-interest screens. He has no relative or partner at any of
       these companies. */
    [/close personal relationship|family members?, domestic|relative(s)? (who )?(work|employed)|conflict of interest/i, 'No'],
    /* Standard employment-history screens. */
    [/ever been fired|asked to resign|terminated for cause|dismissed from a job/i, 'No'],
    [/perform the essential functions|with or without reasonable accommodation/i, 'Yes'],
    [/legal right to work in the location|right to work in the location you indicated/i, 'Yes'],
    /* Reference-contact permissions: past employers yes, the CURRENT one no --
       he is employed at Equity Methods and has not told them he is looking. */
    [/contact your (past|previous|former) employer/i, 'Yes'],
    [/contact your current|current or most recent employer/i, 'No'],
    /* Brian's standing answers, 2026-08-24: yes to occasional onsite/travel,
       no to permanent relocation, no to prior contact with the employer. */
    /* "ever been previously employed by Spotify" matched none of the original
       alternatives -- they required the word "been" before "employed" and the
       word "ever" immediately before the verb. Cover the plain forms too. */
    [/previously,? ?(worked|applied|been employed|employed|consulted)|ever (been )?(previously )?(worked|interviewed|applied|employed)|interviewed at|employed by (us|this company)|worked at .{0,40} in the past|have you worked (at|for)/i, 'No'],
    /* "Do you live in or are you able to commute to the Kansas City metro for
       this role?" is a relocation question in disguise. He is in Arizona and
       every posting in this queue is remote. */
    [/open to relocat|willing to relocat|require relocation|able to commute to|live in or are you able to commute|commute to the .{0,30}(metro|area|office)/i, 'No'],
    /* OpenAI asks "Are you able to work from our US office three days per
       week?", which matched none of these: it says "from our US office", not
       "in the office". Brian's standing answer is yes to occasional onsite. */
    [/open to working in[- ]person|in the office|onsite|on-site|hybrid|willing to travel|open to travel|work from our .{0,20}office|able to work from (the|our)|days per week in|in[- ]office \d+ days/i, 'Yes'],
    /* Common gates seen on live Ashby/Greenhouse forms. "Are you over the age
       of 18?" blocked a Supabase submit with the resume already attached. */
    [/over the age of 18|at least 18|18 years or older|legally of age/i, 'Yes'],
    [/read and (agree|accept)|agree to the (terms|privacy)|acknowledge|i understand and agree|understand and agree|^\s*consent\s*\*?\s*$/i, 'Yes'],
    [/consent to (the )?(processing|storage|retention)|retain my (personal )?(information|data)/i, 'Yes'],
    [/currently (located|residing|living) in the united states|located in the us/i, 'Yes'],
    /* LAST RULE, so every specific rule above wins first.
       "Do you have experience with <the employer own domain>?" - Kraken asks
       about case management and account takeovers, 1Password about
       cybersecurity SaaS. No is the truthful default: the narrative covers
       fintech, payments and AI product work, and claiming a domain he has not
       owned would be a fabrication sitting in a real application. A No that
       costs a posting is a cheaper mistake than a Yes he has to walk back. */
    [/do you have (any )?(prior |direct |hands[- ]on )?experience (with|in|within|using)/i, 'No'],
  ];
  for (const [q, a] of YESNO) {
    if (await clickYesNo(target, q, a, log)) continue;
    if (await answerYesNo(target, q, a, log)) continue;
    await fillCombo(target, q, a, log);
  }

  /* A consent rendered as a SINGLE radio. Headway's "I understand and agree
     that Headway may contact additional references" is one lone
     input[type=radio] inside its field entry -- there is no Yes and no No to
     match, so every Yes/No path skipped it and the server rejected the submit
     naming that field on five of their postings. When the question reads as a
     consent and the group holds exactly one option, ticking it IS the answer. */
  /* Widened to the wordings that were blocking real submits. MeridianLink says
     "I understand that as permitted by law, MeridianLink will conduct an
     investigative consumer report" and 1Password "I understand that offers of
     employment are conditional on satisfactory...". Neither contains "I
     understand AND AGREE", so both fell through to the banner repair - and on
     Ashby a rejected submit returns a fresh FormRender that wipes the form, so
     a repair applied after a rejection is erased by the next one. These have to
     be answered BEFORE the first submit. */
  const CONSENT_Q = /i understand|understand and agree|^\s*consent\s*\*?\s*$|i acknowledge|i agree|i hereby certify|i certify|applicant privacy notice|permitted by law|conditional on satisfactory|background (check|screening)|investigative consumer report/i;
  const consents = await target.evaluate((src) => {
    const rx = new RegExp(src, 'i');
    let n = 0;
    for (const entry of document.querySelectorAll('[data-field-path], .ashby-application-form-field-entry, fieldset, li')) {
      const lab = (entry.querySelector('label')?.innerText || '').replace(/\s+/g, ' ').trim();
      if (!lab || !rx.test(lab)) continue;
      const opts = [...entry.querySelectorAll('input[type="radio"],input[type="checkbox"]')];
      if (opts.length !== 1 || opts[0].checked) continue;
      opts[0].setAttribute('data-apconsent', String(++n));
    }
    return n;
  }, CONSENT_Q.source).catch(() => 0);
  for (let i = 1; i <= consents; i++) {
    const box = target.locator(`[data-apconsent="${i}"]`).first();
    await box.check({ force: true }).catch(async () => { await box.click().catch(() => {}); });
    await page.waitForTimeout(200);
    log.push('ticked single-option consent');
  }
  if (consents) {
    await target.evaluate(() => document.querySelectorAll('[data-apconsent]')
      .forEach(e => e.removeAttribute('data-apconsent'))).catch(() => {});
  }

  /* Lever's location field is <input id="location-input" name="location"> with
     NO label element at all, so no label-based matcher reaches it, and it is
     required on every Lever posting. It is a Google-Places style typeahead: the
     typed text alone does not register, an option has to be chosen. */
  const leverLoc = target.locator('#location-input, input[name="location"]').first();
  if (await leverLoc.count().catch(() => 0) && await leverLoc.isVisible().catch(() => false)) {
    for (const attempt of [id.location, `${id.city}, ${id.state}`, id.city].filter(Boolean)) {
      await leverLoc.click().catch(() => {});
      await leverLoc.fill('').catch(() => {});
      await leverLoc.type(String(attempt), { delay: 60 }).catch(() => {});
      await page.waitForTimeout(1800);
      const opt = target.locator('[role="option"]:visible, .dropdown-location li:visible, ul[class*="location"] li:visible, li[class*="location"]:visible').first();
      if (await opt.count().catch(() => 0)) {
        const t = (await opt.innerText().catch(() => '')).trim();
        await opt.click().catch(() => {});
        log.push(`lever location = ${t.slice(0, 40)}`);
        break;
      }
      /* No popup: some tenants accept free text. Leave it typed and move on. */
      log.push(`lever location typed "${String(attempt).slice(0, 30)}" (no listbox offered)`);
      break;
    }
    await page.waitForTimeout(300);
  }

  /* Location is another unlabelled Ashby combobox. Tag it by its question text
     and drive it like any other typeahead.

     The label is NOT always the word "Location". Delinea (and every other Ashby
     tenant that turns the city field on) labels it "City, Region/State,
     Country*", which the old regex missed, so the branch never ran, the field
     stayed empty and every one of those submits came back "Missing entry for
     required field: City, Region/State, Country". Nine Delinea postings failed
     on exactly this. Match the comma-separated shape too. */
  if (await tagNear(target, /^\s*Location\s*\*?\s*$|where are you located|your location|city,\s*(region|state)|city\s*\/\s*(region|state)|city,\s*country|current working location|working location|currently based|where are you based/i,
                    'data-apply-loc', 'input[role="combobox"],input[type="text"],select')) {
    const loc = target.locator('[data-apply-loc="1"]').first();
    if (await loc.isVisible().catch(() => false)) {
      /* The option must actually name his city, state or country. Taking the
         first row blind chose "Azerbaijan" for a query naming an AZ city. */
      const OK_LOC = new RegExp(
        `(${[id.city, id.state, 'United States'].filter(Boolean)
          .map(x => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'i');
      /* City alone first: the popup is a prefix search, and a probe against the
         live Delinea form showed "<home city>" returns "<home city>, <state>,
         United States" as the active first row, while the comma-joined
         "<home city>, <state>" is not guaranteed to match anything. */
      let pickedLocation = false;
      for (const attempt of [id.city, `${id.city}, ${id.state}`, id.location, id.state, 'United States']) {
        if (!attempt) continue;
        await loc.click().catch(() => {});
        await loc.fill('').catch(() => {});
        await loc.type(String(attempt), { delay: 45 }).catch(() => {});
        await page.waitForTimeout(1500);
        const opts = target.locator('[role="option"]:visible, [role="listbox"] li:visible');
        const n = Math.min(await opts.count().catch(() => 0), 12);
        let hit = null;
        for (let k = 0; k < n; k++) {
          const t = (await opts.nth(k).innerText().catch(() => '')).trim();
          if (OK_LOC.test(t)) { hit = { el: opts.nth(k), t }; break; }
        }
        if (hit) {
          await hit.el.click().catch(() => {});
          log.push(`picked Location = ${hit.t.slice(0, 44)}`);
          pickedLocation = true;
          break;
        }
        log.push(`Location: "${attempt}" offered nothing matching his city/state/country`);
      }
      /* If no popup row ever matched, LEAVE the text in the field. The loop used
         to clear it after every failed attempt, so a plain free-text location
         box ended the run empty and the server rejected the submit naming it.
         Headway's "Please enter your current working location" is exactly that:
         it offers no list, and five of their postings failed on it. */
      if (!pickedLocation) {
        await loc.click().catch(() => {});
        await loc.fill(String(id.location || '')).catch(() => {});
        log.push(`Location: left free text "${String(id.location).slice(0, 34)}" (no list offered)`);
      }
      await page.waitForTimeout(300);
    }
  }

  /* Free-text answers come from a JSON file of {questionSubstring: answer}.
     Nothing here is generated at run time — the text is written and reviewed
     beforehand, drawn from apply/narrative.local.md and the resume. */
  if (args.answers && fs.existsSync(String(args.answers))) {
    const bank = JSON.parse(fs.readFileSync(String(args.answers), 'utf8'));
    const areas = target.locator('textarea');
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
    const ta = target.locator('textarea:visible').first();
    if (await ta.count()) { await ta.fill(String(args.answer)); log.push('filled free-text answer'); }
  }

  /* EEO. Brian's standing instruction: always take the decline option. The only
     exception he gave is veteran status, where if no decline option exists the
     answer is "not a veteran". Never guess an EEO value. */
  const eeoPicked = await target.evaluate(() => {
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
    /* Instacart asks "What is your gender or gender identity?" and Greenhouse
       hands that whole sentence over as the label, so an anchored /^gender/
       matched nothing and a required EEO combo stayed blocking. */
    [/^gender|your gender|gender identity/i, /decline to self.?identify|don'?t wish to answer|prefer not/i],
    /* Sexual-orientation self-ID is the same kind of voluntary demographic
       question and takes the same standing decline. */
    [/lgbt|sexual orientation/i, /decline to self.?identify|don'?t wish to answer|prefer not/i],
    [/hispanic|latino|ethnic|race/i, /decline to self.?identify|don'?t wish to answer|prefer not/i],
    [/disability status/i, /do ?n'?t wish to answer|decline to answer|prefer not/i],
    [/veteran status/i, /decline to self.?identify|don'?t wish to answer|prefer not|i am not a protected veteran|not a (protected )?veteran/i],
  ];
  for (const [label, want] of EEO_COMBOS) {
    const el = target.getByLabel(label).first();
    if (!(await el.count().catch(() => 0))) continue;
    if (!(await el.isVisible().catch(() => false))) continue;
    /* NEVER click a radio or checkbox here. getByLabel(/hispanic|latino/) also
       matches the "Hispanic or Latino" OPTION itself, and clicking it selected
       that race on a real Docker application. Only a combobox gets opened. */
    const kind = await el.evaluate(e => (e.tagName.toLowerCase() + ':' + (e.type || ''))).catch(() => '');
    if (/:radio|:checkbox/.test(kind)) {
      log.push(`EEO ${label.source.slice(0, 22)} = radio group, handled below`);
      continue;
    }
    await el.click().catch(() => {});
    await page.waitForTimeout(500);
    const opt = target.locator('[role="option"]:visible, [role="listbox"] li:visible')
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

  /* EEO rendered as radio groups (Docker's Ashby form). Tick only an explicit
     decline option, by exact option text. Anything else is left alone. */
  const eeoRadios = await target.evaluate(() => {
    const DECLINE = /^\s*(i )?decline to self[- ]?identify|^\s*decline to answer|^\s*i do ?n'?t wish to answer|^\s*prefer not to/i;
    const NOT_VET = /^\s*i am not a protected veteran\s*$/i;
    const done = [];
    const groups = {};
    for (const r of document.querySelectorAll('input[type=radio]')) {
      const name = r.name || (r.closest('fieldset,div')?.id || 'g');
      (groups[name] = groups[name] || []).push(r);
    }
    for (const [name, radios] of Object.entries(groups)) {
      if (radios.some(r => r.checked)) continue;
      const texts = radios.map(r => (r.closest('label')?.innerText
        || document.querySelector(`label[for="${CSS.escape(r.id)}"]`)?.innerText || '').trim());
      const ctx = (radios[0].closest('fieldset,section,div')?.innerText || '').slice(0, 300);
      const isEEO = /gender|race|ethnic|hispanic|latino|veteran|disab/i.test(ctx);
      if (!isEEO) continue;
      let i = texts.findIndex(t => DECLINE.test(t));
      if (i < 0 && /veteran/i.test(ctx)) i = texts.findIndex(t => NOT_VET.test(t));
      if (i < 0) { done.push(`${name}: no decline option, left blank`); continue; }
      radios[i].click();
      done.push(`${name}: ${texts[i].slice(0, 38)}`);
    }
    return done;
  }).catch(() => []);
  eeoRadios.forEach(r => log.push(`EEO radio ${r}`));

  /* "Where did you hear about this job?" — Brian's answer is LinkedIn, or the
     company website when LinkedIn is not offered. Radios, selects and comboboxes
     all appear for this question depending on the ATS. */
  const sourcePicked = await target.evaluate(() => {
    const Q = /where did you (hear|find|learn)|how did you (hear|find|learn)|source of (application|referral)|referral source/i;
    const WANT = [/^\s*linkedin\s*$/i, /company (website|careers)/i, /^\s*(company )?career (site|page)\s*$/i, /other online job boards?/i];
    const done = [];
    for (const s2 of document.querySelectorAll('select')) {
      const ctx = (s2.getAttribute('aria-label') || s2.closest('label,div,fieldset')?.innerText || '');
      if (!Q.test(ctx) || s2.value) continue;
      for (const w of WANT) {
        const o = [...s2.options].find(x => w.test(x.textContent.trim()));
        if (!o) continue;
        s2.value = o.value;
        s2.dispatchEvent(new Event('input', { bubbles: true }));
        s2.dispatchEvent(new Event('change', { bubbles: true }));
        done.push('select = ' + o.textContent.trim());
        break;
      }
    }
    const groups = {};
    for (const r of document.querySelectorAll('input[type=radio]')) {
      (groups[r.name || 'g'] = groups[r.name || 'g'] || []).push(r);
    }
    for (const radios of Object.values(groups)) {
      if (radios.some(r => r.checked)) continue;
      const ctx = (radios[0].closest('fieldset,section,div')?.innerText || '');
      if (!Q.test(ctx)) continue;
      const texts = radios.map(r => (r.closest('label')?.innerText
        || document.querySelector('label[for="' + CSS.escape(r.id) + '"]')?.innerText || '').trim());
      for (const w of WANT) {
        const i = texts.findIndex(t => w.test(t));
        if (i < 0) continue;
        radios[i].click();
        done.push('radio = ' + texts[i]);
        break;
      }
    }
    return done;
  }).catch(() => []);
  sourcePicked.forEach(x => log.push('found-job-via ' + x));

  /* The same question also ships as a typeahead ("How did you hear about
     Render?" — Start typing...), which neither the select nor the radio branch
     can reach. Try LinkedIn first, then a company-website style option. */
  const SOURCE_Q = /how did you hear about|where did you (hear|find) (out )?about|how did you find/i;
  /* Ashby renders this as <input role="combobox" placeholder="Start typing...">
     with no id, no name and no aria-label, so getByLabel finds nothing. Tag the
     control by walking up from the question text, then drive it normally. */
  const tagged = await target.evaluate((src) => {
    const rx = new RegExp(src, 'i');
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      if (!rx.test(n.textContent)) continue;
      let el = n.parentElement;
      for (let up = 0; up < 4 && el; up++) {
        const c = el.querySelector('input[role="combobox"],input[type="text"],select');
        if (c) { c.setAttribute('data-apply-source', '1'); return true; }
        el = el.parentElement;
      }
    }
    return false;
  }, SOURCE_Q.source).catch(() => false);

  const sourceBox = tagged
    ? target.locator('[data-apply-source="1"]').first()
    : target.getByLabel(SOURCE_Q).first();
  if (await sourceBox.count().catch(() => 0) && await sourceBox.isVisible().catch(() => false)) {
    const kind = await sourceBox.evaluate(e => e.tagName.toLowerCase() + ':' + (e.type || '')).catch(() => '');
    if (!/:radio|:checkbox/.test(kind)) {
      let done = false;
      for (const opt of ['LinkedIn', 'Company website', 'Company Website', 'Career site', 'Job board', 'Other']) {
        await sourceBox.click().catch(() => {});
        await sourceBox.fill('').catch(() => {});
        await sourceBox.type(opt, { delay: 40 }).catch(() => {});
        await page.waitForTimeout(1400);
        const hit = target.locator('[role="option"]:visible, [role="listbox"] li:visible')
          .filter({ hasText: new RegExp(opt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }).first();
        if (await hit.count().catch(() => 0)) {
          await hit.click().catch(() => {});
          log.push(`found-job-via typeahead = ${opt}`);
          done = true;
          break;
        }
      }
      if (!done) {
        await sourceBox.fill('').catch(() => {});
        log.push('found-job-via typeahead = NO MATCHING OPTION');
      }
      await page.waitForTimeout(300);
    }
  }

  /* Consent questions are not EEO and are not mine to answer. */
  const consent = await target.evaluate(() => {
    const out = [];
    for (const r of document.querySelectorAll('input[type=radio],input[type=checkbox]')) {
      const ctx = (r.closest('fieldset,section,div')?.innerText || '').slice(0, 200);
      if (!/recording consent|consent to be recorded|record(ed|ing) (of )?interview/i.test(ctx)) continue;
      const grp = [...document.querySelectorAll(`input[name="${CSS.escape(r.name)}"]`)];
      if (grp.some(x => x.checked)) continue;
      out.push(ctx.replace(/\s+/g, ' ').slice(0, 90));
    }
    return [...new Set(out)];
  }).catch(() => []);
  if (consent.length) {
    /* Brian chose YES on 2026-08-24. The answer comes from his profile, not
       from a default baked into this file, so changing it is a one-line edit. */
    const want = String((profile.consent && profile.consent.interviewRecording) || '').toUpperCase();
    if (want !== 'YES' && want !== 'NO') {
      console.log('\nSTOP: this form asks for interview-recording consent and the profile has no answer.');
      consent.forEach(c => console.log('      ', c));
      await shot(page, 'stop-consent');
      return await finish(ctx, !!args.batch, { state: 'needs-consent-decision', consent, log });
    }
    const picked = await target.evaluate((yes) => {
      const YES = /^\s*yes[,.]?\s*i consent|^\s*i consent|^\s*yes\s*$/i;
      const NO = /opt out of recording|do not consent|^\s*no\s*$/i;
      const out = [];
      for (const r of document.querySelectorAll('input[type=radio]')) {
        const ctx = (r.closest('fieldset,section,div')?.innerText || '');
        if (!/recording consent|consent to be recorded|record(ed|ing) (of )?interview/i.test(ctx)) continue;
        const grp = [...document.querySelectorAll(`input[name="${CSS.escape(r.name)}"]`)];
        if (grp.some(x => x.checked)) continue;
        const texts = grp.map(x => (x.closest('label')?.innerText
          || document.querySelector(`label[for="${CSS.escape(x.id)}"]`)?.innerText || '').trim());
        const i = texts.findIndex(t => (yes ? YES : NO).test(t));
        if (i < 0) continue;
        grp[i].click();
        out.push(texts[i].slice(0, 44));
      }
      return [...new Set(out)];
    }, want === 'YES').catch(() => []);
    picked.forEach(x => log.push(`recording consent = ${x}`));
    if (!picked.length) {
      console.log('\nSTOP: recording-consent question present but no option matched the profile answer.');
      await shot(page, 'stop-consent');
      return await finish(ctx, !!args.batch, { state: 'needs-consent-decision', consent, log });
    }
  }

  // hard stop: can they even hire someone in Arizona?
  const loc = await locationEligibility(target);
  if (loc.restricted) {
    console.log('\nSTOP: this employer\'s residency list does not include Arizona or a US-wide option.');
    console.log('      offered:', loc.options.slice(0, 12).join(' | '));
    console.log('      Applying would be rejected on location. Not submitting.');
    await shot(page, 'stop-location-ineligible');
    return await finish(ctx, !!args.batch, { state: 'location-ineligible', options: loc.options, log });
  }

  /* Resume, and the resume again where a cover letter upload is mandatory.
     Under parallel load these uploads FAIL: Ashby showed "<resume file>
     _August.pdf failed to upload" and then "We couldn't submit your
     application - There was a problem with the network connection." The submit
     was clicked on a form with no resume attached, so it never went through.
     Attach, then verify the upload actually landed, and retry before trusting it. */
  const files = target.locator('input[type=file]');
  const nFiles = await files.count();
  for (let i = 0; i < nFiles; i++) {
    const f = files.nth(i);
    let ok = false;
    /* Five attempts with a growing pause. Ashby drops the upload under parallel
       load, and three quick tries were not enough to ride that out -- five
       postings in one run reached the submit gate with no resume attached. */
    for (let attempt = 1; attempt <= 5 && !ok; attempt++) {
      await f.setInputFiles(resume).catch(() => {});
      await page.waitForTimeout(1500 + attempt * 900);
      /* Greenhouse REPLACES the <input type=file> with an "attached" widget
         the moment the upload lands, so evaluating on the input throws a
         detached-element timeout and the old catch turned that into
         present:false. A SUCCESSFUL upload was therefore recorded as "RESUME
         UPLOAD FAILED", which sets uploadFailed and makes the runner refuse to
         submit -- that alone blocked the Anthropic form. Verify against the
         page, which survives the swap, and treat a vanished input as the
         success signal it actually is.

         The old test also carried a literal 0x08 where a \b was meant, so its
         filename branch could never match and it leaned entirely on
         el.files.length -- unreadable once the element detached. */
      const resumeName = path.basename(resume);
      const status = await target.evaluate((name) => {
        const txt = document.body ? document.body.innerText : '';
        return {
          failed: /failed to upload|upload failed|could not upload/i.test(txt),
          present: txt.includes(name) || /\.(pdf|docx?|rtf|txt)/i.test(txt),
        };
      }, resumeName).catch(() => ({ failed: false, present: false }));
      if (!status.present && !(await f.count().catch(() => 1))) status.present = true;
      if (status.present && !status.failed) { ok = true; break; }
      if (attempt < 5) {
        log.push(`resume upload attempt ${attempt} failed on input ${i}, retrying`);
        await page.waitForTimeout(2000 + attempt * 1200);
      }
    }
    log.push(ok ? `attached resume to file input ${i}` : `RESUME UPLOAD FAILED on input ${i}`);
    if (!ok) uploadFailed = true;
  }

  /* If the page exposed no editable fields at all, this ATS needs a flow the
     runner does not implement (Workday opens a modal, then requires an account
     and a multi-page wizard). Record that distinctly instead of falling through
     to a meaningless "no submit button". */
  const fieldCount = await target.locator('input:not([type=hidden]), textarea, select').count().catch(() => 0);
  if (fieldCount === 0) {
    /* A wall put up AFTER the apply click looked identical to an ATS that
       wants an account. SmartRecruiters answers "I'm interested" with a slider
       captcha ("Verification Required" / "Slide right to secure your access"),
       and filing that as needs-account-or-wizard mixes a gate nobody can pass
       in with gates a human can. Re-check the wall here, on the page we ended
       up on, not only on the one we landed on. */
    const postApply = await stopCheck(page);
    const framed = await wallInAnyFrame(page);
    if (framed) log.push(`bot-check: ${framed}`);
    if (postApply.wall || postApply.captcha || framed) {
      console.log(`
STOP: a bot-check wall stands where the application form should be. Not an account gate - nothing here can be filled in.`);
      await shot(page, 'stop-wall-after-apply');
      return await finish(ctx, !!args.batch, { state: 'wall', log });
    }
    console.log(`
STOP: no application form on this page (${fieldCount} fields). This ATS needs an account or a multi-step flow.`);
    await shot(page, 'stop-no-form');
    return await finish(ctx, !!args.batch, { state: 'needs-account-or-wizard', log });
  }

  await shot(page, '3-filled');

  /* Ashby re-renders the form when a combobox selection lands, and that wiped
     an already-filled Email on the Render posting. Top up the plain text fields
     after every widget has settled, filling only the ones that came back empty. */
  await page.waitForTimeout(600);
  const topUps = [
    [/^full name|^name$/i, id.fullName],
    [/first name/i, id.firstName],
    [/last name/i, id.lastName],
    [/^email/i, id.email],
    [/phone/i, id.phone],
    [/linkedin/i, id.linkedin],
    [/github/i, id.github],
    [/^website|personal website|portfolio( url| link)?$/i, id.website || id.github],
    [/physical mailing address|mailing address|street address/i, id.mailingAddress || ''],
  ];
  for (const [label, value] of topUps) {
    if (!value) continue;
    const el = target.getByLabel(label).first();
    if (!(await el.count().catch(() => 0))) continue;
    if (!(await el.isVisible().catch(() => false))) continue;
    const cur = await el.inputValue().catch(() => 'x');
    if (String(cur).trim()) continue;
    await el.fill(String(value)).catch(() => {});
    log.push(`re-filled ${label.source.slice(0, 26)} (was cleared by a re-render)`);
  }

  /* Combobox selections re-render the form and drop earlier answers, so the
     Yes/No questions get asserted again here, after every widget has settled.
     clickYesNo skips any group that already shows a selection. */
  for (const [q, a] of YESNO) {
    await clickYesNo(target, q, a, log);
  }
  await page.waitForTimeout(400);

  const VALUE_MAP = [
    [/preferred (first )?name|^name$|full( legal)? name|legal name/i, id.fullName],
    [/first name/i, id.firstName],
    [/last name|surname|family name/i, id.lastName],
    [/e-?mail/i, id.email],
    [/phone|mobile|telephone/i, id.phone],
    [/linkedin/i, id.linkedin],
    [/github/i, id.github],
    [/website|portfolio|personal (site|url)/i, id.website || id.github],
    [/city/i, id.city],
    [/state|province/i, id.state],
    [/zip|postal/i, id.postalCode],
    [/country|where .*(work|based|located)|working (from|location)/i, id.country],
    [/current[\/\s].{0,20}(job )?title|current role|most recent (job )?title|present title/i, 'Senior Product Manager'],
    [/current[\/\s].{0,20}(company|employer)|most recent (company|employer)|previous employer|present employer/i, 'Equity Methods'],
    [/pronouns/i, 'He/Him'],
    [/desired .*salary|salary .*range|compensation/i, profile.compensation.answerTemplate],
    [/(street|mailing|physical) address|address line/i, id.mailingAddress],
    [/nationality|citizenship/i, 'United States'],
    [/years of (relevant )?experience|how many years/i, '18'],
    [/notice period|when can you start|availability|earliest start/i, 'Immediately'],
    [/how did you hear|where did you (hear|find)/i, 'LinkedIn'],
    /* Ashby's own wording for the same two fields, read off the 1Password form
       that rejected the submit twice: the banner named "Current Location" and
       "What brought you to this job posting" and neither matched any pattern
       here, so the repair loop had nothing to type. Both are typeaheads. */
    [/current location|where are you located|your location/i, id.city + ', ' + id.state],
    [/what brought you to this (job )?posting|how did you find this (job|role|posting)/i, 'LinkedIn'],
    /* Yes/No policy questions. Ashby renders these as button pairs (handled by
       clickYesNo) but Greenhouse renders the very same questions as unlabelled
       comboboxes, which no label-based matcher can reach. Answering them here
       by question text is what unblocked Anthropic. */
    [/require .{0,14}sponsors?hip|sponsors?hip to work|visa sponsors?hip|immigration sponsors?hip/i, 'No'],
    [/legally authorized|authorized to work|eligible to work/i, 'Yes'],
    [/open to relocat|willing to relocat/i, 'No'],
    [/open to working in[- ]person|in one of our offices|onsite|on-site|hybrid|willing to travel/i, 'Yes'],
    [/ever interviewed|previously (worked|applied|interviewed)|interviewed at|worked at .{0,40} in the past|have you worked (at|for)/i, 'No'],
    [/non[- ]compete|post[- ]employment restriction|employment agreement/i, 'No'],
    [/over the age of 18|at least 18|18 years or older/i, 'Yes'],
    [/read and (agree|accept)|agree to the (terms|privacy)|acknowledge/i, 'Yes'],
    [/consent to (the )?(processing|storage|retention)|retain my (personal )?(information|data)/i, 'Yes'],
    [/currently (located|residing|living) in the united states|located in the us/i, 'Yes'],
    /* LAST RULE, so every specific rule above wins first.
       "Do you have experience with <the employer own domain>?" - Kraken asks
       about case management and account takeovers, 1Password about
       cybersecurity SaaS. No is the truthful default: the narrative covers
       fintech, payments and AI product work, and claiming a domain he has not
       owned would be a fabrication sitting in a real application. A No that
       costs a posting is a cheaper mistake than a Yes he has to walk back. */
    [/do you have (any )?(prior |direct |hands[- ]on )?experience (with|in|within|using)/i, 'No'],
  ];

  /* Long-form questions still unanswered get one more pass against the answer
     bank, matched on the question text rather than on the element being a
     <textarea>. Anthropic's "AI Policy for Application" is a plain text input,
     so the textarea-only pass above never saw it. */
  let answerBank = {};
  if (args.answers && fs.existsSync(String(args.answers))) {
    try { answerBank = JSON.parse(fs.readFileSync(String(args.answers), 'utf8')); } catch { /* keep empty */ }
  }

  await page.waitForTimeout(700);
  await shot(page, '3b-topped-up');

  /* The blocking scan, as a reusable function. It tags every field it reports
     with data-apblock so the resolver below can act on exactly the controls
     that would stop the submit - an earlier version used its own separate
     detection and found 0 fields while this scan found several, so nothing
     ever got auto-filled. */
  const scanUnanswered = () => target.evaluate(() => {
    const out = [];
    document.querySelectorAll('[data-apblock]').forEach(e => e.removeAttribute('data-apblock'));
    let seq = 0;
    for (const e of document.querySelectorAll('input,select,textarea')) {
      if (['hidden', 'submit', 'button'].includes(e.type)) continue;
      /* Greenhouse renders every custom question as a PAIR: the real
         input[role="combobox"] carrying id="question_<n>", and a second bare
         <input> with no id, no name and no label association sitting in the
         same container. The scan counted that decoy as its own required field,
         could match no answer to it because it has no label, and reported it as
         "(unlabelled)". Fifteen of those across the overnight run blocked forms
         whose questions were in fact all answered -- Anthropic stopped on four
         "blockers" of which three were already filled and the fourth was this
         phantom. Skip a nameless input that shares a container with a real
         combobox. */
      if (e.tagName === 'INPUT' && !e.id && !e.name && e.getAttribute('role') !== 'combobox') {
        const box = e.closest('div,fieldset,li');
        if (box && box.querySelector('input[role="combobox"],select')) continue;
      }
      /* Ashby marks some required fields only with an asterisk in the label,
         with no required or aria-required attribute. Delinea's "City,
         Region/State, Country*" is one, so the scan never reported it and
         the server rejected the submit for that exact field. */
      const labelBox = e.closest('div,fieldset,li');
      const labelTxt = labelBox ? (labelBox.innerText || '').slice(0, 160) : '';
      const req = e.required || e.getAttribute('aria-required') === 'true' || /\*/.test(labelTxt);
      if (!req) continue;
      let empty;
      if (e.type === 'radio') {
        /* A radio GROUP is one question. Testing each option on its own made
           every unselected option its own "required and empty" field, and the
           label walk then named it after the option rather than the question --
           which is why Lever postings reported blockers reading "Yes", "Yes",
           "No" and "I confirm". The group is answered when ANY member is
           checked. */
        const group = e.name
          ? [...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(e.name)}"]`)]
          : [e];
        if (group.some(g => g.checked)) continue;
        /* Report the group once, on its first member. */
        if (e.name && group[0] !== e) continue;
        empty = true;
      } else if (e.type === 'checkbox') {
        /* Lever renders a single-choice question as CHECKBOXES sharing one name
           -- cards[<uuid>][field0] repeated per option. Treated individually,
           every unticked option became its own blocker named after the option,
           which is where "No", "Yes - Intern" and "Yes - Full Time Employment"
           came from on the Spotify form. Group them the same way as radios. */
        const siblings = e.name
          ? [...document.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(e.name)}"]`)]
          : [e];
        if (siblings.length > 1) {
          if (siblings.some(g => g.checked)) continue;
          if (siblings[0] !== e) continue;
        }
        empty = !e.checked;
      } else if (e.type === 'file') {
        /* Ashby swaps the native input for its own widget and clears .value once
           the upload lands, so .value is NOT evidence the file is missing. Trust
           the rendered filename near the control instead. */
        const box = e.closest('div,fieldset,section') || e.parentElement;
        empty = !(e.files && e.files.length) && !/\.(pdf|docx?|rtf|txt)\b/i.test(box ? box.innerText : '');
      } else {
        empty = !String(e.value || '').trim();
        /* Greenhouse's react-select keeps the input's .value blank even after a
           real selection, and stamps the choice on the wrapper instead:
           select__value-container--has-value, whose text is the chosen option.
           Probing Anthropic's "Do you require visa sponsorship?" showed .value
           still "" straight after clicking No in the listbox. Without this the
           scan called five answered questions empty, the resolver then typed
           over each one with a plain fill() -- which clears a react-select --
           and the run stopped on questions it had already answered correctly. */
        if (empty) {
          const vc = e.closest('.select__value-container');
          if (vc && vc.className.includes('--has-value') && (vc.innerText || '').trim()) empty = false;
        }
        if (empty) {
          /* Greenhouse and Ashby both back a custom combobox with a hidden
             native input they leave blank. The rendered control is the truth.
             Without this, four already-answered GitLab questions reported as
             missing and the run refused to submit a complete form. */
          const box = e.closest('[class*="select"],[class*="combobox"],[role="combobox"],div');
          const combo = e.getAttribute('aria-controls') || e.getAttribute('aria-owns');
          const live = combo ? document.getElementById(combo) : null;
          /* Only a genuinely SELECTED control counts as answered. The old test
             looked for the words yes/no near the field, which is true of every
             UNSELECTED button pair, so a form wiped by a re-render still scanned
             as complete and the runner clicked submit on an empty form. */
          /* Restrict the "already selected" rescue to genuine BUTTON/RADIO
             groups. Applying it to comboboxes marked them filled whenever the
             popup list happened to have a highlighted (aria-selected) row, so
             Delinea's "City, Region/State, Country" scanned as complete and the
             server rejected the submit for exactly that field. A combobox is
             only answered when its own input carries a value. */
          const isChoiceGroup = !!(box && box.querySelector('button,[role="radio"],input[type="radio"],input[type="checkbox"]'))
            && e.getAttribute('role') !== 'combobox' && e.tagName !== 'SELECT';
          if (isChoiceGroup && box.querySelector('[aria-pressed="true"],[aria-checked="true"],[data-state="checked"],input:checked')) empty = false;
          /* aria-controls on a combobox points at its POPUP, not at a rendered
             answer. While the list is open that popup holds every option, so
             this rescue marked an untouched dropdown as answered: Instacart's
             required "How many years experience do you have in building ads
             products?" scanned as complete with "Select..." still showing, and
             the run reported 0 blocking on a form Greenhouse would have
             rejected. Accept the referenced node only when it is not the
             option list. */
          const livePopup = !!live && (live.getAttribute('role') === 'listbox'
            || !!live.querySelector('[role="option"]'));
          if (live && !livePopup && live.textContent.trim()) empty = false;
        }
      }
      if (!empty) continue;
      /* For a radio the nearest label is the OPTION ("Yes"), never the question,
         so prefer the group's own heading: a fieldset legend, or the first label
         in the container that is not one of the options. Naming the field "Yes"
         made it unanswerable -- no matcher can map an answer onto that. */
      let groupLab = '';
      if (e.type === 'radio' || (e.type === 'checkbox' && e.name
        && document.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(e.name)}"]`).length > 1)) {
        const fs = e.closest('fieldset');
        const legend = fs?.querySelector('legend')?.innerText;
        const wrap = e.closest('[class*="application-question"],[class*="question"],fieldset,li,div');
        const heading = wrap
          ? [...wrap.querySelectorAll('label,legend,.application-label,[class*="label"]')]
            .map(x => (x.innerText || '').replace(/\s+/g, ' ').trim())
            .find(t => t.length > 3 && !/^(yes|no|i confirm|n\/?a)$/i.test(t))
          : '';
        /* Lever keeps the question as a bare text node inside
           li.application-question and puts only the options in
           .application-field, so no label element holds it. Take the container
           text and subtract the options: "Have you ever been previously
           employed by Spotify? No Yes - Intern Yes - Full Time Employment"
           becomes the question alone, which the Yes/No table can then match. */
        let stripped = '';
        const q = e.closest('[class*="application-question"]');
        if (q) {
          const optText = [...q.querySelectorAll('input[type="checkbox"],input[type="radio"]')]
            .map(i => (i.closest('label')?.innerText || '').replace(/\s+/g, ' ').trim())
            .filter(Boolean);
          stripped = (q.innerText || '').replace(/\s+/g, ' ').trim();
          for (const o of optText) stripped = stripped.split(o).join(' ');
          stripped = stripped.replace(/\s+/g, ' ').trim();
        }
        groupLab = legend || (stripped.length > 3 ? stripped : '') || heading || '';
      }
      const lab = groupLab
        || e.getAttribute('aria-label')
        || (e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`)?.innerText)
        || e.closest('label')?.innerText || e.name || '(unlabelled)';
      const key = 'apb-' + (seq++);
      e.setAttribute('data-apblock', key);
      const box = e.closest('div,fieldset,li') || e.parentElement;
      out.push({
        key,
        label: String(lab).replace(/\s+/g, ' ').slice(0, 90),
        question: (box ? box.innerText : '').replace(/\s+/g, ' ').trim().slice(0, 140),
        isCombo: e.getAttribute('role') === 'combobox' || e.tagName === 'SELECT',
        isText: e.tagName === 'TEXTAREA' || e.type === 'text' || e.type === 'tel' || e.type === 'email' || e.type === 'url'
      });
    }
    return out;
  });
  let unansweredFields = await scanUnanswered();

  /* Resolve whatever we can from the profile and the answer bank, then rescan.
     Runs against the tagged blocking fields so it sees exactly what the submit
     gate sees. Up to three passes because filling one control can re-render the
     form and reveal or clear another. */
  for (let pass = 1; pass <= 3 && unansweredFields.length; pass++) {
    let filledAny = false;
    for (const f of unansweredFields) {
      const hay = `${f.label} ${f.question}`;
      /* A grouped choice is answered by TICKING an option, not by typing into
         it. The resolver used to fill() the checkbox, which does nothing, so
         Lever's "Have you ever been previously employed by Spotify?" stayed
         blocking forever. Match the question against the Yes/No table, then
         click the option whose own label matches that answer -- preferring an
         exact match so "No" never selects "Yes - Full Time Employment". */
      const yn = YESNO.find(([rx]) => rx.test(hay));
      if (yn) {
        const want = String(yn[1]);
        const picked = await target.evaluate(({ key, want: w }) => {
          const el = document.querySelector(`[data-apblock="${key}"]`);
          if (!el || !/^(checkbox|radio)$/.test(el.type)) return null;
          const group = el.name
            ? [...document.querySelectorAll(`input[type="${el.type}"][name="${CSS.escape(el.name)}"]`)]
            : [el];
          const textOf = (i) => (i.closest('label')?.innerText || '').replace(/\s+/g, ' ').trim();
          const exact = group.find(i => textOf(i).toLowerCase() === w.toLowerCase());
          const loose = group.find(i => new RegExp(`^${w}\\b`, 'i').test(textOf(i)));
          const target2 = exact || loose;
          if (!target2) return null;
          target2.setAttribute('data-apclick', '1');
          return textOf(target2);
        }, { key: f.key, want }).catch(() => null);
        if (picked) {
          await target.locator('[data-apclick="1"]').first().click().catch(() => {});
          await target.evaluate(() => document.querySelectorAll('[data-apclick]')
            .forEach(x => x.removeAttribute('data-apclick'))).catch(() => {});
          log.push(`ticked "${f.label.slice(0, 40)}" = ${picked.slice(0, 30)}`);
          filledAny = true;
          await page.waitForTimeout(250);
          continue;
        }
      }
      const hit = VALUE_MAP.find(([rx]) => rx.test(hay));
      const bankKey = hit ? null : Object.keys(answerBank)
        .filter(k => !k.startsWith('_'))
        .sort((a, b) => b.length - a.length)
        .find(k => hay.toLowerCase().includes(k.toLowerCase()));
      if (!hit && !bankKey) continue;
      const value = String(hit ? hit[1] : answerBank[bankKey] || '');
      if (!value) continue;

      const el = target.locator(`[data-apblock="${f.key}"]`).first();
      if (!(await el.count().catch(() => 0))) continue;

      /* A blocking file input means an earlier interaction re-rendered the form
         and dropped the upload - clicking Supabase's "over 18" question wiped
         Email, Resume, Github and LinkedIn all at once. Re-attach rather than
         submitting a form with no resume on it. */
      const isFile = await el.evaluate(e => e.type === 'file').catch(() => false);
      if (isFile) {
        await el.setInputFiles(resume).catch(() => {});
        await page.waitForTimeout(1200);
        log.push(`re-attached resume to "${f.label.slice(0, 30)}" after a re-render`);
        filledAny = true;
        continue;
      }

      if (!(await el.isVisible().catch(() => false))) continue;

      /* Pass 1 uses the plain text fill. If a field is STILL blocking on a
         later pass, it is a custom dropdown wearing a plain <input> - typing
         into it never commits a value - so escalate to click/type/pick.
         Anthropic's sponsorship and relocation questions are exactly this. */
      if (f.isCombo || pass > 1) {
        await el.click().catch(() => {});
        await el.fill('').catch(() => {});
        await el.type(value, { delay: 30 }).catch(() => {});
        await page.waitForTimeout(1400);
        const opts = target.locator('[role="option"]:visible, [role="listbox"] li:visible');
        const n = Math.min(await opts.count().catch(() => 0), 10);
        let picked = false;
        const needle = escapeRx(value.split(',')[0]);
        for (let k = 0; k < n; k++) {
          const t = (await opts.nth(k).innerText().catch(() => '')).trim();
          if (t && new RegExp(needle, 'i').test(t)) {
            await opts.nth(k).click().catch(() => {});
            log.push(`auto: "${f.label.slice(0, 34)}" = ${t.slice(0, 30)}`);
            picked = true; filledAny = true;
            break;
          }
        }
        if (!picked) await el.fill('').catch(() => {});
      } else {
        await el.fill(value).catch(() => {});
        log.push(`auto: "${f.label.slice(0, 34)}" = ${value.slice(0, 30)}`);
        filledAny = true;
      }
      await page.waitForTimeout(180);
    }
    if (!filledAny) break;
    await page.waitForTimeout(500);
    unansweredFields = await scanUnanswered();
    console.log(`  [resolver pass ${pass}] ${unansweredFields.length} still blocking`);
  }

  const unanswered = unansweredFields.map(f => f.label);

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

  /* The 3b screenshot is taken BEFORE the resolver runs, so on a dry run the
     only picture of the form was one that still had empty required fields in
     it. Anything read off that image describes a state the run had already
     moved past. Capture the settled form as well. */
  await shot(page, '4-resolved');

  const post = await stopCheck(target);
  console.log('\nfilled:');
  log.forEach(l => console.log('  -', l));
  console.log('\nstill required and empty:');
  if (!unanswered.length) console.log('  (none)');
  unanswered.forEach(u => console.log('  !', u));
  console.log(`\ncaptcha visible: ${post.captcha}   wall: ${post.wall}   pageerrors: ${consoleErrors.length}`);

  if (post.captcha) {
    console.log('\nSTOP: an interactive captcha is on the form. Not submitting. Browser left open — your turn.');
    await shot(page, 'stop-captcha');
    return await finish(ctx, !!args.batch, { state: 'captcha', unanswered, log });
  }
  /* The client-side scan is NOT the authority on whether the form is complete.
     It over-reports: a react-select holding a value keeps its input blank, a
     Greenhouse question ships a phantom second input, an Ashby file widget
     clears .value once the upload lands. In one day it stopped 39 postings
     before they ever reached the submit button, ten of them over a single
     supposed blocker, and several of those fields were already answered.

     The rejection banner names the missing fields exactly, and a rejected
     submit creates nothing: the server answers with errorMessages and no
     application. So attempt the submit and let the form arbitrate. The loop
     below repairs whatever the banner names and resubmits, and still reports
     needs-input when it cannot.

     APPLY_STRICT=1 restores the old refuse-to-try behaviour. */
  if (stillMissing.length) {
    if (process.env.APPLY_STRICT === '1') {
      console.log('\nSTOP: required fields this profile has no answer for. Not submitting.');
      await shot(page, 'stop-unanswered');
      return await finish(ctx, !!args.batch, { state: 'needs-input', unanswered: stillMissing, log });
    }
    console.log('\n' + stillMissing.length + ' field(s) still scan as empty. Submitting anyway and letting the form decide:');
    stillMissing.slice(0, 6).forEach(u => console.log('  ?', u));
    await shot(page, 'stop-unanswered');
  }
  if (!args.submit) {
    /* "0 required fields still empty" is also what a page with no form at all
       looks like. ServiceNow's SmartRecruiters posting reported dry-run-ok
       with an empty fill log, because the input count that guards this counts
       every input on the page -- a search box and a cookie toggle are enough
       to clear it. A run that put no value anywhere has not filled a form. */
    const wroteSomething = log.some(l => /^(filled|picked|typed|ticked|attached|auto:|EEO )/.test(l));
    if (!wroteSomething) {
      console.log('\nSTOP: nothing was filled in. There is no application form here, only page furniture.');
      await shot(page, 'stop-empty-fill');
      return await finish(ctx, !!args.batch, { state: 'needs-account-or-wizard', log });
    }
    console.log('\nDRY RUN complete — form is filled and NOT submitted. Re-run with --submit to send it.');
    return await finish(ctx, !!args.batch, { state: 'dry-run-ok', unanswered, log });
  }

  /* Never click submit on a form whose resume did not upload - that is exactly
     how five applications were "submitted" into a network error. */
  if (uploadFailed) {
    console.log('\nSTOP: the resume failed to upload after 3 attempts. Not submitting.');
    await shot(page, 'stop-upload-failed');
    return await finish(ctx, !!args.batch, { state: 'upload-failed', log });
  }

  const submit = target.getByRole('button', { name: /submit application|^submit$|send application/i }).first();
  if (!(await submit.count())) {
    console.log('\nSTOP: no submit button found. Not submitting.');
    await shot(page, 'stop-nosubmit');
    return await finish(ctx, !!args.batch, { state: 'no-submit-button', log });
  }
  /* Submit, then let the FORM tell us what is missing rather than trying to
     predict it. Five different attempts at detecting required fields client
     side each failed on a new widget shape (asterisk-only labels, comboboxes
     with highlighted-but-unselected rows, hidden inputs behind custom
     dropdowns). The rejection banner names the exact fields, so use that as
     ground truth: fill what it names, resubmit, up to three rounds. */
  const readBanner = async () => target.evaluate(() => {
    const txt = (document.body ? document.body.innerText : '');
    const out = [];
    const re = new RegExp('Missing entry for required field:' + String.fromCharCode(92) + 's*(['
      + '^' + String.fromCharCode(92) + 'n]{1,80})', 'gi');
    let m;
    while ((m = re.exec(txt))) out.push(m[1].trim());
    return [...new Set(out)];
  }).catch(() => []);

  /* Ashby's Yes/No is a pair of <button data-option="yes|no" aria-pressed> with
     a decoy hidden checkbox that stays unchecked either way. Probing the live
     Delinea form showed a single Playwright click does set aria-pressed="true",
     but the resume-autofill re-render silently drops it again, and the banner
     repair below only ever knew how to drive input/select/textarea/combobox --
     so a dropped Yes/No answer reported "none of the named fields could be
     answered from the profile" and the run stopped one field short. Read the
     buttons directly, and repair them the same way. */
  const readYesNoState = async () => target.evaluate(() => {
    const out = [];
    for (const g of document.querySelectorAll('.ashby-application-form-input-yesno, [class*="yesno"]')) {
      const btns = [...g.querySelectorAll('button[data-option]')];
      if (btns.length !== 2) continue;
      const entry = g.closest('[data-field-path]') || g.parentElement;
      const lab = entry ? (entry.querySelector('label')?.innerText || '').replace(/\s+/g, ' ').trim() : '';
      const on = btns.find(b => b.getAttribute('aria-pressed') === 'true');
      out.push({ label: lab.slice(0, 70), answer: on ? on.dataset.option : null });
    }
    return out;
  }).catch(() => []);

  /**
   * Click the yes/no button under the label the rejection banner named.
   * @param {string} label banner field name
   * @param {string} answer 'yes' or 'no'
   * @returns {Promise<boolean>} whether a button was pressed
   */
  const repairYesNo = async (label, answer) => {
    const ok = await target.evaluate(({ label: lab, answer: ans }) => {
      const norm = (t) => (t || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const want = norm(lab).replace(/\*$/, '');
      for (const g of document.querySelectorAll('.ashby-application-form-input-yesno, [class*="yesno"]')) {
        const btns = [...g.querySelectorAll('button[data-option]')];
        if (btns.length !== 2) continue;
        const entry = g.closest('[data-field-path]') || g.parentElement;
        const text = norm(entry ? entry.querySelector('label')?.innerText : '');
        if (!text || (!text.includes(want) && !want.includes(text.slice(0, 40)))) continue;
        const btn = btns.find(b => b.dataset.option === ans);
        if (!btn) continue;
        btn.setAttribute('data-yn-fix', '1');
        const other = btns.find(b => b !== btn);
        if (other) other.setAttribute('data-yn-other', '1');
        return true;
      }
      return false;
    }, { label, answer }).catch(() => false);
    if (!ok) return false;
    const btn = target.locator('[data-yn-fix="1"]').first();
    /* If the wanted option is ALREADY pressed, clicking it again toggles it
       OFF. That is why six Delinea submits failed: the banner named the
       sponsorship question, the form showed "No" selected, this re-clicked
       "No", the answer came off, and the next submit was rejected for the same
       field. Ashby's validator wants a real state CHANGE, so go via the other
       option and come back -- that fires the events it is listening for. */
    const already = (await btn.getAttribute('aria-pressed').catch(() => null)) === 'true';
    if (already) {
      const other = target.locator('[data-yn-other="1"]').first();
      if (await other.count().catch(() => 0)) {
        await other.click().catch(() => {});
        await page.waitForTimeout(350);
      }
    }
    await btn.click().catch(() => {});
    await page.waitForTimeout(500);
    const pressed = await btn.getAttribute('aria-pressed').catch(() => null);
    await target.evaluate(() => document.querySelectorAll('[data-yn-fix],[data-yn-other]')
      .forEach(e => { e.removeAttribute('data-yn-fix'); e.removeAttribute('data-yn-other'); })).catch(() => {});
    return pressed === 'true';
  };

  for (let round = 1; round <= 3; round++) {
    /* Re-assert every Yes/No the autofill re-render may have dropped, and say
       so out loud -- a silently-cleared answer is what made three Delinea
       submits fail while the buttons still looked green in the screenshot. */
    const ynBefore = await readYesNoState();
    const dropped = ynBefore.filter(y => !y.answer);
    console.log(`  [submit round ${round}] yes/no state: ${ynBefore.map(y => `${y.answer || 'UNSET'}`).join(', ') || '(none)'}`);
    for (const d of dropped) {
      const want = YESNO.find(([rx]) => rx.test(d.label));
      if (want && await repairYesNo(d.label, String(want[1]).toLowerCase())) {
        log.push(`re-asserted yes/no "${d.label.slice(0, 34)}" = ${want[1]}`);
      }
    }

    /* A bare .catch(() => {}) here hid a click that never landed. Say so. */
    /* Close anything open first. A typeahead left showing its option list -- or
       a "No results" panel -- sits over the submit button, and the click then
       times out after fifteen seconds. Rounds 2 and 3 of every 1Password
       attempt failed this way, so the form never got a second chance. */
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);
    await submit.scrollIntoViewIfNeeded().catch(() => {});
    let clickErr = null;
    await submit.click({ timeout: 15000 }).catch((e) => { clickErr = String(e.message).split(String.fromCharCode(10))[0].slice(0, 120); });
    /* If it was still covered, click its coordinates -- the same overlay-beating
       approach the Workday buttons needed. */
    if (clickErr) {
      const box = await submit.boundingBox().catch(() => null);
      if (box) {
        const landed = await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
          .then(() => true).catch(() => false);
        if (landed) { clickErr = null; console.log('  [submit] element click was blocked; clicked its coordinates instead'); }
      }
    }
    if (clickErr) {
      console.log(`  [submit round ${round}] click failed: ${clickErr}`);
      log.push(`submit click failed: ${clickErr}`);
    }
    await page.waitForTimeout(4000);
    const missing = await readBanner();
    if (!missing.length) break;

    console.log(`  [submit round ${round}] form named ${missing.length} missing field(s): ${missing.slice(0, 6).join(' | ')}`);
    let fixedAny = false;
    for (const name of missing) {
      /* A Yes/No named in the banner is not reachable by the input-based repair
         below, so handle it first. */
      const yn = YESNO.find(([rx]) => rx.test(name));
      if (yn && await repairYesNo(name, String(yn[1]).toLowerCase())) {
        log.push(`banner-fix: yes/no "${name.slice(0, 34)}" = ${yn[1]}`);
        fixedAny = true;
        continue;
      }
      const hit = VALUE_MAP.find(([rx]) => rx.test(name));
      const bankKey = hit ? null : Object.keys(answerBank)
        .filter(k => !k.startsWith('_')).sort((a, b) => b.length - a.length)
        .find(k => name.toLowerCase().includes(k.toLowerCase()));
      if (!hit && !bankKey) continue;
      const value = String(hit ? hit[1] : answerBank[bankKey] || '');
      if (!value) continue;

      /* Find the control INSIDE the field entry the banner named.

         Matching on any ancestor whose text contains the question is wrong:
         the form root contains every question, so the first input on the page
         wins and the answer lands in the wrong box. That is the same defect
         that once wrote a location into the Full Name field. Scope to a real
         field entry, and refuse a control whose own label says it is something
         else. */
      const tagged = await target.evaluate((label) => {
        const norm = (t) => String(t || '').replace(/[\s]+/g, ' ').trim().toLowerCase();
        const want = norm(label).replace(/[*]$/, '').trim();
        if (!want) return false;
        document.querySelectorAll('[data-apfix]').forEach(e => e.removeAttribute('data-apfix'));
        const ENTRY = '[data-field-path], .ashby-application-form-field-entry, li.application-question, [class*=application-question], fieldset';
        const OTHER = /(full |legal |first |last |preferred )?name|e-?mail|phone|resume|linkedin|github|portfolio/i;
        for (const entry of document.querySelectorAll(ENTRY)) {
          const lab = norm(entry.querySelector('label,legend')?.innerText || entry.innerText);
          if (!lab.includes(want)) continue;
          for (const c of entry.querySelectorAll('input,select,textarea,[role=combobox]')) {
            if (['hidden', 'submit', 'button'].includes(c.type)) continue;
            const own = norm(c.getAttribute('aria-label') || c.placeholder || c.name);
            if (own && OTHER.test(own) && !want.includes(own)) continue;
            c.setAttribute('data-apfix', '1');
            return true;
          }
        }
        return false;
      }, name).catch(() => false);
      if (!tagged) {
        /* Say so. A silent continue here is why the same field was reported
           missing round after round with no sign of an attempt in the log. */
        console.log(`  [submit] could not locate the control for "${name.slice(0, 60)}"`);
        continue;
      }

      const el = target.locator('[data-apfix="1"]').first();
      if (!(await el.count().catch(() => 0))) continue;
      const kind = await el.evaluate(e => ({ type: e.type, role: e.getAttribute('role'), tag: e.tagName }))
        .catch(() => ({}));

      if (kind.type === 'file') {
        await el.setInputFiles(resume).catch(() => {});
        log.push(`banner-fix: re-attached resume for "${name.slice(0, 34)}"`);
        fixedAny = true;
      } else if (kind.type === 'checkbox' || kind.type === 'radio') {
        /* An attestation rendered as a lone checkbox. MeridianLink's "I
           understand that as permitted by law..." and 1Password's "offers of
           employment are conditional on satisfactory..." are both this shape,
           and the repair had no branch for it: it fell through to fill(), which
           does nothing to a checkbox, so the banner named them every round.
           Only tick when the question reads as something to agree to. */
        const AGREE = /understand|agree|acknowledge|consent|certify|authorize|permitted by law|conditional on/i;
        if (AGREE.test(name)) {
          await el.check({ force: true }).catch(async () => { await el.click({ force: true }).catch(() => {}); });
          const on = await el.isChecked().catch(() => false);
          log.push(`banner-fix: ${on ? 'ticked' : 'FAILED to tick'} "${name.slice(0, 34)}"`);
          console.log(`  [submit] ${on ? 'ticked' : 'could not tick'} "${name.slice(0, 46)}"`);
          if (on) fixedAny = true;
        } else {
          console.log(`  [submit] "${name.slice(0, 46)}" is a checkbox but not an agreement; leaving it`);
        }
      } else if (kind.role === 'combobox' || kind.tag === 'SELECT') {
        /* Ashby's autocomplete needs a real choice from the popup: typed text
           alone leaves it unset, which is why "In which state do you
           permanently reside?" came back on every round with no sign of an
           attempt. Give the popup time, try a shorter query if the full one
           offers nothing, and fall back to the keyboard, which selects the
           highlighted row on widgets that render no clickable option. */
        const queries = [value, value.split(',')[0].trim()].filter((q, i, a) => q && a.indexOf(q) === i);
        let picked = false;
        for (const q of queries) {
          await el.click().catch(() => {});
          await el.fill('').catch(() => {});
          await el.type(q, { delay: 55 }).catch(() => {});
          await page.waitForTimeout(2200);
          const opts = target.locator('[role="option"]:visible, [role="listbox"] li:visible, [class*="autocomplete"] [role="option"]');
          const n = Math.min(await opts.count().catch(() => 0), 15);
          for (let k = 0; k < n; k++) {
            const t = (await opts.nth(k).innerText().catch(() => '')).trim();
            if (t && new RegExp(escapeRx(q.split(',')[0]), 'i').test(t)) {
              await opts.nth(k).click().catch(() => {});
              log.push(`banner-fix: "${name.slice(0, 30)}" = ${t.slice(0, 30)}`);
              console.log(`  [submit] picked "${t.slice(0, 40)}" for "${name.slice(0, 40)}"`);
              picked = true;
              break;
            }
          }
          if (picked) break;
          /* No clickable row. Some widgets highlight a match and commit on Enter. */
          await page.keyboard.press('ArrowDown').catch(() => {});
          await page.waitForTimeout(250);
          await page.keyboard.press('Enter').catch(() => {});
          await page.waitForTimeout(600);
          /* "No results" means the query matched NOTHING, and pressing Enter
             on an empty list leaves the typed text sitting in the box while the
             field stays unset. That read as committed and the same submit was
             rejected three rounds running. */
          const empty = await target.evaluate(() =>
            /no results|no options|nothing found/i.test(document.body.innerText)).catch(() => false);
          const now = empty ? '' : (await el.inputValue().catch(() => '')).trim();
          if (now && !/^select/i.test(now)) {
            log.push(`banner-fix: "${name.slice(0, 30)}" = ${now.slice(0, 30)} (keyboard)`);
            console.log(`  [submit] committed "${now.slice(0, 40)}" by keyboard for "${name.slice(0, 40)}"`);
            picked = true;
            break;
          }
        }
        if (picked) fixedAny = true;
        else console.log(`  [submit] "${name.slice(0, 50)}" offered no option matching "${value.slice(0, 24)}"`);
      } else {
        /* Clear, then TYPE. fill() sets the value in one shot and some
           validators never see it -- 1Password kept reporting "Why 1Password?"
           missing across three rounds while the essay was visibly sitting in
           the box. Typing a few characters after the fill raises the events the
           form is actually listening for, without retyping a 900-character
           answer one key at a time. */
        await el.fill('').catch(() => {});
        await page.waitForTimeout(120);
        await el.fill(value.slice(0, -3)).catch(() => {});
        await el.click().catch(() => {});
        await page.keyboard.type(value.slice(-3), { delay: 60 }).catch(() => {});
        await page.waitForTimeout(200);
        const back = (await el.inputValue().catch(() => '')).trim();
        log.push(`banner-fix: "${name.slice(0, 30)}" = ${value.slice(0, 30)}${back ? '' : ' (DID NOT TAKE)'}`);
        if (back) fixedAny = true;
      }
      await page.waitForTimeout(300);
    }
    if (!fixedAny) {
      console.log('  [submit] none of the named fields could be answered from the profile; stopping');
      break;
    }
    await page.waitForTimeout(800);
  }

  /* Wait for a real end state, not a fixed sleep. The first Render run was
     screenshotted while the button still showed its spinner, so a completed
     submission was reported as unconfirmed. Poll until the page shows either a
     success message or a validation error. */
  /* Angi confirms with "Success - We've successfully received your
     application!" and the form is gone from the page. None of the original
     alternatives covered it: "successfully received" is neither "successfully
     submitted" nor "we have received", and "received your application" is not
     "application received". The run was reported unconfirmed on an application
     that had gone through, which is worse than a missed application because the
     posting then looks available and gets applied to again.

     The apostrophe is deliberately optional: pages use both ' and the curly
     U+2019. */
  const SUCCESS = /thank you( for applying)?|application (was |has been )?(received|submitted|sent)|we ?[''’]?ve? (successfully )?received|successfully (applied|submitted|received|sent)|received your application|your application (has been|was|is)|application complete/i;
  /* "You have already submitted an application." is Ashby refusing a DUPLICATE,
     which means the earlier attempt SUCCEEDED. Six Delinea applications were
     real, were recorded as submitted-unconfirmed because the confirmation text
     did not match, and were then retried -- at which point the board said so in
     plain words and the runner still called it unconfirmed. An employer telling
     you the application is already in is the strongest confirmation there is. */
  const ALREADY_IN = /you have already (submitted|applied)|already submitted an application|already applied (to|for) this|duplicate application/i;
  const FAILURE = /form needs corrections|missing entry for required|please (correct|complete|fix)|there (was|were) (an )?error/i;
  /* Greenhouse can gate the submit behind an emailed one-time code: the form
     stays on screen with an empty "Security code" field, the Submit button goes
     disabled, and the page reads "A verification code was sent to <email>. To
     submit your application, enter the 8-character code to confirm you're a
     human." Nothing on that page matches FAILURE, and enough of it matched the
     old SUCCESS test that three Temporal postings were written to D1 as
     applications that were never sent. Treat a pending code as its own state. */
  const EMAIL_CODE = /verification code was sent|enter the \d+[- ]character code|security code|confirm you'?re a human|check your email for a (verification|security) code/i;
  const deadline = Date.now() + 45000;
  let after = '';
  while (Date.now() < deadline) {
    after = await target.evaluate(() => (document.body ? document.body.innerText : '').replace(/\s+/g, ' ')).catch(() => '');
    if (SUCCESS.test(after) || FAILURE.test(after) || ALREADY_IN.test(after)) break;
    await page.waitForTimeout(1000);
  }
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  /* An "already submitted" answer counts as confirmed: the application is in,
     whichever run put it there. */
  const alreadyIn = ALREADY_IN.test(after);
  const confirmed = alreadyIn
    || (SUCCESS.test(after) && !FAILURE.test(after) && !EMAIL_CODE.test(after));
  if (alreadyIn) log.push('the board says an application is already on file for this posting');
  /* Greenhouse answers the form POST with 428 when it wants the emailed code,
     and the page sometimes re-renders to the plain job description with no code
     UI in the text at all -- Anthropic did exactly that, yet still sent Brian a
     code. So a 428 is the same gate as the visible prompt, not a separate wall.
     Treat either signal as "a code is required". */
  /* Some employers cap how often one candidate may apply. Kit: "Candidates may
     not apply more than 2 times in any 60 day span for any job at Kit."
     Headway: "we limit applicants to 2 applications across all roles per 60
     days." Neither is a fillable-field problem and no retry will ever clear it,
     so it must not look like a form defect -- the batch burned repeated
     attempts on five Headway postings before this existed. */
  const RATE_LIMIT = /may not apply more than|limit applicants to \d+ application|more than \d+ (times|applications) in any|applications across all roles per/i;
  if (!confirmed && RATE_LIMIT.test(after)) {
    const quote = (after.match(/[^.]*(may not apply more than|limit applicants to)[^.]*\./i) || [''])[0].trim();
    console.log(`
EMPLOYER RATE LIMIT: ${quote.slice(0, 160)}`);
    console.log('No retry will clear this. Recording it and moving on.');
    await shot(page, 'stop-employer-rate-limit');
    return await finish(ctx, !!args.batch, { state: 'employer-rate-limit', note: quote.slice(0, 200), log });
  }

  const codeWanted = EMAIL_CODE.test(after)
    || submitRejections.some(x => x.status === 428);
  if (!confirmed && codeWanted) {
    console.log('');
    console.log('SUBMIT PENDING: the board emailed a one-time verification code.');
    await shot(page, 'stop-email-code');

    /* --wait-for-code holds the filled form open and watches CODE_FILE. Brian
       reads the code out of his own email and it gets written there; the run
       then types it and finishes the submit. The alternative -- exiting and
       coming back -- loses the session the code belongs to, and the board
       issues a fresh code on every reload. */
    if (args['wait-for-code']) {
      const codeFile = args['code-file'] || path.join(ROOT, 'apply', 'CODE.local.txt');
      try { fs.unlinkSync(codeFile); } catch { /* nothing to clear */ }
      const waitMs = Number(args['code-timeout'] || 900000);
      const deadline = Date.now() + waitMs;
      console.log(`WAITING for the code. Write it to ${codeFile} (up to ${Math.round(waitMs / 60000)} min).`);

      /* Up to three codes per session. A stale code -- one issued by an earlier
         run of the same posting -- is rejected, and burning the whole session on
         it means re-submitting, which just emails yet another code. Clear the
         file and keep waiting instead, so the right code can still land. */
      for (let attempt = 1; attempt <= 3; attempt++) {
        let code = '';
        while (Date.now() < deadline) {
          try {
            const raw = fs.readFileSync(codeFile, 'utf8').trim().replace(/[^A-Za-z0-9]/g, '');
            if (raw.length >= 6) { code = raw; break; }
          } catch { /* not written yet */ }
          await page.waitForTimeout(2000);
        }
        if (!code) {
          console.log('No code arrived before the timeout. Not submitted.');
          return await finish(ctx, !!args.batch, { state: 'needs-email-code', log });
        }
        console.log(`Got a ${code.length}-character code (attempt ${attempt}). Entering it.`);

        /* The widget is a row of single-character inputs that advance on
           keypress, so focus the first and type -- setting .value box by box
           does not fire the advance and leaves the field half filled. */
        const boxes = target.locator('input[autocomplete="one-time-code"], input[name*="code" i], input[maxlength="1"]');
        const n = await boxes.count().catch(() => 0);
        if (n) {
          for (let b = 0; b < n; b++) await boxes.nth(b).fill('').catch(() => {});
          await boxes.first().click().catch(() => {});
          await page.keyboard.type(code, { delay: 120 });
        } else {
          const single = target.locator('input[type="text"]:visible').last();
          await single.click().catch(() => {});
          await single.fill('').catch(() => {});
          await single.type(code, { delay: 120 }).catch(() => {});
        }
        await page.waitForTimeout(1200);
        await shot(page, `5-code-entered-${attempt}`);

        const finalBtn = target.getByRole('button', { name: /submit application|^submit$|verify|confirm/i }).first();
        await finalBtn.click().catch(() => {});
        await page.waitForTimeout(7000);
        const after2 = await target.evaluate(() => (document.body ? document.body.innerText : '')
          .replace(/\s+/g, ' ')).catch(() => '');
        const ok2 = SUCCESS.test(after2) && !FAILURE.test(after2) && !EMAIL_CODE.test(after2);
        await shot(page, ok2 ? '6-submitted' : `6-code-rejected-${attempt}`);
        console.log(`after code: ${JSON.stringify(after2.slice(0, 220))}`);
        if (ok2) {
          console.log('SUBMITTED after the code.');
          return await finish(ctx, !!args.batch, { state: 'submitted', log });
        }
        console.log(`Code ${attempt} was not accepted. Clearing it and waiting for another.`);
        try { fs.unlinkSync(codeFile); } catch { /* already gone */ }
      }
      console.log('Three codes were rejected. Not submitted.');
      return await finish(ctx, !!args.batch, { state: 'code-unconfirmed', log });
    }

    console.log('The application is NOT sent until that code is typed in. A human has to finish it.');
    return await finish(ctx, !!args.batch, { state: 'needs-email-code', log });
  }
  /* A 428/403 on the form POST is a bot wall, not a fillable-field problem. Say
     so distinctly so the batch can route it to a human instead of retrying. */
  const wall = submitRejections.find(x => x.status === 403 || x.status === 429);
  if (!confirmed && wall) {
    console.log(`
SUBMIT BLOCKED: the form POST returned HTTP ${wall.status} (${wall.url}).`);
    console.log('This is a captcha / bot wall, not a missing field. It needs a human to submit.');
    await shot(page, 'stop-submit-wall');
    return await finish(ctx, !!args.batch, { state: 'captcha-blocked', httpStatus: wall.status, log });
  }
  if (FAILURE.test(after)) {
    const errs = (after.match(/Missing entry for required field: [^.]{0,70}/gi) || []).slice(0, 6);
    console.log('\nform rejected the submit:', errs.length ? errs.join(' | ') : '(see screenshot)');
  }
  after = after.slice(0, 400);
  await shot(page, confirmed ? '4-submitted' : '4-after-submit-unconfirmed');
  console.log(`\nafter submit: ${JSON.stringify(after.slice(0, 200))}`);
  if (!confirmed && !appPosts.length) {
    console.log('');
    console.log('SUBMIT DID NOTHING: the button was clicked but no application request ever left the browser.');
    console.log('Nothing was sent. Do not mark this posting applied.');
    await shot(page, 'stop-no-request');
    return await finish(ctx, !!args.batch, { state: 'submit-no-request', log });
  }
  console.log(confirmed ? 'SUBMITTED — confirmation text found on the page.' : 'SUBMIT CLICKED but no confirmation text found. Verify manually before marking applied.');
  if (!confirmed) console.log(`  application POSTs seen: ${appPosts.map(x => x.status).join(', ')}`);
  return await finish(ctx, !!args.batch, { state: confirmed ? 'submitted' : 'submitted-unconfirmed', log });
}

/* A runner that throws, or is killed by the batch timeout, never reaches
   finish(), so its Chrome and its profile dir survive. Clean up on every exit
   path rather than only the happy one. */
for (const sig of ['exit', 'SIGINT', 'SIGTERM', 'uncaughtException']) {
  process.on(sig, () => {
    if (!ACTIVE_PROFILE_DIR || cleanedUp) return;
    cleanedUp = true;
    const dirName = path.basename(ACTIVE_PROFILE_DIR);
    try {
      const { execFileSync } = require('node:child_process');
      execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${dirName}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
      ], { stdio: 'ignore', timeout: 15000 });
      fs.rmSync(ACTIVE_PROFILE_DIR, { recursive: true, force: true });
    } catch { /* best effort on the way out */ }
  });
}

let result;
try {
  result = await main();
} catch (e) {
  console.error('runner failed:', e && e.message);
  try {
    const { execFileSync } = require('node:child_process');
    if (ACTIVE_PROFILE_DIR && !cleanedUp) {
      cleanedUp = true;
      const dirName = path.basename(ACTIVE_PROFILE_DIR);
      execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${dirName}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
      ], { stdio: 'ignore', timeout: 15000 });
      fs.rmSync(ACTIVE_PROFILE_DIR, { recursive: true, force: true });
    }
  } catch { /* best effort */ }
  console.log('\nRESULT: "crashed"');
  process.exit(1);
}
console.log('\nRESULT:', JSON.stringify(result && result.state));
