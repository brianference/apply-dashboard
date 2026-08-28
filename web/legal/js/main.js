/**
 * One renderer for About, Terms, Privacy and Contact.
 *
 * Four near-identical pages are four places for the same fix to be forgotten.
 * Each page is a shell that names which document it is; everything else is
 * here, and the words are in content.js.
 */

import { mountSiteNav } from "/shared/site-nav.js";
import { ABOUT, TERMS, PRIVACY, CONTACT, LAST_UPDATED } from "./content.js";

const DOCS = { about: ABOUT, terms: TERMS, privacy: PRIVACY, contact: CONTACT };

/**
 * @param {string} tag
 * @param {object} [attrs]
 * @param {Array<Node|string>} [children]
 * @returns {HTMLElement}
 */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    node.setAttribute(k === "class" ? "class" : k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/**
 * Turn bare domains and paths in the copy into real links.
 *
 * Written as text in content.js so the words read as sentences rather than as
 * markup, and linked here. Only the exact hosts the copy mentions are matched;
 * this is not a general URL parser and must not become one.
 *
 * @param {string} text
 * @returns {Array<Node|string>}
 */
function linkify(text) {
  const KNOWN = [
    ["linkedin.com/in/brianference", "https://www.linkedin.com/in/brianference/"],
    ["fonts.googleapis.com", "https://fonts.googleapis.com"],
    ["fonts.gstatic.com", "https://fonts.gstatic.com"],
    ["the contact page", "/legal/contact/"],
    ["the profile page", "/profile/"]
  ];
  let parts = [String(text)];
  for (const [needle, href] of KNOWN) {
    const next = [];
    for (const part of parts) {
      if (typeof part !== "string" || !part.includes(needle)) { next.push(part); continue; }
      const [before, ...rest] = part.split(needle);
      next.push(before, el("a", { href, ...(href.startsWith("http") ? { target: "_blank", rel: "noopener noreferrer" } : {}) }, [needle]));
      next.push(rest.join(needle));
    }
    parts = next;
  }
  return parts.filter((p) => p !== "");
}

/**
 * @param {{heading: string, body?: string[], list?: string[]}} section
 * @returns {HTMLElement}
 */
function renderSection(section) {
  const children = [el("h2", {}, [section.heading])];
  for (const p of section.body || []) children.push(el("p", {}, linkify(p)));
  if (section.list) {
    children.push(el("ul", {}, section.list.map((item) => el("li", {}, linkify(item)))));
  }
  return el("section", { class: "doc-section" }, children);
}

const which = document.body.getAttribute("data-doc");
const doc = DOCS[which];

mountSiteNav("#sitenav").catch(() => { /* these pages never require a session */ });

if (!doc) {
  document.querySelector("#doc").append(el("p", {}, ["This page is not available."]));
} else {
  document.title = `${doc.title} — AI PM Jobs`;
  const root = document.querySelector("#doc");
  root.append(
    el("h1", {}, [doc.title]),
    el("p", { class: "updated" }, ["Last updated ", LAST_UPDATED]),
    ...doc.intro.map((p) => el("p", { class: "lede" }, linkify(p))),
    ...doc.sections.map(renderSection)
  );
}
