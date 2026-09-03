/**
 * Section cards for the private profile editor.
 *
 * The parse is a suggestion: cards start from what is SAVED, and Import from
 * resume offers one item at a time. Filling the cards from the parse on load
 * is how a person's edited title would vanish the next time they opened this
 * page.
 */

import {
  normalizeSections, emptySections, moveItem, acceptItem, itemFingerprint
} from "/profile/js/parse.js";

/**
 * @param {string} tag
 * @param {object} [attrs]
 * @param {Array<Node|string>} [children]
 * @returns {HTMLElement}
 */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "on" && value && typeof value === "object") {
      for (const [ev, fn] of Object.entries(value)) node.addEventListener(ev, fn);
    } else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "checked") node.checked = !!value;
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const SECTION_META = [
  { key: "about", title: "About", hint: "The summary on the public page." },
  { key: "experience", title: "Experience", hint: "Roles, in the order they appear on LinkedIn." },
  { key: "projects", title: "Projects", hint: "Selected work beyond the jobs." },
  { key: "skills", title: "Skills", hint: "One row per category." },
  { key: "education", title: "Education", hint: "Schools and programmes." },
  { key: "certifications", title: "Certifications", hint: "Credentials worth listing." }
];

/**
 * @param {object} parsed
 * @param {string} key
 * @returns {Array<object>}
 */
function suggestedList(parsed, key) {
  if (!parsed) return [];
  if (key === "about") {
    return parsed.summary ? [{ text: parsed.summary, source: "resume" }] : [];
  }
  return Array.isArray(parsed[key]) ? parsed[key] : [];
}

/**
 * @param {HTMLElement} input
 * @param {() => void} onEdit
 * @returns {void}
 */
function markEdited(input, onEdit) {
  input.addEventListener("input", onEdit);
}

/**
 * Mount the section editor.
 *
 * @param {HTMLElement} root
 * @param {{
 *   saved: object|null,
 *   suggested: object|null,
 *   headerCheckbox: HTMLInputElement,
 *   onPersist: (sections: object) => Promise<void>
 * }} opts
 * @returns {{ getSections: () => object, isDirty: () => boolean }}
 */
export function mountSections(root, opts) {
  let sections = opts.saved ? normalizeSections(opts.saved) : emptySections();
  const suggested = opts.suggested || null;
  let dirty = false;
  /** @type {Record<string, number>} */
  const importCursor = {};
  let dragFrom = -1;
  let dragKey = "";

  /**
   * @param {boolean} [persist]
   * @returns {Promise<void>}
   */
  async function changed(persist = true) {
    dirty = true;
    draw();
    if (persist) await opts.onPersist(sections);
  }

  /**
   * @param {string} key
   * @returns {object[]}
   */
  function remainingSuggestions(key) {
    if (key === "about") {
      if (sections.about && String(sections.about.text || "").trim()) return [];
      return suggestedList(suggested, key);
    }
    const have = new Set((Array.isArray(sections[key]) ? sections[key] : []).map(itemFingerprint));
    return suggestedList(suggested, key).filter((item) => !have.has(itemFingerprint(item)));
  }

  /**
   * @param {string} key
   * @param {number} index
   * @param {string} label
   * @returns {HTMLElement}
   */
  function itemToolbar(key, index, label) {
    const list = sections[key];
    return el("div", { class: "item-toolbar" }, [
      el("button", {
        type: "button", class: "ghost icon",
        "aria-label": `Move ${label} up`,
        disabled: index === 0,
        on: { click: async () => {
          sections[key] = moveItem(list, index, index - 1);
          await changed();
        } }
      }, ["Up"]),
      el("button", {
        type: "button", class: "ghost icon",
        "aria-label": `Move ${label} down`,
        disabled: index === list.length - 1,
        on: { click: async () => {
          sections[key] = moveItem(list, index, index + 1);
          await changed();
        } }
      }, ["Down"]),
      el("button", {
        type: "button", class: "ghost icon danger",
        "aria-label": `Delete ${label}`,
        on: { click: async () => {
          sections[key] = list.filter((_, i) => i !== index);
          await changed();
        } }
      }, ["Delete"])
    ]);
  }

  /**
   * @param {string} key
   * @param {number} index
   * @param {HTMLElement} article
   * @returns {void}
   */
  function bindDrag(key, index, article) {
    article.setAttribute("draggable", "true");
    article.addEventListener("dragstart", (event) => {
      dragFrom = index;
      dragKey = key;
      event.dataTransfer.effectAllowed = "move";
    });
    article.addEventListener("dragover", (event) => {
      if (dragKey !== key) return;
      event.preventDefault();
    });
    article.addEventListener("drop", async (event) => {
      event.preventDefault();
      if (dragKey !== key || dragFrom < 0) return;
      sections[key] = moveItem(sections[key], dragFrom, index);
      dragFrom = -1;
      dragKey = "";
      await changed();
    });
  }

  /**
   * @param {object} item
   * @returns {string}
   */
  function sourceNote(item) {
    return item && item.source === "edited"
      ? "Edited by you"
      : "From your resume, until you edit it";
  }

  /**
   * @param {string} key
   * @returns {HTMLElement|null}
   */
  function importPanel(key) {
    const remaining = remainingSuggestions(key);
    if (!remaining.length) return null;
    const cursor = Math.min(importCursor[key] || 0, remaining.length - 1);
    const item = remaining[cursor];
    const label = item.title || item.name || item.label || item.line || item.text || "this item";
    return el("div", { class: "import-panel", "data-import": key }, [
      el("p", { class: "hint" }, [
        `Suggestion ${cursor + 1} of ${remaining.length} from your resume. Accept or skip one at a time -- never a bulk overwrite.`
      ]),
      el("p", { class: "import-preview" }, [String(label).slice(0, 180)]),
      el("div", { class: "photo-actions" }, [
        el("button", {
          type: "button", class: "cta",
          on: { click: async () => {
            if (key === "about") {
              sections.about = { text: item.text, source: "resume" };
            } else {
              sections = acceptItem(sections, key, item);
            }
            importCursor[key] = 0;
            await changed();
          } }
        }, ["Accept"]),
        el("button", {
          type: "button", class: "ghost",
          on: { click: () => {
            importCursor[key] = cursor + 1;
            if (importCursor[key] >= remaining.length) importCursor[key] = 0;
            draw();
          } }
        }, ["Skip"])
      ])
    ]);
  }

  /**
   * @param {string} key
   * @returns {HTMLElement}
   */
  function aboutCard() {
    const about = sections.about || { text: "", source: "resume" };
    const area = el("textarea", {
      id: "about-text", rows: "6",
      "aria-label": "About"
    }, []);
    area.value = about.text || "";
    markEdited(area, () => {
      sections.about = { text: area.value, source: "edited" };
      dirty = true;
    });
    area.addEventListener("change", () => changed(true));
    return el("div", {}, [
      el("p", { class: "source-note" }, [sourceNote(about)]),
      area
    ]);
  }

  /**
   * @param {object} item
   * @param {number} index
   * @returns {HTMLElement}
   */
  function experienceItem(item, index) {
    const article = el("article", { class: "item", "data-id": item.id || String(index) });
    const company = el("input", { type: "text", "aria-label": "Company", value: item.company || "" });
    const title = el("input", { type: "text", "aria-label": "Title", value: item.title || "" });
    const location = el("input", { type: "text", "aria-label": "Location", value: item.location || "" });
    const start = el("input", { type: "text", "aria-label": "Start date", value: item.start || "", placeholder: "Jan 2024" });
    const end = el("input", { type: "text", "aria-label": "End date", value: item.end || "", placeholder: "leave blank if current" });
    const current = el("input", { type: "checkbox", id: `exp-current-${index}` });
    current.checked = !!item.current;
    const paras = el("textarea", { rows: "5", "aria-label": "Description" });
    paras.value = (item.paragraphs || []).join("\n\n");
    const apply = () => {
      const next = { ...item, source: "edited" };
      next.company = company.value.trim() || null;
      next.title = title.value.trim() || null;
      next.location = location.value.trim() || null;
      next.start = start.value.trim() || null;
      next.current = current.checked;
      next.end = current.checked ? null : (end.value.trim() || null);
      next.paragraphs = paras.value.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
      sections.experience[index] = next;
      dirty = true;
    };
    for (const node of [company, title, location, start, end, paras]) {
      node.addEventListener("input", apply);
      node.addEventListener("change", () => changed(true));
    }
    current.addEventListener("change", () => { apply(); changed(true); });
    article.append(
      itemToolbar("experience", index, item.title || "role"),
      el("p", { class: "source-note" }, [sourceNote(item)]),
      el("label", {}, ["Company"]), company,
      el("label", {}, ["Title"]), title,
      el("label", {}, ["Location"]), location,
      el("div", { class: "date-row" }, [
        el("div", {}, [el("label", {}, ["Start"]), start]),
        el("div", {}, [el("label", {}, ["End"]), end])
      ]),
      el("label", { class: "vis-toggle", for: `exp-current-${index}` }, [
        current, " Current role (end date stays empty)"
      ]),
      el("label", {}, ["What you did"]), paras
    );
    bindDrag("experience", index, article);
    return article;
  }

  /**
   * @param {object} item
   * @param {number} index
   * @returns {HTMLElement}
   */
  function projectItem(item, index) {
    const article = el("article", { class: "item" });
    const name = el("input", { type: "text", "aria-label": "Project name", value: item.name || "" });
    const url = el("input", { type: "url", "aria-label": "Project URL", value: item.url || "" });
    const paras = el("textarea", { rows: "4", "aria-label": "Project description" });
    paras.value = (item.paragraphs || []).join("\n\n");
    const apply = () => {
      sections.projects[index] = {
        ...item,
        name: name.value.trim(),
        url: url.value.trim() || null,
        paragraphs: paras.value.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean),
        source: "edited"
      };
      dirty = true;
    };
    for (const node of [name, url, paras]) {
      node.addEventListener("input", apply);
      node.addEventListener("change", () => changed(true));
    }
    article.append(
      itemToolbar("projects", index, item.name || "project"),
      el("p", { class: "source-note" }, [sourceNote(item)]),
      el("label", {}, ["Name"]), name,
      el("label", {}, ["URL"]), url,
      el("label", {}, ["Description"]), paras
    );
    bindDrag("projects", index, article);
    return article;
  }

  /**
   * @param {object} item
   * @param {number} index
   * @param {string} key
   * @returns {HTMLElement}
   */
  function linedItem(item, index, key) {
    const article = el("article", { class: "item" });
    const line = el("input", { type: "text", "aria-label": SECTION_META.find((s) => s.key === key).title + " line", value: item.line || "" });
    line.addEventListener("input", () => {
      const text = line.value;
      sections[key][index] = {
        ...item,
        line: text,
        parts: text.includes(" | ") ? text.split(" | ").map((p) => p.trim()).filter(Boolean) : [text],
        source: "edited"
      };
      dirty = true;
    });
    line.addEventListener("change", () => changed(true));
    article.append(
      itemToolbar(key, index, item.line || key),
      el("p", { class: "source-note" }, [sourceNote(item)]),
      line
    );
    bindDrag(key, index, article);
    return article;
  }

  /**
   * @param {object} item
   * @param {number} index
   * @returns {HTMLElement}
   */
  function skillItem(item, index) {
    const article = el("article", { class: "item" });
    const label = el("input", { type: "text", "aria-label": "Skill category", value: item.label || "" });
    const text = el("input", { type: "text", "aria-label": "Skills", value: item.text || "" });
    const apply = () => {
      sections.skills[index] = {
        ...item,
        label: label.value.trim() || null,
        text: text.value,
        source: "edited"
      };
      dirty = true;
    };
    for (const node of [label, text]) {
      node.addEventListener("input", apply);
      node.addEventListener("change", () => changed(true));
    }
    article.append(
      itemToolbar("skills", index, item.label || "skill"),
      el("p", { class: "source-note" }, [sourceNote(item)]),
      el("label", {}, ["Category"]), label,
      el("label", {}, ["List"]), text
    );
    bindDrag("skills", index, article);
    return article;
  }

  /**
   * @param {string} key
   * @returns {HTMLElement}
   */
  function itemsFor(key) {
    const wrap = el("div", { class: "items" });
    if (key === "about") {
      wrap.append(aboutCard());
      return wrap;
    }
    const list = sections[key] || [];
    for (let i = 0; i < list.length; i++) {
      if (key === "experience") wrap.append(experienceItem(list[i], i));
      else if (key === "projects") wrap.append(projectItem(list[i], i));
      else if (key === "skills") wrap.append(skillItem(list[i], i));
      else wrap.append(linedItem(list[i], i, key));
    }
    return wrap;
  }

  /**
   * @param {string} key
   * @returns {object}
   */
  function blankItem(key) {
    if (key === "experience") {
      return {
        id: "experience-" + Date.now(),
        company: null, title: null, location: null,
        start: null, end: null, current: false,
        paragraphs: [], source: "edited"
      };
    }
    if (key === "projects") {
      return { id: "project-" + Date.now(), name: "", paragraphs: [], url: null, source: "edited" };
    }
    if (key === "skills") {
      return { id: "skill-" + Date.now(), label: null, text: "", source: "edited" };
    }
    return { id: key + "-" + Date.now(), line: "", parts: [], source: "edited" };
  }

  function draw() {
    const cards = SECTION_META.map((meta) => {
      const vis = el("input", {
        type: "checkbox",
        id: "vis-" + meta.key,
        checked: sections.visibility[meta.key] !== false
      });
      vis.addEventListener("change", async () => {
        sections.visibility[meta.key] = vis.checked;
        await changed();
      });
      const header = el("div", { class: "section-head" }, [
        el("h2", {}, [meta.title]),
        el("label", { class: "vis-toggle", for: "vis-" + meta.key }, [
          vis, " Show on portfolio"
        ])
      ]);
      const body = [
        header,
        el("p", { class: "hint" }, [meta.hint]),
        itemsFor(meta.key)
      ];
      if (meta.key !== "about") {
        body.push(el("button", {
          type: "button", class: "ghost",
          on: { click: async () => {
            sections[meta.key] = (sections[meta.key] || []).concat([blankItem(meta.key)]);
            await changed();
          } }
        }, ["Add"]));
      }
      const remaining = remainingSuggestions(meta.key);
      if (remaining.length) {
        let open = false;
        const panelHost = el("div");
        body.push(el("button", {
          type: "button", class: "ghost",
          "data-import-open": meta.key,
          on: { click: () => {
            open = !open;
            panelHost.replaceChildren(open ? importPanel(meta.key) : null);
          } }
        }, [`Import from resume (${remaining.length})`]));
        body.push(panelHost);
      }
      return el("section", { class: "panel section-card", "data-section": meta.key }, body);
    });
    root.replaceChildren(...cards);
    if (opts.headerCheckbox) {
      opts.headerCheckbox.checked = sections.visibility.header !== false;
    }
  }

  if (opts.headerCheckbox) {
    opts.headerCheckbox.addEventListener("change", async () => {
      sections.visibility.header = opts.headerCheckbox.checked;
      await changed();
    });
  }

  draw();
  return {
    getSections: () => sections,
    isDirty: () => dirty
  };
}
