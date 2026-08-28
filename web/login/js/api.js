/**
 * Auth calls.
 *
 * Every write sends the browser's Origin automatically, which the API checks
 * against SITE_ORIGIN before it will act. There is no token to paste anywhere:
 * the session cookie is HttpOnly, so this file cannot read it and neither can
 * anything else running on the page.
 */

/**
 * @param {string} path
 * @param {object} body
 * @returns {Promise<object>}
 */
async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

/**
 * @param {string} email
 * @param {string} password
 * @returns {Promise<object>}
 */
export const login = (email, password) => post("/api/auth/login", { email, password });

/**
 * @param {string} email
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export const requestReset = (email) => post("/api/auth/request-reset", { email });

/**
 * @param {string} token
 * @param {string} password
 * @returns {Promise<object>}
 */
export const reset = (token, password) => post("/api/auth/reset", { token, password });

/**
 * @returns {Promise<{authenticated: boolean, email?: string}>}
 */
export const me = () =>
  fetch("/api/auth/me", { credentials: "same-origin", headers: { "cache-control": "no-cache" } })
    .then((r) => r.json());

/**
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export const register = (email, password) => post("/api/auth/register", { email, password });

/**
 * @param {string} token
 * @returns {Promise<object>}
 */
export const verify = (token) =>
  fetch("/api/auth/verify?token=" + encodeURIComponent(token), { credentials: "same-origin" })
    .then(async (res) => {
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Activation failed (${res.status})`);
      return json;
    });
