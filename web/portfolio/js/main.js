/**
 * Entry point for the split-hero portfolio. Fetches, then renders.
 */

import { el, lines, projectRow, repoList } from "./render.js";
import { fetchProfile, currentHandle } from "./api.js";
import { PROJECTS } from "./projects.js";
import { mountSiteNav } from "/shared/site-nav.js";

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
 * @param {string} url
 * @param {string} label
 * @param {string} cls
 * @returns {HTMLElement}
 */
const link = (url, label, cls) =>
  el("a", { class: cls, href: url, target: "_blank", rel: "noopener noreferrer" }, [label]);


/**
 * Draw the owner's project set: the first in the hero, the rest as rows.
 *
 * @returns {void}
 */
function showProjects() {
  const [featured, ...rest] = PROJECTS;
  at("#hero-shot").setAttribute("href", featured.url);
  at("#hero-shot").hidden = false;
  at("#hero-img").setAttribute("src", featured.shot);
  at("#hero-img").setAttribute("alt", `Screenshot of ${featured.name}`);
  at("#featured-name").textContent = featured.name;
  at("#featured-blurb").textContent = featured.blurb;
  const featuredLinks = [link(featured.url, "Visit", "visit")];
  if (featured.repo) featuredLinks.push(link(featured.repo, "Source", "source"));
  at("#featured-links").replaceChildren(...featuredLinks);
  at("#rows").replaceChildren(...rest.map(projectRow));
}

/**
 * An account with no projects of its own says so, rather than borrowing.
 *
 * @param {string|null} handle whose portfolio was asked for
 * @returns {void}
 */
function showNoProjects(handle) {
  at("#hero-shot").hidden = true;
  /* The kicker is a static label in the markup, so clearing the heading under
     it leaves the word "Featured" floating above nothing. */
  at("#featured-kicker").hidden = true;
  at("#featured-name").textContent = "";
  at("#featured-blurb").textContent = "";
  at("#featured-links").replaceChildren();
  /* Wrapped in .band-inner, which is what supplies the page column. A .band has
     no max-width of its own because each .row brings one, so a bare paragraph
     dropped straight into it starts at pixel zero. The markup carries a comment
     saying exactly this and I did it anyway; the screenshot is what caught it. */
  const note = el("div", { class: "band-inner" }, [
    el("p", { class: "empty-note" }, [
      handle
        ? "No projects have been added to this portfolio yet."
        : "This portfolio has nothing to show yet."
    ])
  ]);
  at("#rows").replaceChildren(note);
}

/**
 * @returns {Promise<void>}
 */
async function start() {
  /* Shared with the rest of the product, but this page never REQUIRES a
     session - it is the one thing here meant to be handed out. */
  mountSiteNav("#sitenav").catch(() => { /* signed out is the normal case here */ });

  /* PROJECTS is the OWNER's work, with screenshots of his own running sites,
     and it is shipped to every visitor as part of this page. It must therefore
     only be rendered on the owner's portfolio: it was drawn unconditionally,
     so a new account's page put its own name above somebody else's projects.
     The API says which profile those belong to.

     Rendering before the profile arrives is deliberate on the owner's own page
     - evidence in the first screen rather than after a round trip - but that is
     only safe when no handle was asked for, because then the API can only
     answer with the owner. With a handle, wait and be told. */
  const askedFor = currentHandle();
  if (!askedFor) showProjects();

  let profile;
  try {
    profile = await fetchProfile();
  } catch {
    at("#bio").textContent = "";
    showNoProjects(askedFor);
    return;
  }

  if (askedFor) {
    if (profile.owner) showProjects();
    else showNoProjects(askedFor);
  }

  if (profile.name) {
    at("#who").textContent = profile.name;
    document.title = `${profile.name} — ${profile.headline || "Portfolio"}`;
  }
  at("#headline").textContent = profile.headline || "";
  at("#where").textContent = profile.location || "";

  /* Only the FIRST paragraph of the summary goes in the hero. The rest of the
     resume prose is what made the old page a wall of text before any work
     appeared, and a portfolio is read for the work. */
  const paragraphs = String(profile.summary || "")
    .split(String.fromCharCode(10)).map((t) => t.trim()).filter(Boolean);
  at("#bio").textContent = paragraphs[0] || "";

  const links = [];
  if (profile.links.linkedin) links.push(link(profile.links.linkedin, "LinkedIn", "pill"));
  if (profile.links.github) links.push(link(profile.links.github, "GitHub", "pill"));
  at("#links").replaceChildren(...links);

  for (const [id, text] of [["skills", profile.skills], ["education", profile.education], ["certifications", profile.certifications]]) {
    const node = at(`#${id}`);
    /* Hide the whole block, heading included. Hiding only the body left an
       orphaned title with nothing under it. */
    if (!text) { (node.closest(".fact") || node).hidden = true; continue; }
    node.replaceChildren(lines(text));
  }

  const list = repoList(profile.repos || []);
  if (list) at("#repos").replaceChildren(list);
  else at("#repos").closest("section").hidden = true;
}

start();
