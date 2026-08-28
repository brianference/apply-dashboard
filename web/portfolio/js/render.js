/**
 * Turning the data into the page. No fetching here, no fetching in main.
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
 * Resume sections arrive as lines with " | " separators. Rendering them as a
 * wall of text loses the structure the resume itself has.
 *
 * @param {string} text
 * @returns {HTMLElement}
 */
export function lines(text) {
  const rows = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  return el("div", { class: "lines" }, rows.map((row) => {
    /* Two shapes appear in this resume and both were being flattened into an
       undifferentiated block: "Category: a, b, c" in SKILLS, and "A | B | C"
       in EDUCATION and CERTIFICATIONS. The label is what the eye needs first,
       so it is emphasised and the rest trails it.
       The colon has to be an EARLY one - the skills lines contain later colons
       inside their own contents, and splitting on those would promote a
       fragment of a list to a heading. */
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
 * @param {import("./projects.js").Project} project
 * @returns {HTMLElement}
 */
export function projectCard(project) {
  return el("article", { class: "project" }, [
    el("a", { class: "shot", href: project.url, target: "_blank", rel: "noopener noreferrer" }, [
      /* Real screenshots of the running sites, captured rather than mocked.
         loading=lazy because there are five full-width images below the fold. */
      el("img", { src: project.shot, alt: `${project.name} home page`, loading: "lazy", width: "1280", height: "800" })
    ]),
    el("div", { class: "project-body" }, [
      el("h3", {}, [project.name]),
      el("p", {}, [project.blurb]),
      el("p", { class: "project-links" }, [
        el("a", { href: project.url, target: "_blank", rel: "noopener noreferrer" }, ["Visit"]),
        project.repo ? el("a", { href: project.repo, target: "_blank", rel: "noopener noreferrer" }, ["Source"]) : null
      ])
    ])
  ]);
}

/**
 * @param {Array<{name: string, description: string, html_url: string, language: string|null, pushed_at: string}>} repos
 * @returns {HTMLElement|null}
 */
export function repoList(repos) {
  if (!repos.length) return null;
  return el("ul", { class: "repos" }, repos.slice(0, 12).map((r) => el("li", {}, [
    el("a", { href: r.html_url, target: "_blank", rel: "noopener noreferrer" }, [r.name]),
    r.language ? el("span", { class: "lang" }, [r.language]) : null,
    el("span", { class: "repo-desc" }, [r.description])
  ])));
}
