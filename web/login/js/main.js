/**
 * The sign-in page. One card, three states, chosen by the query string.
 *
 *   /login/               sign in
 *   /login/?reset=1       ask for a link
 *   /login/?token=...     set a password from that link
 *
 * Three states rather than three pages because they are the same card with
 * different fields, and a person following a reset link should not have to
 * notice they changed pages.
 */

import { mount } from "./dom.js";
import * as api from "./api.js";
import { wirePasswordToggle } from "./password-toggle.js";
/* The footer, and only the footer. It is documented as being on every page
   and it mounts inside mountSiteNav(), which this page never called, so the
   four legal documents were unreachable from the one page a new person is
   most likely to land on. The HEADER is deliberately left off: a sign-in
   control at the top of the sign-in page is noise. */
import { mountFooter } from "/shared/site-nav.js";

const params = new URLSearchParams(location.search);
const token = params.get("token");
const wantsReset = params.get("reset") === "1";
const wantsSignup = params.get("signup") === "1";
const verifyToken = params.get("verify");

const ui = {
  heading: mount("#heading"),
  purpose: mount("#purpose"),
  alert: mount("#alert"),
  alertText: mount("#alert-text"),
  form: mount("#form"),
  emailField: mount("#email-field"),
  passwordField: mount("#password-field"),
  passwordLabel: mount("#password-label"),
  email: mount("#email"),
  password: mount("#password"),
  submit: mount("#submit"),
  secondary: mount("#secondary")
};

/**
 * @param {string} message
 * @param {"error"|"ok"} [tone]
 * @returns {void}
 */
function say(message, tone = "error") {
  ui.alert.hidden = !message;
  ui.alert.classList.toggle("ok", tone === "ok");
  ui.alertText.textContent = message || "";
}

/**
 * @param {boolean} busy
 * @returns {void}
 */
function setBusy(busy) {
  ui.submit.disabled = busy;
  ui.submit.textContent = busy ? "Working…" : ui.submit.dataset.label;
}

/** Sign in. */
function stateSignIn() {
  ui.heading.textContent = "AI PM Jobs";
  ui.purpose.textContent = "Sign in to record applications and outcomes.";
  ui.submit.dataset.label = "Sign in";
  ui.submit.textContent = "Sign in";
  ui.secondary.textContent = "Forgot your password";
  ui.secondary.setAttribute("href", "?reset=1");
  ui.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    say("");
    setBusy(true);
    try {
      await api.login(ui.email.value.trim(), ui.password.value);
      /* Straight to the list, which is the thing they signed in to use. */
      location.href = "/";
    } catch (error) {
      say(String(error.message || error));
      setBusy(false);
    }
  });
}

/** Ask for a link. */
function stateRequestReset() {
  ui.heading.textContent = "Set your password";
  ui.purpose.textContent = "We will email you a link. It works once and expires in an hour.";
  ui.passwordField.hidden = true;
  ui.password.required = false;
  ui.submit.dataset.label = "Email me a link";
  ui.submit.textContent = "Email me a link";
  ui.secondary.textContent = "Back to sign in";
  ui.secondary.setAttribute("href", "/login/");
  ui.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    say("");
    setBusy(true);
    try {
      const res = await api.requestReset(ui.email.value.trim());
      /* The same message regardless, because the endpoint answers the same
         regardless. Saying "sent!" only for real addresses would undo on the
         page exactly what the API is careful not to leak. */
      say(res.message, "ok");
      ui.form.hidden = true;
    } catch (error) {
      say(String(error.message || error));
      setBusy(false);
    }
  });
}

/** Set a password from an emailed link. */
function stateSetPassword() {
  ui.heading.textContent = "Choose a password";
  ui.purpose.textContent = "At least 15 characters. A passphrase you can remember beats a short one you cannot.";
  ui.emailField.hidden = true;
  ui.email.required = false;
  ui.passwordLabel.textContent = "New password";
  ui.password.setAttribute("autocomplete", "new-password");
  ui.submit.dataset.label = "Set password and sign in";
  ui.submit.textContent = "Set password and sign in";
  ui.secondary.hidden = true;
  ui.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    say("");
    if (ui.password.value.length < 15) {
      say("Password must be at least 15 characters.");
      return;
    }
    setBusy(true);
    try {
      await api.reset(token, ui.password.value);
      location.href = "/";
    } catch (error) {
      say(String(error.message || error));
      setBusy(false);
    }
  });
}

wirePasswordToggle(mount("#pw-toggle"), ui.password, mount("#pw-toggle-text"));

/** Make an account. */
function stateSignUp() {
  ui.heading.textContent = "Create your account";
  ui.purpose.textContent = "Free. Your own job list, profile and portfolio.";
  ui.passwordLabel.textContent = "Choose a password";
  ui.password.setAttribute("autocomplete", "new-password");
  ui.submit.dataset.label = "Create account";
  ui.submit.textContent = "Create account";
  ui.secondary.textContent = "Already have an account? Sign in";
  ui.secondary.setAttribute("href", "/login/");
  ui.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    say("");
    if (ui.password.value.length < 15) {
      say("Password must be at least 15 characters.");
      return;
    }
    setBusy(true);
    try {
      const res = await api.register(ui.email.value.trim(), ui.password.value);
      /* The same message whether or not the address was already registered.
         Saying "that email is taken" would answer a question a stranger should
         not be able to ask. */
      say(res.message, "ok");
      ui.form.hidden = true;
    } catch (error) {
      say(String(error.message || error));
      setBusy(false);
    }
  });
}

/** Activate from the emailed link. */
async function stateVerify() {
  ui.heading.textContent = "Activating your account";
  ui.purpose.textContent = "";
  ui.form.hidden = true;
  ui.secondary.hidden = true;
  try {
    await api.verify(verifyToken);
    location.href = "/";
  } catch (error) {
    ui.heading.textContent = "That link did not work";
    say(String(error.message || error));
    ui.secondary.hidden = false;
    ui.secondary.textContent = "Back to sign in";
    ui.secondary.setAttribute("href", "/login/");
  }
}

if (verifyToken) stateVerify();
else if (token) stateSetPassword();
else if (wantsReset) stateRequestReset();
else if (wantsSignup) stateSignUp();
else stateSignIn();

/* Already signed in? Do not show a sign-in form to someone who is. */
if (!token && !verifyToken) {
  api.me().then((who) => {
    if (who.authenticated) location.href = "/";
  }).catch(() => { /* offline is not a reason to block the form */ });
}

mountFooter();
