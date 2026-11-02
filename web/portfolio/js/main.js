/**
 * Entry point for the split-hero portfolio. Fetches, then renders.
 */

import { el, lines, projectRow, galleryList, repoList, putJsonLd, factText, experienceList, projectList, closingBand } from "./render.js";
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
  const heroShot = at("#hero-shot");
  heroShot.hidden = false;
  if (featured.embed) {
    /* The walkthrough plays in place of the screenshot. The no-referrer policy
       on this site makes YouTube refuse some embeds, so this one frame asks for
       the origin to be sent. */
    heroShot.replaceChildren(el("iframe", {
      class: "hero-video",
      src: featured.embed,
      title: `${featured.name} build walkthrough`,
      loading: "lazy",
      allow: "accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen",
      allowfullscreen: "",
      referrerpolicy: "strict-origin-when-cross-origin"
    }), el("p", { class: "hero-video-title" }, [featured.embedTitle || featured.name]));
    heroShot.removeAttribute("href");
  } else {
    heroShot.setAttribute("href", featured.url);
    at("#hero-img").setAttribute("src", featured.shot);
    at("#hero-img").setAttribute("alt", `Screenshot of ${featured.name}`);
  }
  at("#featured-name").textContent = featured.name;
  at("#featured-blurb").textContent = featured.blurb;
  const featuredLinks = [link(featured.url, "Visit", "visit")];
  if (featured.repo) featuredLinks.push(link(featured.repo, "Source", "source"));
  if (featured.video) featuredLinks.push(link(featured.video, "Watch on YouTube", "source"));
  at("#featured-links").replaceChildren(...featuredLinks);
  const strip = galleryList(featured);
  const heroGallery = document.querySelector("#hero-gallery");
  if (heroGallery) heroGallery.remove();
  if (strip) {
    strip.id = "hero-gallery";
    strip.classList.add("hero-gallery");
    at(".hero").after(strip);
  }
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
  const bio = at("#bio");
  bio.textContent = paragraphs[0] || "";
  /* One long paragraph pushed the featured project a full screen down, so it
     is clamped to a few lines and opened on request. */
  bio.classList.add("clamped");
  const more = el("button", { class: "bio-more", type: "button", "aria-expanded": "false" }, ["Read more"]);
  more.addEventListener("click", () => {
    const open = bio.classList.toggle("clamped") === false;
    more.textContent = open ? "Show less" : "Read more";
    more.setAttribute("aria-expanded", String(open));
  });
  bio.after(more);

  const links = [];
  if (profile.links.linkedin) links.push(link(profile.links.linkedin, "LinkedIn", "pill"));
  if (profile.links.github) links.push(link(profile.links.github, "GitHub", "pill"));
  at("#links").replaceChildren(...links);

  putJsonLd(profile.jsonld || null);

  const bands = [];
  const experience = experienceList(profile.experience || []);
  const expBand = closingBand("Experience", "Experience", experience);
  if (expBand) bands.push(expBand);

  const resumeProjects = projectList(profile.projects || []);
  const projBand = closingBand("Selected projects", "Selected projects", resumeProjects);
  if (projBand) bands.push(projBand);

  const facts = [];
  for (const [title, value] of [
    ["Skills", profile.skills],
    ["Education", profile.education],
    ["Certifications", profile.certifications]
  ]) {
    const text = factText(value);
    if (!text) continue;
    facts.push(el("div", { class: "fact" }, [
      el("h2", { class: "section-title" }, [title]),
      el("div", {}, [lines(text)])
    ]));
  }
  if (facts.length) {
    bands.push(el("section", { class: "band closing", "aria-label": "Background" }, [
      el("div", { class: "band-inner" }, [
        el("div", { class: "facts" }, facts)
      ])
    ]));
  }
  at("#resume-sections").replaceChildren(...bands);

  const list = repoList(profile.repos || []);
  if (list) at("#repos").replaceChildren(list);
  else at("#repos").closest("section").hidden = true;
}

start();
