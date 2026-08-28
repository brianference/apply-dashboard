/**
 * Reaching into the database for something a test cannot get any other way.
 *
 * The verify token only exists in an email, and the row stores its SHA-256, so
 * a test cannot read it back. This mints its own verify token for an account
 * instead - it is testing whether the ROUTE works, not whether mail arrives,
 * which is proved separately against the provider's delivery log.
 */

import crypto from 'node:crypto';

const ACCOUNT = 'dd01b432f0329f87bb1cc1a3fad590ee';
const DATABASE = '10e8a6c0-1fa7-4c33-a007-2044876ce6a7';

/**
 * @param {string} sql
 * @param {Array<string|number|null>} [params]
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

/**
 * A usable verify token for an account, minted for the test.
 *
 * @param {string} email
 * @returns {Promise<string|null>}
 */
export async function verifyToken(email) {
  const user = (await q('SELECT id FROM users WHERE email = ?', [email]))[0];
  if (!user) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  await q(
    "INSERT INTO email_tokens (id, user_id, purpose, created_at, expires_at) VALUES (?,?,'verify',?,?)",
    [crypto.createHash('sha256').update(token).digest('hex'), user.id, now.toISOString(), new Date(now.getTime() + 3600000).toISOString()]
  );
  return token;
}

/**
 * Remove a test account and everything it owns.
 * @param {string} email
 * @returns {Promise<void>}
 */
export async function deleteAccount(email) {
  const user = (await q('SELECT id FROM users WHERE email = ?', [email]))[0];
  if (!user) return;
  for (const table of ['sessions', 'email_tokens', 'user_jobs', 'profile']) {
    await q(`DELETE FROM ${table} WHERE user_id = ?`, [user.id]);
  }
  await q('DELETE FROM users WHERE id = ?', [user.id]);
}

/**
 * Does an account with this address exist?
 *
 * Registration answers HTTP 200 with the same generic message whether it
 * created an account or refused one, because a different answer would let a
 * stranger discover which addresses are registered. That also means a caller
 * cannot tell success from refusal by the status code, so the row is the only
 * honest signal.
 *
 * @param {string} email
 * @returns {Promise<boolean>}
 */
export async function accountExists(email) {
  return (await q('SELECT id FROM users WHERE email = ?', [email])).length > 0;
}

/**
 * How many registrations this IP has attempted in the limiter's window.
 * Registration is capped at 5 per hour, so a test run that has already made
 * several is refused silently, and every later step then fails for a reason
 * that has nothing to do with the product.
 *
 * @returns {Promise<number>}
 */
export async function recentRegisterAttempts() {
  const rows = await q(
    "SELECT COUNT(*) AS n FROM auth_attempts WHERE kind = 'register' AND at >= datetime('now', '-60 minutes')"
  );
  return Number((rows[0] && rows[0].n) || 0);
}
