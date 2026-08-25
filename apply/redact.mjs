/**
 * One place that decides what must never be printed.
 *
 * Written because a reporter that printed every field value printed the Cisco
 * account password in full. The lesson is not "remember to avoid that page":
 * any tool that dumps form state will hit a secret eventually, so redaction
 * belongs in a shared function that every reporter calls, and it keys off the
 * input TYPE and the field NAME rather than off a page the author anticipated.
 */

/** Field names that carry a secret whatever the input type says. */
/* Separators are [ _-], not just [_-]: a LABEL reads "Social Security Number"
   with spaces, and the space-less pattern let it through. */
export const SECRET_NAME = /password|passwd|passcode|secret|token|api[ _-]?key|\bssn\b|social[ _-]?security|tax[ _-]?id|national[ _-]?id|bank[ _-]?account|routing|account[ _-]?number|card[ _-]?number|\bcvv\b|security[ _-]?code/i;

/**
 * Should this field's value be hidden?
 * @param {{type?:string, name?:string, id?:string, label?:string, automationId?:string}} field
 * @returns {boolean}
 */
export function isSecret(field = {}) {
  if (String(field.type || '').toLowerCase() === 'password') return true;
  const text = [field.name, field.id, field.label, field.automationId].filter(Boolean).join(' ');
  return SECRET_NAME.test(text);
}

/**
 * The value as it is safe to print. Keeps the length, which is all a human
 * needs to confirm a field was filled.
 * @param {string} value
 * @param {object} field
 * @returns {string}
 */
export function safeValue(value, field = {}) {
  const v = value === null || value === undefined ? '' : String(value);
  if (!isSecret(field)) return v;
  return v ? `[redacted, ${v.length} chars]` : '';
}

/**
 * Last line of defence for free text about to be logged: if a known secret is
 * embedded in it, replace it. Pass the secrets you hold.
 * @param {string} text
 * @param {string[]} secrets
 * @returns {string}
 */
export function scrub(text, secrets = []) {
  let out = String(text === null || text === undefined ? '' : text);
  for (const s of secrets) {
    if (!s || String(s).length < 6) continue;
    out = out.split(String(s)).join(`[redacted, ${String(s).length} chars]`);
  }
  return out;
}
