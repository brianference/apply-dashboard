/**
 * The sign in / sign out control, shared by every page.
 *
 * One module rather than a copy per page. The dashboard, the experiments tool
 * and the portfolio all need to know the same thing - is anyone signed in - and
 * three answers to that question would eventually disagree.
 *
 * It exports the answer as well as rendering the control, because pages do more
 * with it than draw a link: the dashboard uses it to decide whether ticking a
 * job can actually be recorded.
 */

/** @typedef {{authenticated: boolean, email?: string, since?: string}} Who */

/**
 * Ask the API who is signed in. Never throws: a page that cannot reach the
 * network should still render its read-only content.
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
 * Sign out, then reload so every gated control on the page re-evaluates rather
 * than being individually reset by hand.
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
 * Render the control into a container.
 *
 * Signed out it is a link to /login/, and it says what signing in is FOR. On a
 * dashboard whose whole point is recording what you applied to, "Sign in" with
 * no reason attached reads like an obstacle rather than the way to use it.
 *
 * @param {HTMLElement} container
 * @param {Who} who
 * @returns {void}
 */
export function renderAuthNav(container, who) {
  container.replaceChildren();
  container.classList.add("authnav");

  if (!who.authenticated) {
    const link = document.createElement("a");
    link.className = "authnav-signin";
    link.href = "/login/";
    link.textContent = "Sign in";
    link.title = "Sign in to record applications and outcomes";
    container.append(link);
    return;
  }

  const who_ = document.createElement("span");
  who_.className = "authnav-who";
  who_.textContent = who.email || "signed in";

  const out = document.createElement("button");
  out.type = "button";
  out.className = "authnav-signout";
  out.textContent = "Sign out";
  out.addEventListener("click", signOut);

  container.append(who_, out);
}

/**
 * The stylesheet for the control, injected once so a page only has to provide
 * a container. Uses the tokens every page already defines.
 *
 * @returns {void}
 */
export function injectAuthNavStyles() {
  if (document.getElementById("authnav-styles")) return;
  const style = document.createElement("style");
  style.id = "authnav-styles";
  style.textContent = `
    .authnav { display: flex; align-items: center; gap: 10px; }
    .authnav-who {
      font: 500 12px/1 "IBM Plex Mono", ui-monospace, monospace;
      color: var(--muted); max-width: 20ch; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap;
    }
    .authnav-signin, .authnav-signout {
      font: 600 13px/1 "IBM Plex Sans", system-ui, sans-serif;
      border-radius: 999px; padding: 8px 15px; cursor: pointer; white-space: nowrap;
      border: 1px solid var(--border); background: var(--surface); color: var(--text);
      text-decoration: none; display: inline-flex; align-items: center; min-height: 34px;
    }
    .authnav-signin { background: var(--primary); border-color: var(--primary); color: var(--primary-contrast); }
    .authnav-signin:hover, .authnav-signout:hover { filter: brightness(1.06); }
    .authnav-signin:focus-visible, .authnav-signout:focus-visible {
      outline: 2px solid var(--primary); outline-offset: 3px;
    }
    @media (max-width: 560px) { .authnav-who { display: none; } }
  `;
  document.head.append(style);
}

/**
 * The whole thing: styles, the current user, and the rendered control.
 *
 * @param {string} selector container to render into
 * @returns {Promise<Who>} so the caller can gate its own controls on the same answer
 */
export async function mountAuthNav(selector) {
  injectAuthNavStyles();
  const who = await whoAmI();
  const container = document.querySelector(selector);
  if (container) renderAuthNav(container, who);
  return who;
}
