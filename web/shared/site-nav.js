/**
 * The site header, shared by every page.
 *
 * Concept 2 of the three Brian was shown: brand and account on the top row,
 * sections owning a full-width tab row beneath.
 *
 * One module rather than a copy per page. Four pages need to answer the same
 * question - who is signed in - and four answers to that would eventually
 * disagree. It renders the header AND returns the answer, because pages do more
 * with it than draw a bar: the job list uses it to decide whether ticking a job
 * can actually be recorded.
 */

/** @typedef {{authenticated: boolean, email?: string, since?: string}} Who */

/** Every destination, in the order they appear. */
export const SECTIONS = [
  { href: "/", label: "Jobs" },
  { href: "/experiments/", label: "Experiments", needsAuth: true },
  { href: "/portfolio/", label: "Portfolio" },
  { href: "/profile/", label: "Profile", needsAuth: true }
];

/**
 * Ask the API who is signed in. Never throws: a page that cannot reach the
 * network must still render its read-only content.
 *
 * @returns {Promise<Who>}
 */
export async function whoAmI() {
  try {
    const res = await fetch("/api/auth/me", {
      credentials: "same-origin",
      headers: { "cache-control": "no-cache" }
    });
    if (!res.ok) return { authenticated: false };
    return await res.json();
  } catch {
    return { authenticated: false };
  }
}

/**
 * Sign out, then reload, so every gated control on the page re-evaluates at
 * once rather than each being switched back by hand.
 *
 * @returns {Promise<void>}
 */
export async function signOut() {
  try {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
  } finally {
    location.reload();
  }
}

/**
 * Which section is the current page.
 *
 * Longest matching prefix, so /experiments/ wins over / rather than both
 * matching and the first one being marked current.
 *
 * @param {string} pathname
 * @returns {string} the href of the current section
 */
export function currentSection(pathname) {
  const path = String(pathname || "/");
  let best = "/";
  for (const s of SECTIONS) {
    if (s.href !== "/" && path.startsWith(s.href) && s.href.length > best.length) best = s.href;
  }
  return best;
}

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
    if (k === "class") node.className = String(v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/**
 * The theme control. Light is the default whatever the operating system
 * prefers, so an unset attribute means light - inferring it from
 * prefers-color-scheme made the first click a no-op on a dark-mode machine.
 *
 * @returns {HTMLElement}
 */
function themeButton() {
  const button = el("button", { type: "button", class: "theme", "aria-label": "Switch theme" });
  button.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">'
    + '<circle cx="8" cy="8" r="6.25" stroke="currentColor" stroke-width="1.5"/>'
    + '<path d="M8 1.75a6.25 6.25 0 0 1 0 12.5z" fill="currentColor"/></svg>';
  button.addEventListener("click", () => {
    const root = document.documentElement;
    const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("apply-theme", next); } catch { /* private mode */ }
  });
  return button;
}

/**
 * The sign-in button and the panel it opens.
 *
 * Signing in happens HERE rather than on a page of its own: leaving the list,
 * signing in, and being dropped back at the top of it is a worse trip than
 * typing two fields in place. /login/ still exists, because a reset link has to
 * land somewhere.
 *
 * @returns {DocumentFragment}
 */
function signInControl() {
  const frag = document.createDocumentFragment();
  const button = el("button", {
    type: "button", class: "signin", "aria-expanded": "false",
    title: "Sign in to record applications and outcomes"
  }, ["Sign in"]);

  const panel = el("div", { class: "panel" });
  panel.hidden = true;
  panel.innerHTML = `
    <p class="why">Sign in to record applications and outcomes.</p>
    <div class="err" hidden role="status"></div>
    <label for="nav-email">Email</label>
    <input id="nav-email" type="email" autocomplete="username"/>
    <label for="nav-password">Password</label>
    <div class="pw">
      <input id="nav-password" type="password" autocomplete="current-password"/>
      <button type="button" class="pw-toggle" aria-pressed="false" aria-label="Show password">Show</button>
    </div>
    <button type="button" class="submit">Sign in</button>
    <a class="forgot" href="/login/?reset=1">Forgot your password</a>
  `;

  const email = panel.querySelector("#nav-email");
  const password = panel.querySelector("#nav-password");
  const toggle = panel.querySelector(".pw-toggle");
  const submit = panel.querySelector(".submit");
  const err = panel.querySelector(".err");

  toggle.addEventListener("click", () => {
    const showing = password.getAttribute("type") === "text";
    password.setAttribute("type", showing ? "password" : "text");
    toggle.setAttribute("aria-pressed", String(!showing));
    toggle.setAttribute("aria-label", showing ? "Show password" : "Hide password");
    toggle.textContent = showing ? "Show" : "Hide";
    password.focus();
  });

  const open = (yes) => {
    panel.hidden = !yes;
    button.setAttribute("aria-expanded", String(yes));
    if (yes) email.focus();
  };
  button.addEventListener("click", (e) => { e.stopPropagation(); open(panel.hidden); });
  /* A click inside must not close it, or the panel shuts the moment you reach
     for the password field. */
  panel.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => open(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") open(false); });

  const attempt = async () => {
    err.hidden = true;
    submit.disabled = true;
    submit.textContent = "Signing in…";
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email: email.value.trim(), password: password.value })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Sign in failed (${res.status})`);
      location.reload();
    } catch (e) {
      err.hidden = false;
      err.textContent = String(e.message || e);
      submit.disabled = false;
      submit.textContent = "Sign in";
    }
  };
  submit.addEventListener("click", attempt);
  for (const field of [email, password]) {
    field.addEventListener("keydown", (e) => { if (e.key === "Enter") attempt(); });
  }

  frag.append(button, panel);
  return frag;
}

/**
 * Initials for an account.
 *
 * The NAME is the right source and the email is only a fallback. Deriving them
 * from "brianference@protonmail.com" gives BR, because that local part is one
 * run of letters with nothing marking where the surname starts; deriving them
 * from "Brian Ference" gives BF, which is what a person expects in their own
 * avatar. The name is a column on the profile row, not a literal in the code.
 *
 * @param {string} email
 * @param {string} [name]
 * @returns {string} one or two uppercase letters
 */
export function initialsFor(email, name) {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  const local = String(email || "").split("@")[0].replace(/[^A-Za-z0-9._-]/g, "");
  if (!local) return "?";
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return local.slice(0, 2).toUpperCase();
}

/**
 * The signed-in account control: an identity chip, and a menu behind it.
 *
 * Concept 2 of three. The trigger shows INITIALS, not the address: the header
 * used to print the whole email as a button, which wrapped badly on a phone,
 * put the address on screen for anyone nearby, and gave no affordance that a
 * menu was behind it. The address appears inside the open panel, under a
 * who-you-are header, where showing it is deliberate.
 *
 * @param {Who} who
 * @returns {DocumentFragment}
 */
function accountControl(who) {
  const frag = document.createDocumentFragment();
  const email = who.email || "";
  const initials = initialsFor(email, who.name);

  const button = el("button", {
    type: "button", class: "chip-btn", "aria-expanded": "false",
    "aria-label": `Account menu for ${email || "this account"}`
  }, [el("span", { class: "avatar", "aria-hidden": "true" }, [initials])]);
  const caret = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  caret.setAttribute("class", "caret");
  caret.setAttribute("width", "12");
  caret.setAttribute("height", "12");
  caret.setAttribute("viewBox", "0 0 12 12");
  caret.setAttribute("aria-hidden", "true");
  const caretPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  caretPath.setAttribute("d", "M2.5 4.5 6 8l3.5-3.5");
  caretPath.setAttribute("stroke", "currentColor");
  caretPath.setAttribute("stroke-width", "1.6");
  caretPath.setAttribute("fill", "none");
  caretPath.setAttribute("stroke-linecap", "round");
  caret.append(caretPath);
  button.append(caret);

  const menu = el("div", { class: "menu" });
  menu.hidden = true;
  menu.append(el("div", { class: "menu-head" }, [
    el("span", { class: "avatar-lg", "aria-hidden": "true" }, [initials]),
    el("span", { class: "who-copy" }, [
      el("strong", {}, [who.name || email]),
      /* A text node, never innerHTML: this value comes from the database. */
      el("span", { class: "email" }, [email]),
      el("span", { class: "signed" }, ["Signed in"])
    ])
  ]));
  for (const s of SECTIONS) {
    if (s.href === "/") continue;
    menu.append(el("a", { href: s.href }, [s.label]));
  }
  menu.append(el("div", { class: "menu-sep" }));
  menu.append(el("button", { type: "button", class: "signout", onclick: signOut }, ["Sign out"]));

  const open = (yes) => { menu.hidden = !yes; button.setAttribute("aria-expanded", String(yes)); };
  button.addEventListener("click", (e) => { e.stopPropagation(); open(menu.hidden); });
  menu.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => open(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") open(false); });

  frag.append(button, menu);
  return frag;
}

/**
 * Build the whole header.
 *
 * @param {Who} who
 * @returns {HTMLElement}
 */
export function buildHeader(who) {
  const current = currentSection(location.pathname);
  return el("header", { class: "site" }, [
    el("div", { class: "top" }, [
      el("a", { class: "brand", href: "/", "aria-label": "AI PM Jobs — home" }, [
        el("img", { src: "/mark-01.png", alt: "", width: "80", height: "80" }),
        el("span", { class: "name" }, [
          el("strong", {}, ["AI PM Jobs"]),
          el("em", {}, ["Ranked product-management roles"])
        ])
      ]),
      el("div", { class: "spacer" }),
      el("div", { class: "tools" }, [themeButton(), who.authenticated ? accountControl(who) : signInControl()])
    ]),
    el("nav", { class: "tabs", "aria-label": "Sections" }, SECTIONS.map((s) => el("a", {
      href: s.href,
      /* aria-current is what actually announces the current page; the class is
         only how it is painted. */
      "aria-current": s.href === current ? "page" : null
    }, [s.label])))
  ]);
}

/**
 * Replace a placeholder element with the real header.
 *
 * @param {string} selector element to replace
 * @returns {Promise<Who>} so the caller can gate its own controls on the same answer
 */
export async function mountSiteNav(selector) {
  /* Apply the saved theme before the header paints, so the toggle and the page
     never disagree about which one is showing. */
  try {
    const saved = localStorage.getItem("apply-theme");
    if (saved === "light" || saved === "dark") document.documentElement.setAttribute("data-theme", saved);
  } catch { /* private mode */ }

  const who = await whoAmI();
  const slot = document.querySelector(selector);
  if (slot) slot.replaceWith(buildHeader(who));
  return who;
}
