/**
 * Classify a posting page from signals collected in a real browser.
 *
 * Recaptcha SCRIPT TAG presence is ignored. Greenhouse and Ashby include one
 * on pages that still render an apply control.
 */

const SUSPENDED_HOST = /suspended-domain\.net|parked-domain|domain-for-sale/i;
const CLOSED = /\bno longer (accepting|active|available)\b|\bthis job (is closed|has expired|posting is closed|has been filled)\b|\bposition (has been filled|is no longer available|has been closed)\b|\bjob posting is no longer\b|\bthis (posting|listing) has expired\b/i;
const SECURITY_WALL = /performing security verification|unusual traffic|checking your browser|just a moment|enable javascript to continue|access denied|attention required|cf-challenge/i;
const SIGN_IN = /sign in to (view|continue|see|who)|log in to (view|continue)|join to (view|apply)|authwall|sign in to view this job|you must (sign|log) in|sign in with email|continue with google/i;

/**
 * @param {{
 *   url: string,
 *   finalUrl: string,
 *   httpStatus: number,
 *   title?: string,
 *   bodyText?: string,
 *   hasApplyControl: boolean,
 *   hasRecaptchaScript?: boolean,
 *   applyWall?: boolean,
 *   signInModal?: boolean
 * }} signals
 * @returns {"live"|"wall"|"dead"}
 */
export function classifyPage(signals) {
  const httpStatus = Number(signals.httpStatus) || 0;
  const finalUrl = signals.finalUrl || signals.url || "";
  const title = signals.title || "";
  const bodyText = signals.bodyText || "";
  const surface = `${title}\n${bodyText}\n${finalUrl}`;

  if (httpStatus === 404 || httpStatus === 410) return "dead";
  if (httpStatus === 0) return "dead";
  if (SUSPENDED_HOST.test(finalUrl) || SUSPENDED_HOST.test(title)) return "dead";
  if (CLOSED.test(surface)) return "dead";

  if (httpStatus === 401 || httpStatus === 403) return "wall";
  if (signals.applyWall) return "wall";
  if (signals.signInModal) return "wall";
  if (SECURITY_WALL.test(surface)) return "wall";
  if (SIGN_IN.test(surface) || /\/authwall|\/login|\/checkpoint\//i.test(finalUrl)) return "wall";
  if (/linkedin\.com/i.test(finalUrl) && /sign in|join now/i.test(surface)) return "wall";

  if (signals.hasApplyControl) return "live";
  if (/\bapply for this job\b|\bsubmit application\b/i.test(bodyText)) return "live";

  return "dead";
}
