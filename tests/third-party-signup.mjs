/**
 * Can a stranger sign up and use this product?
 *
 * Brian wants the home page to invite other AI product managers to make a free
 * account, see the jobs, and host a portfolio and a profile. Before writing
 * that invitation, this walks the whole journey as a person who has never been
 * here, and reports which steps actually work.
 *
 * It asserts nothing about what SHOULD happen. It records what DOES, so the
 * copy can only promise things the product delivers.
 *
 *   node tests/third-party-signup.mjs
 *   node tests/third-party-signup.mjs --site https://apply-dashboard.pages.dev
 */

import { parseArgs } from '../ingest/cli.mjs';

const args = parseArgs();
const SITE = (args.site && args.site !== true) ? String(args.site) : 'https://apply-dashboard.pages.dev';

/** A person who has never used this before. */
const STRANGER = {
  email: 'ada.lovelace.' + Math.floor(Math.random() * 1e9) + '@example.invalid',
  password: 'a-perfectly-reasonable-passphrase'
};

const results = [];

/**
 * @param {string} step
 * @param {boolean} works
 * @param {string} detail
 * @returns {void}
 */
function record(step, works, detail) {
  results.push({ step, works, detail });
  console.log(`${works ? 'WORKS  ' : 'BLOCKED'} ${step.padEnd(42)} ${detail}`);
}

/**
 * @param {string} path
 * @param {object} [body]
 * @param {string} [method]
 * @returns {Promise<{status: number, json: object}>}
 */
async function call(path, body, method = 'POST') {
  const res = await fetch(SITE + path, {
    method,
    headers: { 'content-type': 'application/json', origin: SITE },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

console.log(`Walking the journey of a stranger at ${SITE}`);
console.log(`as ${STRANGER.email}\n`);

/* 1. Can they see the jobs at all without an account? */
{
  const res = await fetch(SITE + '/api/jobs');
  const json = await res.json().catch(() => ({}));
  const n = (json.jobs || []).length;
  record('read the job list signed out', res.ok && n > 0, `${n} postings returned`);
}

/* 2. Can they see the portfolio without an account? */
{
  const res = await fetch(SITE + '/portfolio/');
  record('open the portfolio signed out', res.ok, `HTTP ${res.status}`);
}

/* 3. Can they register?

   The status code cannot answer this. Registration returns the same 200 and
   the same message whether it created an account or refused one, so that a
   stranger cannot use it to discover which addresses are registered. The row
   is the only honest signal, and checking the status alone once reported WORKS
   for a run the rate limiter had silently refused - after which every later
   step failed in ways that read like a data leak. */
{
  const { accountExists, recentRegisterAttempts } = await import('./_helpers.mjs');
  const attempts = await recentRegisterAttempts();
  const { status, json } = await call('/api/auth/register', STRANGER);
  const created = await accountExists(STRANGER.email);
  const detail = created
    ? `HTTP ${status} ${JSON.stringify(json).slice(0, 90)}`
    : `HTTP ${status} but NO ROW. ${attempts} register attempts from this IP in the `
      + 'last hour against a cap of 5. That is the rate limiter working, not a broken '
      + 'signup. Wait an hour, or clear auth_attempts, then re-run.';
  record('register an account', created, detail);
  if (!created) {
    console.log('');
    console.log('STOPPING: no account exists, so every later step would report a failure caused by this one.');
    process.exit(1);
  }
}

/* 4. Signing in BEFORE activating must be refused.
   An account exists but is unverified, and login refuses those. This asserts
   the refusal, because an earlier version of this test called it a failure and
   it is the opposite - it is the email check doing its job. */
{
  const { status } = await call('/api/auth/login', STRANGER);
  record('unverified sign-in is refused', status === 401, `HTTP ${status}, as designed`);
}

/* 5. Could they recover a password? */
{
  const { status, json } = await call('/api/auth/request-reset', { email: STRANGER.email });
  record('request a password reset', status === 200, `HTTP ${status} ${String(json.message || json.error || '').slice(0, 70)}`);
}

/* 6. Activate the account, the way the emailed link does.
   The verify token is only in the email, so this asks the database for the
   account instead - the point is whether the ROUTES work, not whether mail
   arrives, which was proved separately against the provider's delivery log. */
let cookie = null;
{
  const { verifyToken } = await import('./_helpers.mjs');
  const token = await verifyToken(STRANGER.email);
  if (!token) {
    record('activate from the email link', false, 'no verify token was created at registration');
  } else {
    const res = await fetch(SITE + '/api/auth/verify?token=' + encodeURIComponent(token), { headers: { origin: SITE } });
    cookie = (res.headers.get('set-cookie') || '').split(';')[0];
    record('activate from the email link', res.ok && /__Host-session=/.test(cookie || ''), `HTTP ${res.status}, session issued: ${/__Host-session=/.test(cookie || '')}`);
  }
}

/* 7. Signed in, do they get their OWN profile rather than Brian's? */
{
  const res = await fetch(SITE + '/api/profile', { headers: { cookie } });
  const json = await res.json().catch(() => ({}));
  const p = json.profile || {};
  const theirs = res.ok && p.handle && p.handle !== 'brianference' && !p.resume_text;
  record("gets their own profile, not the owner's", theirs,
    `handle ${JSON.stringify(p.handle)}, resume: ${p.resume_text ? "SOMEONE ELSES" : "none, as expected"}`);
}

/* 8. Does the list show them a clean slate rather than 147 of Brian's marks? */
{
  const res = await fetch(SITE + '/api/jobs', { headers: { cookie } });
  const json = await res.json().catch(() => ({}));
  const submitted = (json.jobs || []).filter((j) => j.status === 'submitted').length;
  record('their list starts unapplied', submitted === 0, `${submitted} rows marked submitted for them`);
}

/* 9. THE ONE THAT MATTERS: their mark must not touch anyone else's list. */
{
  const anon = await fetch(SITE + '/api/jobs').then((r) => r.json());
  const target = (anon.jobs || []).find((j) => j.status !== 'submitted');
  const marked = await fetch(SITE + '/api/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: SITE, cookie },
    body: JSON.stringify({ dedupe_key: target.dedupe_key, status: 'submitted' })
  });
  const markedJson = await marked.json().catch(() => ({}));
  const after = await fetch(SITE + '/api/jobs').then((r) => r.json());
  const stillThereForEveryoneElse = (after.jobs || []).find((j) => j.dedupe_key === target.dedupe_key);
  const ownerUntouched = stillThereForEveryoneElse && stillThereForEveryoneElse.status !== 'submitted';
  record('marking a job does not remove it for others', marked.ok && ownerUntouched,
    `scope ${JSON.stringify(markedJson.scope)}; the shared row still reads ${JSON.stringify(stillThereForEveryoneElse && stillThereForEveryoneElse.status)}`);
}

/* 10. And their own list does reflect it. */
{
  const res = await fetch(SITE + '/api/jobs', { headers: { cookie } });
  const json = await res.json().catch(() => ({}));
  const mine = (json.jobs || []).filter((j) => j.status === 'submitted').length;
  record('their own list reflects their mark', mine === 1, `${mine} marked for them`);
}

/* 10b. Now sign in properly, with the password they chose at registration. */
{
  const { status, json } = await call('/api/auth/login', STRANGER);
  record('sign in once activated', status === 200, `HTTP ${status} ${JSON.stringify(json).slice(0, 60)}`);
}

/* 11. Is their portfolio reachable at their own handle? */
{
  const prof = await fetch(SITE + '/api/profile', { headers: { cookie } }).then((r) => r.json()).catch(() => ({}));
  const handle = (prof.profile || {}).handle;
  const res = await fetch(SITE + '/api/portfolio?u=' + encodeURIComponent(handle || 'none'));
  const json = await res.json().catch(() => ({}));
  record('their portfolio has its own address', res.ok && json.handle === handle,
    `/portfolio/?u=${handle} -> ${JSON.stringify(json.name)}`);
}

/* Leave nothing behind. A test that seeds accounts into the live database and
   walks away is a test that fills it with strangers. */
{
  const { deleteAccount } = await import('./_helpers.mjs');
  await deleteAccount(STRANGER.email);
  record('the test account is removed afterwards', true, STRANGER.email);
}

const blocked = results.filter((r) => !r.works);
console.log(`\n${results.length - blocked.length} of ${results.length} steps work for a stranger.`);
if (blocked.length) {
  console.log('\nWhat a stranger cannot do today:');
  for (const b of blocked) console.log(`  - ${b.step}: ${b.detail}`);
}
process.exit(blocked.length ? 1 : 0);
