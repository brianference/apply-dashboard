/**
 * Turning the data into the split-hero page. No fetching here.
 */

/**
 * @param {string} tag
 * @param {object} [attrs]
 * @param {Array<Node|string>} [children]
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = String(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/**
 * Resume sections, one line per row, with their own structure preserved.
 *
 * Two shapes appear in this resume and both were being flattened into an
 * undifferentiated block: "Category: a, b, c" in SKILLS, and "A | B | C" in
 * EDUCATION and CERTIFICATIONS. The label is what the eye needs first.
 *
 * The colon has to be an EARLY one - the skills lines contain later colons
 * inside their own contents, and splitting on those would promote a fragment
 * of a list to a heading.
 *
 * @param {string} text
 * @returns {HTMLElement}
 */
export function lines(text) {
  const rows = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  return el("div", { class: "lines" }, rows.map((row) => {
    const colon = row.indexOf(": ");
    if (colon > 0 && colon < 46) {
      return el("p", {}, [el("strong", {}, [row.slice(0, colon)]), " " + row.slice(colon + 2)]);
    }
    const parts = row.split(" | ").map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) return el("p", {}, [row]);
    return el("p", {}, [el("strong", {}, [parts[0]]), " " + parts.slice(1).join(" · ")]);
  }));
}

/**
 * One project row: screenshot on one side, words on the other.
 *
 * The CSS alternates which side each lands on down the page; nothing here has
 * to know its own index for that to work.
 *
 * @param {import("./projects.js").Project} project
 * @returns {HTMLElement}
 */
export function projectRow(project) {
  const actions = [el("a", { class: "visit", href: project.url, target: "_blank", rel: "noopener noreferrer" }, ["Visit"])];
  if (project.repo) {
    actions.push(el("a", { class: "source", href: project.repo, target: "_blank", rel: "noopener noreferrer" }, ["Source"]));
  }
  return el("article", { class: "row", id: "p-" + project.slug }, [
    el("a", { class: "shot", href: project.url, target: "_blank", rel: "noopener noreferrer" }, [
      /* loading=lazy because ten full-width screenshots sit below the fold.
         They load on scroll; a viewport-sized capture will show some of them
         as not-yet-loaded, which is the lazy attribute working rather than a
         broken image. */
      el("img", { src: project.shot, alt: `Screenshot of ${project.name}`, width: "1280", height: "800", loading: "lazy" })
    ]),
    el("div", { class: "copy" }, [
      el("h3", {}, [project.name]),
      el("p", {}, [project.blurb]),
      el("div", { class: "actions" }, actions)
    ])
  ]);
}

/**
 * @param {Array<{name: string, description: string, html_url: string, language: string|null}>} repos
 * @returns {HTMLElement|null}
 */
/**
 * Insert Person JSON-LD. One script tag, type application/ld+json, the way
 * ingest/jd-read.mjs reads JobPosting: a single object, @type as a string.
 * Replaces any previous block so a second render cannot leave two Persons.
 *
 * @param {object|null} data
 * @returns {void}
 */
export function putJsonLd(data) {
  for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
    node.remove();
  }
  if (!data || typeof data !== "object") return;
  const script = document.createElement("script");
  script.type = "application/ld+json";
  script.textContent = JSON.stringify(data);
  document.head.append(script);
}

/**
 * Skills/education/certs as the line-oriented text `lines()` already knows,
 * whether the API sent the old string or the new structured array.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function factText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((item) => {
    if (!item || typeof item !== "object") return String(item);
    if (item.line) return item.line;
    if (item.label) return item.label + ": " + (item.text || "");
    return item.text || "";
  }).filter(Boolean).join("\n");
}

/**
 * Work history. Paragraphs, never a bullet list -- this resume has none, and
 * a renderer that only drew `li` would show empty roles.
 *
 * @param {Array<object>} roles
 * @returns {HTMLElement|null}
 */
export function experienceList(roles) {
  if (!roles || !roles.length) return null;
  return el("div", { class: "roles", id: "experience" }, roles.map((role) => {
    const when = role.current
      ? [role.start, "present"].filter(Boolean).join(" to ")
      : [role.start, role.end].filter(Boolean).join(" to ");
    const meta = [role.company, role.location, when].filter(Boolean).join(" · ");
    const paras = (role.paragraphs && role.paragraphs.length)
      ? role.paragraphs
      : (role.raw || []);
    return el("article", { class: "role" }, [
      role.title ? el("h3", {}, [role.title]) : null,
      meta ? el("p", { class: "role-meta" }, [meta]) : null,
      ...paras.map((p) => el("p", {}, [p]))
    ]);
  }));
}

/**
 * Resume-selected projects, as prose. The screenshot rows are a separate
 * owner-only list and are not these.
 *
 * @param {Array<object>} projects
 * @returns {HTMLElement|null}
 */
export function projectList(projects) {
  if (!projects || !projects.length) return null;
  return el("div", { class: "resume-projects", id: "resume-projects" }, projects.map((project) => {
    const paras = project.paragraphs || [];
    return el("article", { class: "role" }, [
      project.name ? el("h3", {}, [project.name]) : null,
      ...paras.map((p) => el("p", {}, [p])),
      project.url ? el("p", {}, [
        el("a", { href: project.url, target: "_blank", rel: "noopener noreferrer" }, [project.url])
      ]) : null
    ]);
  }));
}

/**
 * A closing band that is absent from the document when it has nothing to
 * show. Building it here, rather than hiding a static heading, is what
 * keeps a hidden section out of the public HTML.
 *
 * @param {string} title
 * @param {string} label
 * @param {HTMLElement|null} body
 * @returns {HTMLElement|null}
 */
export function closingBand(title, label, body) {
  if (!body) return null;
  return el("section", { class: "band closing", "aria-label": label }, [
    el("div", { class: "band-inner" }, [
      el("h2", { class: "section-title" }, [title]),
      body
    ])
  ]);
}

export function repoList(repos) {
  if (!repos || !repos.length) return null;
  return el("ul", { class: "repos" }, repos.slice(0, 12).map((r) => el("li", {}, [
    el("a", { href: r.html_url, target: "_blank", rel: "noopener noreferrer" }, [r.name]),
    r.language ? el("span", { class: "lang" }, [r.language]) : null,
    el("span", { class: "repo-desc" }, [r.description])
  ])));
}
