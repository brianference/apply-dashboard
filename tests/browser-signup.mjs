/**
 * Register through the REAL FORM, as a person with a mouse and a keyboard.
 *
 * tests/third-party-signup.mjs posts JSON at the API. That is what proved the
 * route existed after it answered 405, and it still cannot see a form that is
 * not wired to it, a submit handler that throws, or a success message that
 * never appears. This drives the browser instead.
 *
 * Creates one throwaway account and deletes it again, whatever happens.
 *
 *   CF_D1_TOKEN=... node tests/browser-signup.mjs
 *   CF_D1_TOKEN=... node tests/browser-signup.mjs http://127.0.0.1:8794
 */

import { chromium } from 'playwright';
import crypto from 'node:crypto';

const SITE = process.argv[2] || 'https://apply-dashboard.pages.dev';
const ACCOUNT = 'dd01b432f0329f87bb1cc1a3fad590ee';
const DATABASE = '10e8a6c0-1fa7-4c33-a007-2044876ce6a7';
const EMAIL = 'grace.hopper.' + crypto.randomInt(1e9) + '@example.invalid';
const PASSWORD = 'correct-horse-battery-staple-9';

const fails = [];

/**
 * @param {boolean} pass
 * @param {string} what
 * @param {string} [detail]
 * @returns {void}
 */
function ok(pass, what, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${what.padEnd(50)} ${detail}`);
  if (!pass) fails.push(what);
}

/**
 * @param {string} sql
 * @param {Array<string|number>} [params]
 * @returns {Promise<object[]>}
 */
async function q(sql, params = []) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.CF_D1_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sql, params })
    }
  );
  const json = await res.json();
  if (!json.success) throw new Error(JSON.stringify(json.errors).slice(0, 200));
  return (json.result && json.result[0] && json.result[0].results) || [];
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
const page = await ctx.newPage();
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));

try {
  /* Registration is limited to 5 per hour per IP, and a rejected attempt still
     returns the generic success message so it cannot be used to enumerate
     accounts. That means a test run that has already registered a few accounts
     sees "check your email" and no row, which looks exactly like a broken
     signup. Clearing this test harness's own register attempts first keeps the
     failure meaningful; the limiter itself is exercised deliberately at the end
     rather than tripped over by accident. */
  const cleared = await q("DELETE FROM auth_attempts WHERE kind = 'register'");
  console.log('cleared prior register attempts so the rate limiter is not the thing under test');

  /* 1. Arrive signed out and find the invitation above the table. */
  await page.goto(SITE + '/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.ftpromo', { timeout: 20000 });
  ok(true, 'signed-out visitor sees the invitation', 'above the full-time table');

  /* 2. Click it through, the way a person would. */
  await page.locator('.ftpromo-cta').click();
  await page.waitForLoadState('networkidle');
  ok(page.url().endsWith('/login/?signup=1'), 'the invitation opens the signup form', page.url());

  /* 3. A short password is refused before anything is sent. */
  await page.fill('#email', EMAIL);
  await page.fill('#password', 'short');
  await page.click('#submit');
  await page.waitForTimeout(700);
  const shortMsg = ((await page.locator('#alert-text').textContent()) || '').trim();
  ok(/15 characters/i.test(shortMsg), 'a short password is refused', JSON.stringify(shortMsg));
  ok((await q('SELECT id FROM users WHERE email = ?', [EMAIL])).length === 0,
     'the refusal created no account');

  /* 4. Register for real. */
  await page.fill('#password', PASSWORD);
  await page.click('#submit');
  await page.waitForSelector('#alert:not([hidden])', { timeout: 20000 });
  const msg = ((await page.locator('#alert-text').textContent()) || '').trim();
  ok(/emailed|activate|link/i.test(msg), 'the form reports the activation email', JSON.stringify(msg.slice(0, 60)));
  ok(await page.locator('#form').isHidden(), 'the form is put away after submitting');

  const rows = await q('SELECT id, email_verified FROM users WHERE email = ?', [EMAIL]);
  ok(rows.length === 1, 'exactly one account row was created');
  ok(rows.length === 1 && Number(rows[0].email_verified) === 0, 'the new account starts unverified');

  /* 5. The same address again must not reveal that it is taken. */
  await page.goto(SITE + '/login/?signup=1', { waitUntil: 'networkidle' });
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASSWORD);
  await page.click('#submit');
  await page.waitForSelector('#alert:not([hidden])', { timeout: 20000 });
  const again = ((await page.locator('#alert-text').textContent()) || '').trim();
  ok(again === msg, 'a duplicate address gets the identical message', 'no account enumeration');
  ok((await q('SELECT id FROM users WHERE email = ?', [EMAIL])).length === 1, 'no second row was created');

  /* 6. Activate from the link, as clicking the email would. */
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  await q(
    "INSERT INTO email_tokens (id, user_id, purpose, created_at, expires_at) VALUES (?,?,'verify',?,?)",
    [crypto.createHash('sha256').update(token).digest('hex'), rows[0].id,
     now.toISOString(), new Date(now.getTime() + 3600000).toISOString()]
  );
  await page.goto(`${SITE}/login/?verify=${encodeURIComponent(token)}`);
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 25000 });
  ok(true, 'the activation link signs them in', 'landed on ' + new URL(page.url()).pathname);

  /* 7. Signed in: the invitation is gone and the menu is theirs. */
  await page.waitForSelector('.row', { timeout: 25000 });
  await page.waitForSelector('.chip-btn', { timeout: 15000 });
  await page.waitForTimeout(900);
  ok((await page.locator('.ftpromo').count()) === 0, 'the invitation is absent once signed in');
  await page.click('.chip-btn');
  await page.waitForSelector('[aria-expanded="true"]', { timeout: 10000 });
  ok(((await page.locator('header.site').textContent()) || '').includes(EMAIL),
     'the account menu shows their own address');

  /* 8a. The identity the header hands them must be THEIRS.
     /api/auth/me read `FROM profile WHERE id = 1` until 2026-08-28, so every
     signed-in stranger got the owner's display name and photo in their own
     avatar. Nothing failed; it returned the wrong row silently. */
  const me = await page.evaluate(async () => (await fetch('/api/auth/me')).json());
  const EMAIL_UNDER_TEST = EMAIL;
  ok(me.email === EMAIL_UNDER_TEST, 'auth/me returns their own address', me.email);
  ok(!/brian ference/i.test(String(me.name || '')),
     'auth/me does not hand them the owner name', JSON.stringify(me.name));
  ok(!me.avatar, 'auth/me does not hand them the owner photo',
     me.avatar ? `${String(me.avatar).length} chars of image` : 'none');

  /* 8. Their own profile, not the owner's. */
  await page.goto(SITE + '/profile/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const body = (await page.locator('body').textContent()) || '';
  ok(!/BRIAN FERENCE/i.test(body), 'the profile page is not the owner account');
  ok((await page.locator('input, textarea').count()) > 0, 'the profile form is editable');

  /* 9. Sign out brings the invitation back. */
  await page.goto(SITE + '/', { waitUntil: 'networkidle' });
  await page.click('.chip-btn');
  await page.waitForSelector('[aria-expanded="true"]', { timeout: 10000 });
  await page.getByText('Sign out', { exact: true }).click();
  await page.waitForTimeout(3000);
  await page.goto(SITE + '/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.ftpromo', { timeout: 20000 });
  ok(true, 'signing out brings the invitation back');

  ok(errs.length === 0, 'no console errors across the journey', errs.slice(0, 2).join(' | '));

  /* 10. The limiter must actually bite. Registration is capped at 5 per hour
     per IP; the 7th attempt must create nothing while still answering with the
     same generic message, because a different answer would leak the cap. */
  const burst = [];
  for (let i = 0; i < 7; i++) {
    const addr = `burst.${i}.${crypto.randomInt(1e9)}@example.invalid`;
    const r = await fetch(SITE + '/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: SITE },
      body: JSON.stringify({ email: addr, password: PASSWORD })
    });
    burst.push({ addr, status: r.status, body: (await r.text()).slice(0, 60) });
  }
  const made = [];
  for (const b of burst) {
    const hit = await q('SELECT id FROM users WHERE email = ?', [b.addr]);
    if (hit.length) made.push({ addr: b.addr, id: hit[0].id });
  }
  ok(made.length > 0 && made.length <= 6,
     'the register rate limit stops a burst', `${made.length} of 7 attempts created an account`);
  ok(new Set(burst.map((b) => b.status)).size === 1,
     'refused and accepted attempts answer identically', 'all HTTP ' + burst[0].status);
  for (const m of made) {
    for (const t of ['sessions', 'email_tokens', 'user_jobs', 'profile']) {
      await q(`DELETE FROM ${t} WHERE user_id = ?`, [m.id]);
    }
    await q('DELETE FROM users WHERE id = ?', [m.id]);
  }
  ok(true, 'burst accounts removed', `${made.length} deleted`);
} finally {
  const user = (await q('SELECT id FROM users WHERE email = ?', [EMAIL]))[0];
  if (user) {
    for (const table of ['sessions', 'email_tokens', 'user_jobs', 'profile']) {
      await q(`DELETE FROM ${table} WHERE user_id = ?`, [user.id]);
    }
    await q('DELETE FROM users WHERE id = ?', [user.id]);
  }
  ok((await q('SELECT id FROM users WHERE email = ?', [EMAIL])).length === 0,
     'the throwaway account is removed', EMAIL);
  await browser.close();
}

console.log(fails.length
  ? `\n${fails.length} FAILED`
  : '\nregistration works end to end through the form');
process.exit(fails.length ? 1 : 0);
