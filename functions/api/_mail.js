/**
 * Transactional email, through Brevo.
 *
 * MAIL_FROM must be an address on an AUTHENTICATED DOMAIN, currently
 * no-reply@txeas.com. It must NOT be brianference@protonmail.com, which is what
 * an earlier version of this comment said.
 *
 * That instruction was the bug. Sending as protonmail.com through Brevo fails
 * DMARC by construction: protonmail.com publishes `p=quarantine` with strict
 * alignment (aspf=s; adkim=s) and Brevo is not in its SPF record. Brevo logged
 * "delivered" for two messages that never reached the inbox, because the
 * receiving server accepted them and Proton then quarantined them. Verifying an
 * individual address in Brevo proves you control it; it does not authorise
 * Brevo to send AS that domain.
 *
 * txeas.com is authenticated and verified in Brevo, its SPF includes
 * spf.brevo.com and its DMARC is p=none. All three checked against live DNS on
 * 2026-08-28, and a send from it logged requests, delivered and opened.
 *
 * Reusing this elsewhere: copy the file, bind BREVO_API_KEY as a Pages secret,
 * set MAIL_FROM, and change the sender name below. Three traps recorded in
 * scholarship-one/docs/EMAIL-DELIVERABILITY-RUNBOOK.md - Brevo's "Authorized
 * IPs" must stay OFF because a serverless sender has no fixed IP; a messageId
 * means queued, not delivered, so confirm against /v3/smtp/statistics/events;
 * and domain authentication is dashboard-only on the free tier.
 */

const ENDPOINT = "https://api.brevo.com/v3/smtp/email";

/**
 * Send one message. Never throws: a mail outage must not turn a registration
 * or a reset into an error that tells the caller something went wrong, because
 * the generic response is what stops the endpoint enumerating accounts. The
 * failure is returned for the caller to log server-side instead.
 *
 * @param {{BREVO_API_KEY?: string, MAIL_FROM?: string}} env
 * @param {{to: string, subject: string, html: string, text: string}} message
 * @returns {Promise<{sent: boolean, detail?: string}>}
 */
export async function sendMail(env, message) {
  if (!env || !env.BREVO_API_KEY || !env.MAIL_FROM) {
    return { sent: false, detail: "BREVO_API_KEY or MAIL_FROM is not bound" };
  }
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "api-key": env.BREVO_API_KEY,
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({
        sender: { email: env.MAIL_FROM, name: "AI PM Jobs" },
        to: [{ email: message.to }],
        subject: message.subject,
        htmlContent: message.html,
        textContent: message.text
      })
    });
    if (!res.ok) {
      /* The provider's error text may name the address. Keep it server-side. */
      const detail = (await res.text()).slice(0, 300);
      return { sent: false, detail: `brevo ${res.status}: ${detail}` };
    }
    return { sent: true };
  } catch (error) {
    return { sent: false, detail: String((error && error.message) || error) };
  }
}

/**
 * The one-link email used for both verification and password reset.
 *
 * The link is built from SITE_ORIGIN by the caller, never from the request's
 * own Host header, which a caller controls and could point at their own site.
 *
 * @param {string} heading
 * @param {string} body
 * @param {string} url
 * @param {string} cta
 * @returns {{html: string, text: string}}
 */
export function linkEmail(heading, body, url, cta) {
  const safe = String(url);
  const html = `<!doctype html><html><body style="margin:0;background:#eef1f4;padding:28px;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1a232b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:520px;background:#fff;border:1px solid #d0d7de;border-radius:12px;padding:26px">
<tr><td>
<h1 style="margin:0 0 12px;font-size:20px;letter-spacing:-.01em">${heading}</h1>
<p style="margin:0 0 20px;line-height:1.55;color:#44525c">${body}</p>
<p style="margin:0 0 22px"><a href="${safe}" style="display:inline-block;background:#2c5266;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600">${cta}</a></p>
<p style="margin:0;font-size:13px;color:#44525c;line-height:1.5">If the button does not work, paste this into your browser:<br><span style="word-break:break-all">${safe}</span></p>
<p style="margin:16px 0 0;font-size:13px;color:#44525c">If you did not request this, ignore it and nothing changes.</p>
</td></tr></table></td></tr></table></body></html>`;
  const text = `${heading}\n\n${body}\n\n${cta}: ${safe}\n\nIf you did not request this, ignore it and nothing changes.\n`;
  return { html, text };
}
