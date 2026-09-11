/**
 * The email-pattern logic, re-exported for the ingest side.
 *
 * The implementation lives under web/ because the PAGE needs it too: the
 * derived address is built in the reader's browser so that no individual
 * address is ever written into this public repository. build-deploy.sh ships
 * web/* and nothing else, so a copy in ingest/ would either be dead in the
 * browser or a second implementation to keep in step. One file, two callers.
 */
export {
  asciiFold, localPartShape, nameParts, addressFor, derivePattern
} from '../web/outreach/js/email-pattern.js';
