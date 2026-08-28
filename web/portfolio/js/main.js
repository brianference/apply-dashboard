/**
 * Entry point for the split-hero portfolio. Fetches, then renders.
 */

import { el, lines, projectRow, repoList } from "./render.js";
import { fetchProfile } from "./api.js";
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
 * @returns {Promise<void>}
 */
async function start() {
  /* Shared with the rest of the product, but this page never REQUIRES a
     session - it is the one thing here meant to be handed out. */
  mountSiteNav("#sitenav").catch(() => { /* signed out is the normal case here */ });

  /* The first project is the featured one in the hero; the rest become rows.
     Rendering these before the profile arrives means the evidence is on screen
     even if the API is slow, which is the whole point of the layout. */
  const [featured, ...rest] = PROJECTS;
  at("#hero-shot").setAttribute("href", featured.url);
  at("#hero-img").setAttribute("src", featured.shot);
  at("#hero-img").setAttribute("alt", `Screenshot of ${featured.name}`);
  at("#featured-name").textContent = featured.name;
  at("#featured-blurb").textContent = featured.blurb;
  const featuredLinks = [link(featured.url, "Visit", "visit")];
  if (featured.repo) featuredLinks.push(link(featured.repo, "Source", "source"));
  at("#featured-links").replaceChildren(...featuredLinks);
  at("#rows").replaceChildren(...rest.map(projectRow));

  let profile;
  try {
    profile = await fetchProfile();
  } catch {
    at("#bio").textContent = "";
    return;
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
    if (!text) { node.previousElementSibling.hidden = true; node.hidden = true; continue; }
    node.replaceChildren(lines(text));
  }

  const list = repoList(profile.repos || []);
  if (list) at("#repos").replaceChildren(list);
  else at("#repos").closest("section").hidden = true;
}

start();
