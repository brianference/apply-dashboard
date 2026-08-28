/**
 * Show and hide the password.
 *
 * A control that looks like it toggles and does not is worse than none, so this
 * flips the real input type and reports its state to assistive tech through
 * aria-pressed rather than only changing a label.
 *
 * The caret position is preserved: switching type resets it to the end in some
 * browsers, which loses your place mid-typing.
 */

/**
 * @param {HTMLElement} button
 * @param {HTMLInputElement} input
 * @param {HTMLElement} label
 * @returns {void}
 */
export function wirePasswordToggle(button, input, label) {
  button.addEventListener("click", () => {
    const showing = input.getAttribute("type") === "text";
    const start = input.selectionStart;
    const end = input.selectionEnd;
    input.setAttribute("type", showing ? "password" : "text");
    button.setAttribute("aria-pressed", String(!showing));
    button.setAttribute("aria-label", showing ? "Show password" : "Hide password");
    label.textContent = showing ? "Show" : "Hide";
    input.focus();
    try {
      if (start !== null && end !== null) input.setSelectionRange(start, end);
    } catch {
      /* Some input types refuse setSelectionRange. Focus alone is enough. */
    }
  });
  button.setAttribute("aria-label", "Show password");
}
