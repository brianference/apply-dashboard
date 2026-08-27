/**
 * Every network call the page makes, in one place.
 *
 * The write token is never in page source. It is pasted once and kept in
 * localStorage, the same way the main dashboard does it.
 */

const TOKEN_KEY = "apply-token";

/**
 * @returns {string} the stored write token, or an empty string
 */
export function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

/**
 * @param {string} token
 * @returns {boolean} whether it could be stored
 */
export function storeToken(token) {
  try {
    localStorage.setItem(TOKEN_KEY, String(token || "").trim());
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} path
 * @returns {Promise<object>}
 */
async function get(path) {
  const res = await fetch(path, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return res.json();
}

/**
 * @param {string} path
 * @param {object} body
 * @returns {Promise<object>}
 */
async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-apply-token": readToken() },
    body: JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `${path} returned ${res.status}`);
  return json;
}

/** @returns {Promise<{jobs: object[]}>} */
export const fetchJobs = () => get("/api/jobs");

/** @returns {Promise<{experiments: object[]}>} */
export const fetchExperiments = () => get("/api/experiments");

/**
 * @param {string} name
 * @returns {Promise<{experiment: string, assignments: object[]}>}
 */
export const fetchExperiment = (name) => get(`/api/experiments?name=${encodeURIComponent(name)}`);

/** @returns {Promise<{stages: string[], outcomes: object[]}>} */
export const fetchOutcomes = () => get("/api/outcomes");

/**
 * @param {string} dedupeKey
 * @param {string} experiment
 * @param {string} arm
 * @returns {Promise<object>}
 */
export const assignArm = (dedupeKey, experiment, arm) =>
  post("/api/experiments", { dedupe_key: dedupeKey, experiment, arm });

/**
 * @param {string} dedupeKey
 * @param {string} stage
 * @param {string} occurredOn
 * @param {string} [note]
 * @returns {Promise<object>}
 */
export const recordOutcome = (dedupeKey, stage, occurredOn, note) =>
  post("/api/outcomes", { dedupe_key: dedupeKey, stage, occurred_on: occurredOn, note });
