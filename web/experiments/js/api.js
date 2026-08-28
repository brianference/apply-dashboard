/**
 * Every network call the page makes, in one place.
 *
 * Writes are authorised by the session cookie, which is HttpOnly - this file
 * cannot read it and does not need to. There is no token to paste, which is
 * why the token box is gone from the page.
 */

/**
 * @param {string} path
 * @returns {Promise<object>}
 */
async function get(path) {
  const res = await fetch(path, { credentials: "same-origin", headers: { "cache-control": "no-cache" } });
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
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
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
