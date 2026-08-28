/**
 * Entry point. Fetches, then renders. Nothing else.
 */

import { el } from "./render.js";
import { fetchProfile } from "./api.js";
import { PROJECTS } from "./projects.js";
import { projectCard, repoList, lines } from "./render.js";
import { mountAuthNav } from "/shared/auth-nav.js";

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
 * @returns {Promise<void>}
 */
async function start() {
  /* The nav is shared with the rest of the product, but this page never
     REQUIRES a session - it is the one thing here meant to be handed out. */
  mountAuthNav("#authnav").catch(() => { /* signed out is the normal case here */ });

  at("#projects").replaceChildren(...PROJECTS.map(projectCard));

  let profile;
  try {
    profile = await fetchProfile();
  } catch (error) {
    at("#intro").replaceChildren(el("p", { class: "muted" }, [
      "The profile could not be loaded just now. The work below is unaffected."
    ]));
    return;
  }

  document.title = `${profile.name} — ${profile.headline || "Portfolio"}`;
  at("#name").textContent = profile.name;
  at("#headline").textContent = profile.headline || "";
  at("#location").textContent = profile.location || "";
  /* The resume separates summary paragraphs with SINGLE newlines, so splitting
     on blank lines produced one twenty-line block on a page whose entire job is
     being read by someone in a hurry. */
  at("#summary").replaceChildren(...String(profile.summary || "")
    .split(String.fromCharCode(10)).map((t) => t.trim()).filter(Boolean)
    .map((t) => el("p", {}, [t])));

  const links = [];
  if (profile.links.linkedin) links.push(el("a", { class: "biglink", href: profile.links.linkedin, target: "_blank", rel: "noopener noreferrer" }, ["LinkedIn"]));
  if (profile.links.github) links.push(el("a", { class: "biglink", href: profile.links.github, target: "_blank", rel: "noopener noreferrer" }, ["GitHub"]));
  at("#links").replaceChildren(...links);

  for (const [id, text] of [["skills", profile.skills], ["education", profile.education], ["certifications", profile.certifications]]) {
    const section = at(`#${id}`);
    if (!text) { section.closest("section").hidden = true; continue; }
    section.replaceChildren(lines(text));
  }

  /* Already in the payload: the API fetched it server-side, because the page's
     CSP forbids the browser from reaching api.github.com. */
  const list = repoList(profile.repos || []);
  if (list) at("#repos").replaceChildren(list);
  else at("#repos").closest("section").hidden = true;
}

start();
