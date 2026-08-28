/**
 * Transactional email, through Brevo.
 *
 * Verified live on 2026-08-27: GET https://api.brevo.com/v3/account returned
 * 200 on a free plan with 300 sends, and GET /v3/senders lists
 * brianference@protonmail.com as an active, verified sender. Sending from an
 * address Brevo has not verified is rejected, so MAIL_FROM must stay that one
 * unless another is verified in the Brevo dashboard first.
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
