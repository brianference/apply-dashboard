/**
 * POST /api/auth/request-reset — email a single-use link to set a password.
 *
 * Always the same 200 and the same body whether or not the address has an
 * account. OWASP's Authentication Cheat Sheet gives the correct wording as
 * "If that email address is in our database, we will send you an email to reset
 * your password." Returning anything different for a known address turns this
 * endpoint into an account enumeration oracle.
 *
 * This is also how the first password gets set. The account is created with an
 * unusable hash and no password is ever typed into a chat, a log or the repo.
 */

import { HEADERS, preflight } from "../_auth.js";
import { randomToken, sha256Hex, originAllowed, overLimit, ipBucket } from "../_session.js";
import { sendMail, linkEmail } from "../_mail.js";

/** One hour. Long enough to find the mail, short enough to matter. */
const TTL_MS = 60 * 60 * 1000;
const GENERIC = { ok: true, message: "If that email address is in our database, we will send you an email to reset your password." };

/**
 * @returns {Response}
 */
export function onRequestOptions() {
  return preflight("POST, OPTIONS");
}

/**
 * @param {{request: Request, env: {DB: D1Database, SITE_ORIGIN?: string}}} context
 * @returns {Promise<Response>}
 */
export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env || !env.DB) {
    return new Response(JSON.stringify({ error: "D1 binding DB is not bound" }), { status: 500, headers: HEADERS });
  }
  if (!originAllowed(request, env)) {
    return new Response(JSON.stringify({ error: "bad origin" }), { status: 403, headers: HEADERS });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "body must be JSON" }), { status: 400, headers: HEADERS });
  }
  const email = String(body.email || "").trim().toLowerCase();

  const tooMany = (await overLimit(env.DB, "email:" + email, "reset"))
    || (await overLimit(env.DB, await ipBucket(request), "reset"));
  if (tooMany) {
    /* Even the rate-limit answer is the generic one. A 429 only for addresses
       that exist would leak exactly what the generic body is hiding. */
    return new Response(JSON.stringify(GENERIC), { headers: HEADERS });
  }

  const user = email ? await env.DB.prepare("SELECT id, email FROM users WHERE email = ?1").bind(email).first() : null;

  if (user) {
    const token = randomToken(32);
    const now = new Date();
    await env.DB.prepare(
      "INSERT INTO email_tokens (id, user_id, purpose, created_at, expires_at) VALUES (?1, ?2, 'reset', ?3, ?4)"
    ).bind(await sha256Hex(token), user.id, now.toISOString(), new Date(now.getTime() + TTL_MS).toISOString()).run();

    /* Built from SITE_ORIGIN, never from the request's Host header. */
    const url = `${env.SITE_ORIGIN}/login/?token=${encodeURIComponent(token)}`;
    const mail = linkEmail(
      "Set your password",
      "Use the link below to set a password for AI PM Jobs. It works once and expires in an hour.",
      url,
      "Set password"
    );
    const sent = await sendMail(env, { to: user.email, subject: "Set your AI PM Jobs password", html: mail.html, text: mail.text });
    if (!sent.sent) {
      /* Logged here, never returned: the caller gets the generic body either
         way, so a mail outage cannot be used to probe for accounts. */
      console.warn("reset mail failed", sent.detail);
    }
  }

  return new Response(JSON.stringify(GENERIC), { headers: HEADERS });
}

/**
 * @returns {Response}
 */
export function onRequest() {
  return new Response(JSON.stringify({ error: "method not allowed" }), {
    status: 405, headers: { ...HEADERS, allow: "POST, OPTIONS" }
  });
}
