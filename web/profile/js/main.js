/**
 * The private profile editor.
 *
 * Signed out it shows why it is empty rather than an empty form. The portfolio
 * is the public counterpart and is linked from here, so the difference between
 * the two is visible rather than something to remember.
 */

import { mountSiteNav } from "/shared/site-nav.js";

const FIELDS = ["headline", "location", "linkedin_url", "github_url", "resume_filename"];

/**
 * @param {string} selector
 * @returns {HTMLElement}
 */
const at = (selector) => {
  const node = document.querySelector(selector);
  if (!node) throw new Error(`no element matches ${selector}`);
  return node;
};

/**
 * @param {string} message
 * @param {boolean} [bad]
 * @returns {void}
 */
function flash(message, bad = false) {
  const bar = at("#flash");
  bar.hidden = !message;
  bar.classList.toggle("bad", bad);
  bar.textContent = message || "";
}

/**
 * @returns {Promise<void>}
 */
async function start() {
  const who = await mountSiteNav("#sitenav");
  if (!who.authenticated) {
    at("#gate").hidden = false;
    return;
  }

  let data;
  try {
    const res = await fetch("/api/profile", { credentials: "same-origin", headers: { "cache-control": "no-cache" } });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    data = await res.json();
  } catch (error) {
    at("#editor").hidden = false;
    flash(String(error.message || error), true);
    return;
  }

  at("#editor").hidden = false;
  const profile = data.profile || {};
  for (const field of FIELDS) at(`#${field}`).value = profile[field] || "";
  at("#resume-status").textContent = data.resume_chars
    ? `${data.resume_chars.toLocaleString()} characters of resume text stored. The portfolio is built from this, with contact details stripped.`
    : "No resume text stored yet, so the portfolio has nothing to build its summary from.";

  at("#form").addEventListener("submit", async (event) => {
    event.preventDefault();
    flash("");
    const save = at("#save");
    save.disabled = true;
    save.textContent = "Saving…";
    try {
      const payload = {};
      for (const field of FIELDS) payload[field] = at(`#${field}`).value.trim();
      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload)
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      flash("Saved. The portfolio picks this up within five minutes.");
    } catch (error) {
      flash(String(error.message || error), true);
    } finally {
      save.disabled = false;
      save.textContent = "Save";
    }
  });
}

start();
