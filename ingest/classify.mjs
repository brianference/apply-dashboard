/**
 * Classify a posting page from signals collected in a real browser.
 *
 * Recaptcha SCRIPT TAG presence is ignored. Greenhouse and Ashby include one
 * on pages that still render an apply control.
 *
 * FOUR states since 2026-09-10, and the fourth is the point. Two paths used to
 * return "dead" on no evidence of death at all:
 *
 *   httpStatus 0 means the navigation THREW -- a timeout or a network error.
 *   QuinStreet and Pinterest both timed out and were called dead; asked again
 *   through their board API and page text they returned 6,265 and 7,086
 *   characters of live posting.
 *
 *   The final fallthrough called any 200 page with no detectable apply control
 *   dead. Adobe, Capital One and Cisco serve a 148-character Workday shell that
 *   renders its button in JS, and ServiceNow's page carries 8,420 characters
 *   and an apply flow this detector simply missed.
 *
 * Of twelve rows this file called dead, five were dead, three were live and
 * four were unknowable from the page alone. Guessing "dead" on silence retires
 * real jobs, and a wrongly-retired row is one he never sees again. Absence of
 * evidence gets its own name now.
 */

const SUSPENDED_HOST = /suspended-domain\.net|parked-domain|domain-for-sale/i;
/* "the job you are looking for is no longer open" is Greenhouse's own wording
   on a pulled posting, read off Boostlingo's and ConnectWise's pages on
   2026-09-10. Without it both fell to unknown -- correct in the sense that the
   pattern had no evidence, wrong in the sense that the page was stating it
   plainly in the one place worth reading. */
const CLOSED = /\bno longer (accepting|active|available)\b|\bthis job (is closed|has expired|posting is closed|has been filled)\b|\bposition (has been filled|is no longer available|has been closed)\b|\bjob posting is no longer\b|\bthis (posting|listing) has expired\b|\bthe job you are looking for is no longer open\b|\bjob you are looking for is no longer\b/i;
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
 * @returns {"live"|"wall"|"dead"|"unknown"}
 */
export function classifyPage(signals) {
  const httpStatus = Number(signals.httpStatus) || 0;
  const finalUrl = signals.finalUrl || signals.url || "";
  const title = signals.title || "";
  const bodyText = signals.bodyText || "";
  const surface = `${title}\n${bodyText}\n${finalUrl}`;

  if (httpStatus === 404 || httpStatus === 410) return "dead";
  /* The navigation threw. That is no evidence about the posting. */
  if (httpStatus === 0) return "unknown";
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

  /* A 200 with no apply control the detector could find. The page said
     nothing about being closed -- CLOSED was tested above and did not match
     -- so the honest answer is that this page did not tell us. */
  return "unknown";
}
