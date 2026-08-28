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
    /* Signing in happens HERE, in a panel under the button, rather than on a
       page of its own. Leaving the list to sign in and being dropped back at
       the top of it is a worse trip than typing two fields in place. The
       separate page still exists and still works, because a reset link has to
       land somewhere, but nobody has to go there to sign in. */
    container.append(buildSignInPopover());
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
 * The sign-in button and the panel it opens.
 *
 * Same card design as /login/, shrunk into a popover: brand line, error, email,
 * password with a working show/hide, and the forgot link. On success the page
 * reloads, so every gated control re-evaluates at once rather than each being
 * switched on by hand.
 *
 * @returns {DocumentFragment}
 */
function buildSignInPopover() {
  const frag = document.createDocumentFragment();

  const button = document.createElement("button");
  button.type = "button";
  button.className = "authnav-signin";
  button.textContent = "Sign in";
  button.setAttribute("aria-expanded", "false");
  button.title = "Sign in to record applications and outcomes";

  const panel = document.createElement("div");
  panel.className = "authnav-panel";
  panel.hidden = true;
  panel.innerHTML = `
    <p class="authnav-panel-why">Sign in to record applications and outcomes.</p>
    <div class="authnav-error" hidden role="status"></div>
    <label class="authnav-label" for="authnav-email">Email</label>
    <input class="authnav-input" id="authnav-email" type="email" autocomplete="username"/>
    <label class="authnav-label" for="authnav-password">Password</label>
    <div class="authnav-pw">
      <input class="authnav-input" id="authnav-password" type="password" autocomplete="current-password"/>
      <button type="button" class="authnav-toggle" aria-pressed="false" aria-label="Show password">Show</button>
    </div>
    <button type="button" class="authnav-submit">Sign in</button>
    <a class="authnav-forgot" href="/login/?reset=1">Forgot your password</a>
  `;

  const email = panel.querySelector("#authnav-email");
  const password = panel.querySelector("#authnav-password");
  const toggle = panel.querySelector(".authnav-toggle");
  const submit = panel.querySelector(".authnav-submit");
  const error = panel.querySelector(".authnav-error");

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
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    open(panel.hidden);
  });
  /* Clicking anywhere else closes it, but a click INSIDE must not - otherwise
     the panel shuts the moment you reach for the password field. */
  panel.addEventListener("click", (event) => event.stopPropagation());
  document.addEventListener("click", () => open(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") open(false);
  });

  const attempt = async () => {
    error.hidden = true;
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
    } catch (err) {
      error.hidden = false;
      error.textContent = String(err.message || err);
      submit.disabled = false;
      submit.textContent = "Sign in";
    }
  };
  submit.addEventListener("click", attempt);
  for (const field of [email, password]) {
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter") attempt();
    });
  }

  frag.append(button, panel);
  return frag;
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

    /* The panel hangs off the button, so the container has to be a positioning
       context. Position fixed would escape any transformed ancestor. */
    .authnav { position: relative; }
    .authnav-panel[hidden] { display: none; }
    .authnav-panel {
      position: absolute; top: calc(100% + 10px); right: 0; z-index: 60;
      width: min(320px, calc(100vw - 28px));
      display: flex; flex-direction: column; gap: 8px;
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 12px; padding: 16px;
      box-shadow: 0 12px 32px rgba(0,0,0,.18);
      text-align: left;
    }
    .authnav-panel-why { margin: 0 0 2px; color: var(--muted); font-size: 13px; line-height: 1.45; }
    .authnav-label {
      font: 600 11px/1 "IBM Plex Mono", ui-monospace, monospace;
      letter-spacing: .07em; text-transform: uppercase; color: var(--muted);
    }
    .authnav-input {
      width: 100%; height: 42px; padding: 0 12px; border-radius: 9px;
      border: 1px solid var(--border); background: var(--bg); color: var(--text);
      font: 400 15px/1.4 "IBM Plex Sans", system-ui, sans-serif;
    }
    .authnav-pw { position: relative; }
    .authnav-pw .authnav-input { padding-right: 74px; }
    .authnav-toggle {
      position: absolute; right: 3px; top: 3px; height: 36px; min-width: 62px;
      border: 0; background: transparent; color: var(--primary); cursor: pointer;
      font: 600 13px/1 "IBM Plex Sans", system-ui, sans-serif; border-radius: 7px;
    }
    .authnav-toggle:hover { background: var(--primary-soft); }
    .authnav-submit {
      height: 42px; margin-top: 4px; border: 0; border-radius: 9px; cursor: pointer;
      background: var(--primary); color: var(--primary-contrast);
      font: 600 15px/1 "IBM Plex Sans", system-ui, sans-serif;
    }
    .authnav-submit:hover { filter: brightness(1.06); }
    .authnav-submit:disabled { opacity: .65; cursor: default; }
    .authnav-error {
      background: var(--warn-bg, rgba(139,46,26,.10)); color: var(--warn, #8b2e1a);
      border: 1px solid var(--border); border-radius: 9px; padding: 9px 11px;
      font-size: 13px; line-height: 1.4;
    }
    .authnav-forgot {
      color: var(--primary); text-decoration: none; font-size: 13px;
      text-align: center; padding-top: 2px;
    }
    .authnav-forgot:hover { text-decoration: underline; }
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
