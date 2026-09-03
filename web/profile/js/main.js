/**
 * The private profile editor.
 *
 * Signed out it shows why it is empty rather than an empty form. The portfolio
 * is the public counterpart and is linked from here, so the difference between
 * the two is visible rather than something to remember.
 */

import { mountSiteNav, initialsFor } from "/shared/site-nav.js";
import { toAvatarDataUrl } from "./avatar.js";
import { mountSections } from "./sections.js";
import { mergeSections } from "./parse.js";

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
    ? `${data.resume_chars.toLocaleString()} characters of resume text stored. Import from resume below offers what the parser found, one item at a time. Contact details are never published on the portfolio.`
    : "No resume text stored yet, so there is nothing to import from.";

  /**
   * @param {object} [extra]
   * @returns {Promise<object>}
   */
  async function putProfile(extra) {
    const res = await fetch("/api/profile", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(extra || {})
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  }

  /* Auto-import on a first visit.
     mergeSections(null, parsed) returns the parse, so a person with nothing
     stored opens the page with their resume already laid out and editable
     rather than facing an empty form and a row of Import buttons.

     ONLY when nothing is stored. The moment sections exist, the parse stops
     being applied and becomes something to add from, because a parser that
     runs over saved work is the one failure this whole feature had to avoid.
     Persisting it immediately is what makes it real: an auto-fill that lives
     only in the DOM disappears on the next load and looks like data loss. */
  const storedSections = profile.profile_sections || null;
  const firstImport = !storedSections && data.suggested;
  const startingSections = firstImport
    ? mergeSections(null, data.suggested)
    : storedSections;

  const sectionEditor = mountSections(at("#sections"), {
    saved: startingSections,
    suggested: data.suggested || null,
    headerCheckbox: at("#vis-header"),
    onPersist: async (sections) => {
      try {
        await putProfile({ profile_sections: sections });
      } catch (error) {
        flash(String(error.message || error), true);
      }
    }
  });

  if (firstImport) {
    try {
      await putProfile({ profile_sections: startingSections });
      flash("Your resume is imported below. Edit anything, then Save.");
    } catch {
      /* A failed first write is not a reason to hide the parse: the sections
         are on screen and editable, and the next Save stores them. */
      flash("Imported from your resume. Save to keep it.", true);
    }
  }

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
      /* Include sections only when the person touched them. Sending the empty
         default on a headline-only save would publish empty experience and
         hide the resume-built fallback on the portfolio. */
      if (sectionEditor.isDirty()) payload.profile_sections = sectionEditor.getSections();
      await putProfile(payload);
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
