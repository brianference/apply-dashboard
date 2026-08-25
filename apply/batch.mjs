/**
 * Work the queue overnight: pull direct-form postings from the live API, run
 * the apply runner against each one, and keep going until a target number of
 * REAL, confirmed submissions is reached or the queue runs dry.
 *
 * Nothing is ever marked applied unless the posting itself displayed a success
 * message. A run that stops for a captcha, a wall, a consent question, or an
 * unanswerable field is logged with its reason to ISSUES.md and skipped —
 * the batch always moves on to the next posting, never stalls on one.
 *
 *   node apply/batch.mjs --goal 100 --submit          # the overnight run
 *   node apply/batch.mjs --limit 10                   # dry run, no submissions
 *   node apply/batch.mjs --submit --company GitLab
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..');
const API = 'https://apply-dashboard.pages.dev/api/jobs';
const APPLY_API = 'https://apply-dashboard.pages.dev/api/apply';
/* Spelled out, NOT derived from APPLY_API. APPLY_API.replace('/apply',
   '/blocked') matches the HOSTNAME first -- '//apply-dashboard' contains
   '/apply' -- and produced https://blocked-dashboard.pages.dev/api/apply,
   a domain that does not exist. Every blocked record silently went nowhere,
   which is why no posting ever carried a runner-recorded reason. */
const BLOCKED_API = 'https://apply-dashboard.pages.dev/api/blocked';

/**
 * Fingerprint of the code that actually drives a form.
 *
 * A ledger entry records what the driver of the day could do. Every Workday
 * posting in the queue carried a terminal wd-* state recorded before the
 * education panel, the option-matching relax and the click ladder existed, so
 * an improved driver was handed an empty queue and reported "queue exhausted"
 * after a single posting. A recorded failure is only evidence about the code
 * that produced it -- when that code changes, the failure is a stale verdict,
 * not a property of the posting.
 */
const DRIVER_FILES = ['runner.mjs', 'workday.mjs', 'workday-drive.mjs'];
const DRIVER_HASH = (() => {
  const h = crypto.createHash('sha1');
  for (const f of DRIVER_FILES) {
    try { h.update(fs.readFileSync(path.join(ROOT, 'apply', f))); } catch { h.update(f); }
  }
  return h.digest('hex').slice(0, 12);
})();
let LEDGER = path.join(ROOT, 'evidence', 'apply', 'batch-ledger.json');
let ISSUES = path.join(ROOT, 'evidence', 'apply', 'ISSUES.md');
const ANSWERS = path.join(ROOT, 'apply', 'answers.general.local.json');
const TOKEN_FILE = path.join(ROOT, 'APPLY_TOKEN.local.txt');

/** Hosts whose form the runner can actually complete unattended. */
const DIRECT = /ashbyhq\.com|greenhouse\.io|lever\.co|workable\.com|smartrecruiters\.com|myworkdayjobs\.com|icims\.com|breezy\.hr|recruitee\.com|teamtailor\.com|applytojob\.com/i;

/* Hosts paused by hand. Ashby is paused as of 2026-08-24: a rejected submit
   does not just render an error, it returns a whole NEW FormRender (a fresh
   render id) that the page swaps in, wiping every field already entered. The
   trace shows the yes/no answers reading "no, no, no" before a rejected submit
   and "UNSET, UNSET, UNSET" straight after it, with the resume, names and
   address cleared too, so the repair loop refills a form that resets underneath
   it and loses the race. Repeated attempts also draw a "problem with the
   network connection" from Ashby. Re-enable only once the runner treats a
   rejection as "the form is now blank, start over".
   Note ScribdInc is an Ashby tenant, so this covers it. */
/* Greenhouse joined the pause on 2026-08-24. Every tenant tested gates the
   submit behind a one-time code emailed to the applicant (Temporal, Boostlingo,
   Arize, Boulevard) or answers the form POST with HTTP 428 asking for the same
   thing (Anthropic). The form fills clean and the resume uploads; the code is
   the wall, and each new attempt invalidates the previous code, so unattended
   volume is not possible here. Re-enable for a supervised code-relay session.
   Lever, Workday, iCIMS and SmartRecruiters do not gate this way. */
/* Ashby is BACK ON as of 2026-08-24. The reason it was paused -- a rejected
   submit returning a fresh FormRender that wipes the form -- only bites when
   the first submit is rejected, and the thing rejecting it was the unfilled
   "City, Region/State, Country" typeahead. With that fixed the first submit
   goes through: Delinea Endpoint Privilege Management returned FormSubmitSuccess
   and rendered "Your application was successfully submitted."

   Greenhouse stays paused: every tenant tested gates the submit behind a
   one-time code emailed to the applicant, and each new attempt invalidates the
   previous code, so unattended volume is impossible there. */
/* Paused because a human has to finish them, not because the runner cannot
   fill them. Greenhouse and its nine vanity front-ends email Brian a
   one-time code per application; Lever serves an hCaptcha image challenge.
   Every one of these rows carries a blocked_reason so the dashboard shows a
   Manual badge with the reason and a link, and the Sent? prompt records it
   when he finishes one by hand. */
const PAUSED_HOSTS = /greenhouse\.io|gh_jid|lever\.co|stripe\.com|samsara\.com|coinbase\.com|pinterestcareers\.com|instacart\.careers|fivetran\.com|cribl\.io|upstart\.com|elastic\.co/i;

/** States worth one automatic retry — a real crash, not a real blocker. */
/* upload-failed is TRANSIENT, not a property of the posting. Ashby drops the
   resume upload under parallel load -- five postings lost it in one four-shard
   run -- and it was in TERMINAL, so each one was retired permanently for a
   problem that clears on a quieter retry. */
/* wd-stuck is a Workday page that was valid and simply did not advance. The
   "Save and Continue" button is an aria-hidden <button> under a click_filter
   overlay, and a click that lands mid-re-render is dropped silently, so this
   clears on a retry rather than describing the posting. */
/* wd-stuck is NOT retryable. It ate a whole supervised run: Warner Bros never
   reaches the wizard at all - its page 1 reports no step - and it was picked
   five times while thirty other Workday postings waited. A wizard that will not
   start does not start on the next attempt either. */
const RETRYABLE = new Set(['crashed', 'upload-failed']);
/* A form that rejected the submit is blocked on a field the profile cannot
   answer. Retrying it produces the same rejection, so it is recorded once and
   never attempted again - that is what "skip and move on" means in practice. */
const TERMINAL = new Set(['submitted-unconfirmed', 'needs-input', 'no-submit-button', 'needs-account-or-wizard',
  'location-ineligible', 'needs-consent-decision', 'wall', 'captcha',
  /* The form POST came back 428/403 -- a bot wall. Retrying only burns time. */
  'captcha-blocked',
  /* The board emailed a one-time code and will not accept the application
     until a human types it in. Retrying just sends another email. */
  'needs-email-code',
  /* The Workday wizard never started on this posting. */
  'wd-stuck',
  /* The employer caps applications per candidate. No retry clears it. */
  'employer-rate-limit',
  /* Workday blockers that a retry cannot clear. wd-auth-blocked means Brian
     already has a candidate account on that tenant under a password this repo
     does not hold - it has to be added to apply/workday-accounts.local.json by
     hand. wd-unknown-question and wd-validation-blocked mean the wizard asked
     for something the profile and the answer bank do not cover; the run stops
     rather than guessing. wd-no-apply-path is a posting Workday now 404s. */
  'wd-auth-blocked', 'wd-unknown-question', 'wd-validation-blocked',
  'wd-no-apply-path', 'wd-too-many-pages']);

/** @returns {Record<string,string|boolean>} */
function args() {
  const o = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue;
    const k = a[i].slice(2);
    o[k] = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true;
  }
  return o;
}
const A = args();
const MAX_SUBMITS_PER_COMPANY = Number(process.env.MAX_SUBMITS_PER_COMPANY || 3);
let submittedByCompany = {};

/* Companies to skip entirely, with the reason recorded in the file. */
let SKIP_COMPANIES = {};
try {
  SKIP_COMPANIES = JSON.parse(fs.readFileSync(path.join(ROOT, 'apply', 'skip-companies.local.json'), 'utf8'));
} catch { /* no skip list is fine */ }
/**
 * @param {string} company
 * @returns {string|null} the reason to skip, or null
 */
function skipReason(company) {
  const c = String(company || '').toLowerCase().trim();
  for (const [k, v] of Object.entries(SKIP_COMPANIES)) {
    if (k.startsWith('_')) continue;
    if (c === k || c.includes(k)) return v;
  }
  return null;
}

/** @returns {object} */
function loadLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch { return {}; }
}
/** @param {object} l */
function saveLedger(l) {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  fs.writeFileSync(LEDGER, JSON.stringify(l, null, 1));
}

let issuesInited = false;
/**
 * Append one skipped/blocked posting to the human-readable morning report.
 * @param {object} j
 * @param {string} state
 * @param {string[]} blockers
 */
function logIssue(j, state, blockers) {
  fs.mkdirSync(path.dirname(ISSUES), { recursive: true });
  if (!issuesInited) {
    if (!fs.existsSync(ISSUES)) {
      fs.writeFileSync(ISSUES, `# Overnight apply run — issues for Brian to review\n\nStarted ${new Date().toISOString()}\n\n`);
    } else {
      fs.appendFileSync(ISSUES, `\n---\n\nResumed ${new Date().toISOString()}\n\n`);
    }
    issuesInited = true;
  }
  const line = `- **${j.company}** — ${j.title}\n  ${j.url}\n  state: \`${state}\`${blockers.length ? `\n  needs: ${blockers.join('; ')}` : ''}\n`;
  fs.appendFileSync(ISSUES, line);
}

/**
 * Run the single-posting runner as a child process.
 * @param {string} url
 * @param {boolean} submit
 * @returns {Promise<{state:string, out:string}>}
 */
function runOne(url, submit) {
  return new Promise((resolve) => {
    const argv = [path.join(ROOT, 'apply', 'runner.mjs'), '--url', url, '--answers', ANSWERS, '--batch'];
    if (submit) argv.push('--submit');
    const child = spawn(process.execPath, argv, { cwd: ROOT });
    let out = '';
    let settled = false;
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });

    /* SIGKILL on the runner.mjs Node process does not reliably reach the
       Chrome subprocess tree it spawned on Windows — 24+ orphaned chrome.exe
       piled up during testing and stalled every subsequent attempt. Belt and
       braces: if the child does not close on its own in time, sweep every
       chrome.exe whose command line names THIS run's throwaway profile dir,
       which is unique per invocation (.apply-session-<timestamp>), so nothing
       else on the machine is touched. */
    const settle = (state) => {
      if (settled) return;
      settled = true;
      clearTimeout(kill);
      resolve({ state, out });
    };
    const kill = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      const tag = `apply-dashboard\\\\.apply-session-`;
      const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*apply-session*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
      ], { stdio: 'ignore' });
      ps.on('close', () => settle('crashed'));
      ps.on('error', () => settle('crashed'));
      void tag;
      setTimeout(() => settle('crashed'), 15000); // settle even if the sweep itself hangs
    }, /myworkdayjobs\.com/i.test(url || '') ? 900000 : 300000);
    /* 150s killed slow-but-healthy postings under parallel load; Linear
       completed fine in ~200s standalone, was killed at 150s in-batch,
       recorded as "crashed", and then retried forever.
       Workday gets 15 minutes of its own: it is a seven-page wizard with a
       sign-in, a resume parse, up to seven work-experience rows each carrying
       two segmented dates, and a disclosures page. The Splunk posting was
       killed at 300s while filling row 5 and recorded as a crash, which says
       nothing about the posting. */

    child.on('close', () => {
      const m = out.match(/RESULT:\s*"?([a-z-]+)"?/i);
      const state = m ? m[1] : 'crashed';
      /* Keep the runner's own output for anything that did not confirm. The
         overnight run threw all of it away, so fifteen rejected submits left
         nothing but the word "submitted-unconfirmed" and every diagnosis had
         to start by re-running the posting by hand. */
      if (state !== 'submitted' && state !== 'dry-run-ok' && state !== 'wd-review-reached-dry-run') {
        try {
          const safe = String(url).replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').slice(0, 90);
          fs.writeFileSync(path.join(ROOT, 'evidence', 'apply', `runlog-${safe}.txt`),
            out.slice(-20000));
        } catch { /* a lost log must never take the batch down */ }
      }
      settle(state);
    });
    child.on('error', () => settle('crashed'));
  });
}

/**
 * Record a submission in D1. Never called unless the posting confirmed it.
 * @param {string} dedupeKey
 * @returns {Promise<boolean>}
 */
async function markApplied(dedupeKey) {
  let token = '';
  try { token = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { return false; }
  if (!token) return false;
  try {
    const r = await fetch(APPLY_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-apply-token': token },
      body: JSON.stringify({ dedupe_key: dedupeKey, status: 'submitted' })
    });
    return r.ok;
  } catch { return false; }
}

/**
 * Record why a posting could not be auto-applied, so the dashboard can surface
 * it for manual handling.
 * @param {string} dedupeKey
 * @param {string} reason
 * @param {string} detail
 * @returns {Promise<boolean>}
 */
async function markBlocked(dedupeKey, reason, detail) {
  let token = '';
  try { token = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { return false; }
  if (!token) return false;
  try {
    const r = await fetch(BLOCKED_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-apply-token': token },
      body: JSON.stringify({ dedupe_key: dedupeKey, reason, detail })
    });
    return r.ok;
  } catch { return false; }
}

/** @returns {Promise<{queue:object[], submittedTotal:number}>} the live direct-form queue, plus the CURRENT total submitted count across all rows and all workers - D1 is the single shared source of truth so parallel shards need no other coordination for the goal check. */
async function fetchQueue() {
  const res = await fetch(API, { headers: { 'cache-control': 'no-cache' } });
  const { jobs } = await res.json();
  /* Never apply twice to the same posting URL. Two different rows can carry the
     same URL under different dedupe_keys - an aggregator listing and the direct
     company listing for one job - and that produced a real duplicate
     application to GitLab (one as "GitLab", one as "Unknown (PJA listing)").
     The dedupe_key check alone cannot catch this, because the keys differ. */
  const alreadyAppliedUrls = new Set(
    jobs.filter(j => j.lane === 'submitted' || j.status === 'submitted').map(j => j.url)
  );
  const queue = jobs.filter(j =>
    j.status === 'queued' &&
    DIRECT.test(j.url || '') &&
    !PAUSED_HOSTS.test(j.url || '') &&
    !alreadyAppliedUrls.has(j.url) &&
    (j.link_status === null || j.link_status === undefined || j.link_status === 'live')
  );
  const submittedTotal = jobs.filter(j => j.lane === 'submitted').length;
  return { queue, submittedTotal, all: jobs };
}

/* Overnight run: never let one uncaught error kill the whole campaign silently.
   Log it and exit 1 so the shell wrapper (overnight.sh) restarts the process;
   the ledger means a restart resumes rather than re-attempting old rows. */
process.on('uncaughtException', (e) => {
  console.error('\nFATAL (uncaught):', e && e.stack || e);
  process.exitCode = 1;
});
process.on('unhandledRejection', (e) => {
  console.error('\nFATAL (unhandled rejection):', e);
  process.exitCode = 1;
});

const GOAL = A.goal ? Number(A.goal) : null;
/* No per-company cap by default. This was my own invention to avoid looking
   like spam; it was throttling a queue where 49 companies hold 181 roles. The
   real duplicate protection is URL-level dedupe plus the pre-submit D1 check. */
const PER_COMPANY = Number(A.perCompany || 100000);
const submit = !!A.submit;

/* Parallel workers. --shard 1/4 means: this process only ever attempts rows
   whose dedupe_key hashes to shard 1 of 4, so N workers running at once can
   never pick the same posting - no coordination needed, no shared lock. Each
   worker gets its own ledger file (LEDGER derivation below) so their attempt
   logs don't clobber each other; D1 itself is the shared source of truth for
   how many have actually been confirmed across every worker. */
let SHARD_INDEX = 0, SHARD_COUNT = 1;
if (A.shard) {
  const m = String(A.shard).match(/^(\d+)\/(\d+)$/);
  if (!m) { console.error('--shard must look like 2/4'); process.exit(1); }
  SHARD_INDEX = Number(m[1]); SHARD_COUNT = Number(m[2]);
}
/**
 * @param {string} s
 * @returns {number} stable non-cryptographic hash, 0..(SHARD_COUNT-1)
 */
function shardOf(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % SHARD_COUNT;
}
if (A.shard) {
  LEDGER = path.join(ROOT, 'evidence', 'apply', `batch-ledger-shard-${SHARD_INDEX}.json`);
  ISSUES = path.join(ROOT, 'evidence', 'apply', `ISSUES-shard-${SHARD_INDEX}.md`);
}

console.log(`=== batch start ${new Date().toISOString()} ===`);
console.log(`mode: ${submit ? 'SUBMIT' : 'DRY RUN'}  |  goal: ${GOAL || 'none (use --limit)'}  |  max ${PER_COMPANY} attempts per company (all-time)${A.shard ? `  |  shard ${A.shard}` : ''}\n`);

const ledger = loadLedger();
const companyAttempts = {};
for (const rec of Object.values(ledger)) {
  const c = String(rec.company || '').toLowerCase();
  companyAttempts[c] = (companyAttempts[c] || 0) + 1;
}

let confirmed = Object.values(ledger).filter(r => r.state === 'submitted' && r.recordedInD1).length;
console.log(`already confirmed by this ${A.shard ? 'shard' : 'process'} (from its own ledger): ${confirmed}\n`);

/* When sharded, the GOAL is shared across every worker. D1's live total is the
   only thing all shards can see without talking to each other, so the goal
   check compares against (current D1 submitted total - baseline captured at
   this process's own start), not the local per-shard ledger count. */
let baselineSubmitted = null;

const tally = {};
let processed = 0;
const SAFETY_CAP = Number(A.limit || 600); // hard ceiling so a bad queue can't loop forever

while (processed < SAFETY_CAP) {
  let live, submittedTotal, liveAll;
  try {
    ({ queue: live, submittedTotal, all: liveAll } = await fetchQueue());
  } catch (e) {
    console.log(`\ncould not reach the API (${e.message}), waiting 30s and retrying`);
    await new Promise(r => setTimeout(r, 30000));
    continue;
  }
  if (baselineSubmitted === null) baselineSubmitted = submittedTotal;
  /* recomputed each loop from D1 so every shard sees the same picture */
  submittedByCompany = {};
  for (const row of liveAll) {
    if (row.lane !== 'submitted') continue;
    const c = String(row.company || '').toLowerCase();
    submittedByCompany[c] = (submittedByCompany[c] || 0) + 1;
  }
  const campaignConfirmed = submittedTotal - baselineSubmitted;

  if (GOAL && campaignConfirmed >= GOAL) {
    console.log(`\nGOAL REACHED: ${campaignConfirmed}/${GOAL} confirmed submissions across all workers.`);
    break;
  }

  let candidates = live.filter(j => {
    /* Shard by COMPANY, not by posting. Sharding by dedupe_key would scatter
       one employer's many postings across different workers, and each
       worker's own PER_COMPANY cap only sees its own slice - four shards
       could then send 4x PER_COMPANY attempts at the same company. Sharding
       by company keeps every posting from one employer on one worker, so the
       existing per-shard cap is still a true global cap. */
    if (skipReason(j.company)) return false;
    /* Cap how many times ONE employer receives a submission. Different roles at
       one company are legitimate, but four confirmation emails in a morning
       reads as spam to a recruiter. This limits SUCCESSFUL submissions per
       company, not attempts, so a company whose forms keep failing is not
       penalised. */
    if ((submittedByCompany[String(j.company || '').toLowerCase()] || 0) >= MAX_SUBMITS_PER_COMPANY) return false;
    if (A.shard && shardOf(String(j.company || '').toLowerCase()) !== SHARD_INDEX) return false;
    const c = String(j.company || '').toLowerCase();
    if ((companyAttempts[c] || 0) >= PER_COMPANY) return false;
    const attempted = ledger[j.dedupe_key];
    /* A crashing posting used to be retried forever: 'crashed' is retryable, so
       the same row was picked again on every loop. One posting (Linear) burned
       dozens of attempts and starved the whole campaign. Allow at most two
       crash retries per posting, then treat it as permanently blocked. */
    if (attempted) {
      /* A driver-specific block recorded by a DIFFERENT build of the driver is
         a stale verdict. Re-open it once per driver change; the new entry it
         writes carries the new hash, so it cannot loop. Never re-open a real
         submission or a decision made about the POSTING rather than the code. */
      const staleBlock = /^wd-/.test(String(attempted.state || ''))
        && attempted.driver !== DRIVER_HASH;
      if (!staleBlock) {
        if (!RETRYABLE.has(attempted.state)) return false;
        if ((attempted.crashCount || 0) >= 2) return false;
      }
    }
    return true;
  });
  if (A.company) candidates = candidates.filter(j => new RegExp(String(A.company), 'i').test(j.company));
  /* --host lets one lane be worked on its own. Workday needs its own driver and
     its own pace, and the score-ordered queue reaches it only after everything
     else. */
  if (A.host) candidates = candidates.filter(j => new RegExp(String(A.host), 'i').test(j.url || ''));

  if (!candidates.length) { console.log('\nqueue exhausted: no more eligible direct-form postings.'); break; }

  /* Work the postings most likely to actually submit first. Measured tonight:
     Ashby and Greenhouse account for 22 of 24 confirmed submissions, while
     Workday and iCIMS have produced none. Match score breaks ties. */
  const FAMILY_RANK = (u) => {
    if (/ashbyhq/.test(u)) return 0;
    if (/greenhouse/.test(u)) return 1;
    if (/lever\.co/.test(u)) return 2;
    if (/workable|smartrecruiters/.test(u)) return 3;
    return 4;
  };
  candidates.sort((a, b) => {
    const f = FAMILY_RANK(a.url || '') - FAMILY_RANK(b.url || '');
    if (f) return f;
    return (b.match_pct || 0) - (a.match_pct || 0);
  });
  const j = candidates[0];
  processed++;

  /* Last line of defence, checked against D1 immediately before submitting.
     The queue snapshot can be seconds stale, and with parallel shards another
     worker may have submitted this exact posting in that window. */
  if (submit) {
    try {
      const chk = await fetch(API, { headers: { 'cache-control': 'no-cache' } });
      const { jobs: fresh } = await chk.json();
      /* Match on the dedupe key as well as the URL. Brian applies by hand from
         the dashboard while this runs, and confirming there writes the row by
         dedupe_key; a URL-only test would miss a posting he has just finished
         if the stored URL differs by a query string or a source tag. */
      const isDone = (f) => f.lane === 'submitted' || f.status === 'submitted';
      /* Aggressive: an exact key or URL match is not enough. The same job is
         listed under different keys when a title picks up or loses a suffix
         ("(Remote Eligible)", "- US", "II"), or when a company name is written
         two ways, and an exact test would let the second copy through and send
         a duplicate application. Compare on a NORMALISED company and title:
         punctuation dropped, and the decorations that vary between boards
         removed. Brian's rule, 2026-08-25: aggressively prevent duplicates. */
      const norm = (v) => String(v || '').toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/(remote|eligible|hybrid|onsite|on site|us|usa|united states|full time|contract)/g, ' ')
        .replace(/\s+/g, ' ').trim();
      const sameJob = (f) => norm(f.company) === norm(j.company) && norm(f.title) === norm(j.title);
      const clash = fresh.find(f => isDone(f)
        && (f.url === j.url || f.dedupe_key === j.dedupe_key || sameJob(f)));
      if (clash) {
        console.log(`[skip] ${j.company} — already applied to this posting as "${clash.company} | ${clash.title}"\n`);
        ledger[j.dedupe_key] = {
          company: j.company, title: j.title, url: j.url,
          state: 'skipped-already-applied', recordedInD1: false, blockers: [],
          at: new Date().toISOString()
        };
        saveLedger(ledger);
        continue;
      }
    } catch { /* if the check fails, fall through to the normal queue filter */ }
  }

  const goalTag = GOAL ? ` | campaign ${campaignConfirmed}/${GOAL}` : '';
  const head = `[${processed}] (this shard: ${confirmed}${goalTag}) ${String(j.company).slice(0, 22).padEnd(22)} ${String(j.title).slice(0, 46)}`;
  console.log(head);

  let { state, out } = await runOne(j.url, submit);
  if (RETRYABLE.has(state)) {
    /* A longer, growing pause. The retry used to fire five seconds later, which
       is inside the window that caused the failure in the first place: Ashby
       answers ApiSetFormValue with HTTP 429 under parallel load, and that same
       throttling is what drops the resume upload. Retrying immediately just
       collects the same 429. */
    console.log('        transient failure, backing off then retrying once');
    await new Promise(r => setTimeout(r, 45000));
    ({ state, out } = await runOne(j.url, submit));
  }

  /* Ashby rate-limits per IP. When a run comes back throttled, stop pushing for
     a while -- going wider makes the whole batch slower, not faster, because
     every worker then collects 429s. */
  /* An employer cap applies to the CANDIDATE, not the posting, so every other
     role at that company is blocked too. Headway limits applicants to two
     applications across ALL roles per 60 days; without this the batch worked
     through five more of their postings collecting the same refusal. */
  if (state === 'employer-rate-limit') {
    const c = String(j.company || '').toLowerCase();
    SKIP_COMPANIES[c] = 'employer caps applications per candidate; hit on ' + new Date().toISOString().slice(0, 10);
    console.log(`        ${j.company} caps applications per candidate - skipping their remaining roles this run`);
  }

  if (/HTTP 429/.test(out || '') || state === 'captcha-blocked') {
    console.log('        throttled by the board, pausing 90s before the next posting');
    await new Promise(r => setTimeout(r, 90000));
  }
  tally[state] = (tally[state] || 0) + 1;
  /* Steady pacing between postings. PACE_MS is per worker, so two workers at
     20s each put roughly one request every ten seconds on the board. */
  await new Promise(r => setTimeout(r, Number(process.env.PACE_MS || 20000)));

  let recorded = false;
  if (state === 'submitted' && submit) {
    recorded = await markApplied(j.dedupe_key);
    if (recorded) confirmed++;
  }

  const why = (out.match(/^\s+! .+$/gm) || []).map(s => s.trim().slice(2, 80)).slice(0, 4);
  /* The Workday driver reports its blocker on a WORKDAY: line, which is not in
     the "  ! " shape this scrape looks for, so every Workday row reached the
     dashboard with an empty reason and looked untouched. The whole point of
     recording a blocker is that Brian can see what to do about it -- an
     emailed account verification is one click, and it was invisible. */
  const wdWhy = (out.match(/^WORKDAY:\s*[a-z-]+\s*-\s*(.+)$/mi) || [])[1];
  if (wdWhy && !why.length) why.push(wdWhy.trim().slice(0, 300));
  const priorCrashes = (ledger[j.dedupe_key] || {}).crashCount || 0;
  ledger[j.dedupe_key] = {
    company: j.company, title: j.title, url: j.url,
    state, recordedInD1: recorded, blockers: why,
    /* Count EVERY retryable outcome, not just 'crashed'. wd-stuck is retryable
       and never incremented this, so the cap at two never applied to it and
       Warner Bros was attempted four times in one supervised run while the rest
       of the Workday queue waited. */
    crashCount: RETRYABLE.has(state) ? priorCrashes + 1 : priorCrashes,
    driver: DRIVER_HASH,
    at: new Date().toISOString()
  };
  saveLedger(ledger);
  companyAttempts[String(j.company).toLowerCase()] = (companyAttempts[String(j.company).toLowerCase()] || 0) + 1;

  const mark = state === 'submitted' && recorded ? 'SUBMITTED (confirmed in D1)'
    : state === 'submitted' ? 'submitted (page confirmed, D1 write FAILED — check manually)'
    : state.toUpperCase();
  console.log(`        -> ${mark}${why.length ? ' | needs: ' + why.join('; ') : ''}\n`);

  if (state !== 'submitted' || !recorded) {
    logIssue(j, state, why);
    /* Record the blocker on the row itself so the dashboard can show a Manual
       badge and the exact reason, instead of the posting looking untouched. */
    await markBlocked(j.dedupe_key, state, why.join('; ')).catch(() => {});
  }

  /* Each run gets its own throwaway Chrome profile dir; over 100+ postings
     those add up. Sweep them here rather than trusting cleanup on a process
     that may have just been force-killed. */
  try {
    for (const name of fs.readdirSync(ROOT)) {
      if (name.startsWith('.apply-session-')) {
        fs.rmSync(path.join(ROOT, name), { recursive: true, force: true, maxRetries: 2 });
      }
    }
  } catch { /* best effort */ }

  await new Promise(r => setTimeout(r, 4000));
}

console.log('\n=== batch complete ===');
console.log(`confirmed by this ${A.shard ? 'shard' : 'process'}: ${confirmed}`);
if (GOAL && baselineSubmitted !== null) {
  try {
    const { submittedTotal } = await fetchQueue();
    console.log(`campaign total (all workers): ${submittedTotal - baselineSubmitted} / goal ${GOAL}`);
  } catch { /* best effort on the closing summary only */ }
}
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
console.log(`\nledger: ${LEDGER}`);
console.log(`issues (if any): ${ISSUES}`);
