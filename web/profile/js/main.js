/**
 * The private profile editor.
 *
 * Signed out it shows why it is empty rather than an empty form. The portfolio
 * is the public counterpart and is linked from here, so the difference between
 * the two is visible rather than something to remember.
 */

import { mountSiteNav, initialsFor } from "/shared/site-nav.js";
import { toAvatarDataUrl } from "./avatar.js";

const FIELDS = ["headline", "location", "linkedin_url", "github_url", "resume_filename"];

/* The handle is sent with the other fields but is NOT one of them: it is
   lowercased on the way out, and the server answers 409 when it is taken, which
   the save handler has to report differently from a validation message. */
const HANDLE_FIELD = "handle";

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
 * Point the "Open your portfolio" link at whatever is currently typed.
 *
 * The link is the only thing on this page that shows a person what their
 * address will actually be, so it tracks the box rather than the saved value.
 * With the box empty it falls back to /portfolio/, which is where an account
 * with no handle is served from.
 *
 * @returns {void}
 */
function updateHandleLink() {
  const typed = at(`#${HANDLE_FIELD}`).value.trim().toLowerCase();
  at("#handle-link").setAttribute("href", typed ? `/portfolio/${encodeURIComponent(typed)}` : "/portfolio/");
}

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
  at(`#${HANDLE_FIELD}`).value = profile.handle || "";
  updateHandleLink();
  at(`#${HANDLE_FIELD}`).addEventListener("input", updateHandleLink);

  /* ---- photo ---- */
  const preview = at("#avatar-preview");
  const initials = at("#avatar-initials");
  /**
   * @param {string|null} dataUrl
   * @returns {void}
   */
  const showAvatar = (dataUrl) => {
    if (dataUrl) {
      preview.setAttribute("src", dataUrl);
      preview.hidden = false;
      initials.hidden = true;
    } else {
      preview.removeAttribute("src");
      preview.hidden = true;
      initials.hidden = false;
      initials.textContent = initialsFor(who.email, profile.display_name || who.name);
    }
  };
  showAvatar(profile.avatar_data_url || null);

  /**
   * @param {string|null} dataUrl
   * @returns {Promise<void>}
   */
  const saveAvatar = async (dataUrl) => {
    const res = await fetch("/api/profile", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ avatar_data_url: dataUrl })
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  };

  at("#avatar-file").addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    flash("");
    try {
      const dataUrl = await toAvatarDataUrl(file);
      showAvatar(dataUrl);
      await saveAvatar(dataUrl);
      flash(`Photo saved, ${Math.round(dataUrl.length / 1024)}KB. It appears in the header on the next page load.`);
    } catch (error) {
      showAvatar(profile.avatar_data_url || null);
      flash(String(error.message || error), true);
    } finally {
      event.target.value = "";
    }
  });

  at("#avatar-remove").addEventListener("click", async () => {
    flash("");
    try {
      await saveAvatar(null);
      profile.avatar_data_url = null;
      showAvatar(null);
      flash("Photo removed. Your initials are shown instead.");
    } catch (error) {
      flash(String(error.message || error), true);
    }
  });
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
      payload[HANDLE_FIELD] = at(`#${HANDLE_FIELD}`).value.trim().toLowerCase();
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
