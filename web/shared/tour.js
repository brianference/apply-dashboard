/**
 * First-run spotlight tour for the jobs page.
 *
 * Selectors are taken from index.html and web/shared/site-nav.js as they
 * actually render. This module does not invent ids or classes.
 */

/** Number of steps in the tour. */
const STEP_COUNT = 5;
/** Extra pixels around the highlighted element. */
const CUTOUT_PADDING_PX = 8;
/** Gap between the cutout and the popover. */
const POPOVER_GAP_PX = 12;
/** Keep the popover this far from the viewport edge. */
const VIEWPORT_MARGIN_PX = 12;
/** Half the rotated pointer square, used to centre it on the cutout. */
const POINTER_HALF_PX = 6;
/** Minimum inset so the pointer stays on the popover edge. */
const POINTER_EDGE_MIN_PX = 16;
/** Opposite-edge inset matching the pointer size plus padding. */
const POINTER_EDGE_MAX_INSET_PX = 28;
/** A target wider than this share of the viewport sits above/below, not beside. */
const WIDE_TARGET_RATIO = 0.5;
/** Smallest popover height worth placing on a side. */
const MIN_SIDE_HEIGHT_PX = 80;
/** First index in a zero-based step list. */
const FIRST_STEP = 0;
/** Frames of unchanged scroll position that count as settled. */
const SCROLL_STABLE_FRAMES = 2;
/** Give up waiting for a target after this many milliseconds. */
const TARGET_WAIT_MS = 20000;
/** How many consecutive mutation checks before treating a missing target as gone. */
const SELECTOR_POLL_MS = 50;

/**
 * @typedef {{persist?: boolean}} TourOptions
 * persist: POST /api/tour/seen on skip or finish. False when restarted
 * from the account menu, so a replay never re-marks and never clears.
 */

/**
 * @typedef {{
 *   selectors: string[],
 *   title: string,
 *   body?: string,
 *   bodyParts?: Array<{text?: string, kbd?: string}>
 * }} TourStep
 */

/** @type {TourStep[]} */
const STEPS = [
  {
    /* First job row. id="rows-ft" is built in index.html as "rows-" + sec.id
       with sec.id "ft"; each posting is a div.row. */
    selectors: ["#rows-ft .row"],
    title: "Your ranked list",
    body: "Each row carries a percentage: how well the posting matches your resume. Sorted best first."
  },
  {
    /* The chip row. class="chips" with aria-label="Filters" in index.html. */
    selectors: [".chips"],
    title: "Filters",
    body: "These chips narrow the list: full-time, part-time and contract, jobs you have marked applied, postings labelled Under $180k, postings first published more than 30 days ago whose employer has not refreshed them, and roles that apply on the company’s own site."
  },
  {
    /* The tick on the first row. class="did" is the mark-applied control. */
    selectors: ["#rows-ft .row .did"],
    title: "Mark a job applied",
    body: "The tick on each row records that you applied. That mark is yours — it does not change anyone else’s list."
  },
  {
    /* Header search. id is set in web/shared/site-nav.js searchControl(). */
    selectors: ["#site-search-input"],
    title: "Search",
    bodyParts: [
      { text: "The box in the header filters the list. Press " },
      { kbd: "/" },
      { text: " from anywhere on the page to focus it." }
    ]
  },
  {
    /* Masthead tabs. hrefs come from SECTIONS in web/shared/site-nav.js. */
    selectors: ['nav.tabs a[href="/portfolio/"]', 'nav.tabs a[href="/profile/"]'],
    title: "Profile and portfolio",
    body: "A profile builds a public portfolio page at its own address. Portfolio and Profile are the last two tabs."
  }
];

const state = {
  open: false,
  step: FIRST_STEP,
  persist: true,
  lastFocus: /** @type {Element|null} */ (null),
  root: /** @type {HTMLElement|null} */ (null),
  /** Bumped on every layout so a scroll from a previous step cannot paint over this one. */
  layoutGen: 0,
  /** Ignore scroll/resize while showStep is laying out. */
  suppressViewport: false
};

/**
 * Whether the current page is the jobs list.
 * @returns {boolean}
 */
export function tourAvailable() {
  const path = location.pathname;
  return path === "/" || path === "/index.html";
}

/**
 * Whether the person has asked for less motion.
 * @returns {boolean}
 */
function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Resolve the live nodes for one step.
 * @param {TourStep} step
 * @returns {HTMLElement[]}
 */
function stepNodes(step) {
  return step.selectors
    .map((sel) => document.querySelector(sel))
    .filter(/** @type {(n: Element|null) => n is HTMLElement} */ ((n) => n instanceof HTMLElement));
}

/**
 * Union bounding box of one or more elements, in viewport coordinates.
 * @param {HTMLElement[]} nodes
 * @returns {{top:number,left:number,width:number,height:number}|null}
 */
function unionRect(nodes) {
  let box = /** @type {{top:number,left:number,right:number,bottom:number}|null} */ (null);
  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    if (!box) {
      box = { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom };
      continue;
    }
    box.top = Math.min(box.top, rect.top);
    box.left = Math.min(box.left, rect.left);
    box.right = Math.max(box.right, rect.right);
    box.bottom = Math.max(box.bottom, rect.bottom);
  }
  if (!box) return null;
  return { top: box.top, left: box.left, width: box.right - box.left, height: box.bottom - box.top };
}

/**
 * Expand a content box by the cutout padding.
 * @param {{top:number,left:number,width:number,height:number}} box
 * @returns {{top:number,left:number,width:number,height:number}}
 */
function paddedCutout(box) {
  return {
    top: box.top - CUTOUT_PADDING_PX,
    left: box.left - CUTOUT_PADDING_PX,
    width: box.width + CUTOUT_PADDING_PX * 2,
    height: box.height + CUTOUT_PADDING_PX * 2
  };
}

/**
 * Wait until scroll position stops changing. Uses the scrollend event when
 * the browser fires it, and otherwise consecutive animation frames with an
 * unchanged scroll offset — a settle signal, not a timer.
 * @returns {Promise<void>}
 */
function waitForScrollSettled() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener("scrollend", finish);
      resolve();
    };
    window.addEventListener("scrollend", finish, { once: true });
    let lastX = window.scrollX;
    let lastY = window.scrollY;
    let stable = 0;
    const tick = () => {
      if (done) return;
      if (window.scrollX === lastX && window.scrollY === lastY) {
        stable += 1;
        if (stable >= SCROLL_STABLE_FRAMES) {
          finish();
          return;
        }
      } else {
        stable = 0;
        lastX = window.scrollX;
        lastY = window.scrollY;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/**
 * Scroll a node into the viewport, then wait until scrolling has actually
 * stopped before the caller measures.
 * @param {HTMLElement} node
 * @returns {Promise<void>}
 */
async function scrollNodeIntoView(node) {
  const rect = node.getBoundingClientRect();
  const viewH = document.documentElement.clientHeight;
  const viewW = document.documentElement.clientWidth;
  const visible =
    rect.top >= 0 &&
    rect.bottom <= viewH &&
    rect.left >= 0 &&
    rect.right <= viewW;
  if (visible) return;
  const wait = waitForScrollSettled();
  node.scrollIntoView({
    block: "center",
    inline: "nearest",
    behavior: "auto"
  });
  await wait;
}

/**
 * Wait for a selector to match, watching the DOM rather than sleeping.
 * @param {string} selector
 * @returns {Promise<HTMLElement|null>}
 */
function waitForSelector(selector) {
  const existing = document.querySelector(selector);
  if (existing instanceof HTMLElement) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const started = Date.now();
    const obs = new MutationObserver(() => {
      const node = document.querySelector(selector);
      if (node instanceof HTMLElement) {
        obs.disconnect();
        resolve(node);
      } else if (Date.now() - started >= TARGET_WAIT_MS) {
        obs.disconnect();
        resolve(null);
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    const poll = () => {
      const node = document.querySelector(selector);
      if (node instanceof HTMLElement) {
        obs.disconnect();
        resolve(node);
        return;
      }
      if (Date.now() - started >= TARGET_WAIT_MS) {
        obs.disconnect();
        resolve(null);
        return;
      }
      setTimeout(poll, SELECTOR_POLL_MS);
    };
    setTimeout(poll, SELECTOR_POLL_MS);
  });
}

/**
 * Free space on each side of a cutout, in pixels.
 * @param {{top:number,left:number,width:number,height:number}} cut
 * @param {number} viewW
 * @param {number} viewH
 * @returns {{above:number,below:number,left:number,right:number}}
 */
function freeSpace(cut, viewW, viewH) {
  return {
    above: Math.max(0, cut.top - VIEWPORT_MARGIN_PX),
    below: Math.max(0, viewH - (cut.top + cut.height) - VIEWPORT_MARGIN_PX),
    left: Math.max(0, cut.left - VIEWPORT_MARGIN_PX),
    right: Math.max(0, viewW - (cut.left + cut.width) - VIEWPORT_MARGIN_PX)
  };
}

/**
 * Sides to try, most free space first. Wide targets skip left/right.
 * @param {{top:number,left:number,width:number,height:number}} cut
 * @param {number} viewW
 * @param {number} viewH
 * @returns {Array<"above"|"below"|"left"|"right">}
 */
function sidesBySpace(cut, viewW, viewH) {
  const space = freeSpace(cut, viewW, viewH);
  const wide = cut.width >= viewW * WIDE_TARGET_RATIO;
  /** @type {Array<"above"|"below"|"left"|"right">} */
  const names = wide ? ["above", "below"] : ["above", "below", "left", "right"];
  return names.sort((a, b) => space[b] - space[a]);
}

/**
 * Clamp a number into [min, max], returning min when the range is empty.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * @typedef {{top:number,left:number,width:number,height:number,place:string}} PopBox
 */

/**
 * Place the popover on one side of the cutout, shrinking it to the remaining
 * slot so a clamp can never slide it onto the spotlight.
 * @param {"above"|"below"|"left"|"right"} side
 * @param {{top:number,left:number,width:number,height:number}} cut
 * @param {number} popW
 * @param {number} popH
 * @param {number} viewW
 * @param {number} viewH
 * @returns {PopBox|null}
 */
function positionForSide(side, cut, popW, popH, viewW, viewH) {
  const width = Math.min(popW, viewW - VIEWPORT_MARGIN_PX * 2);
  if (width <= 0) return null;

  if (side === "below") {
    const top = cut.top + cut.height + POPOVER_GAP_PX;
    const avail = viewH - VIEWPORT_MARGIN_PX - top;
    if (avail < MIN_SIDE_HEIGHT_PX) return null;
    const height = Math.min(popH, avail);
    const left = clamp(cut.left, VIEWPORT_MARGIN_PX, viewW - width - VIEWPORT_MARGIN_PX);
    return { top, left, width, height, place: side };
  }
  if (side === "above") {
    const avail = cut.top - POPOVER_GAP_PX - VIEWPORT_MARGIN_PX;
    if (avail < MIN_SIDE_HEIGHT_PX) return null;
    const height = Math.min(popH, avail);
    const top = cut.top - POPOVER_GAP_PX - height;
    const left = clamp(cut.left, VIEWPORT_MARGIN_PX, viewW - width - VIEWPORT_MARGIN_PX);
    return { top, left, width, height, place: side };
  }
  if (side === "right") {
    const left = cut.left + cut.width + POPOVER_GAP_PX;
    const avail = viewW - VIEWPORT_MARGIN_PX - left;
    if (avail < width && avail < MIN_SIDE_HEIGHT_PX) return null;
    const usedW = Math.min(width, Math.max(0, avail));
    if (usedW <= 0) return null;
    const top = clamp(cut.top, VIEWPORT_MARGIN_PX, viewH - Math.min(popH, viewH - VIEWPORT_MARGIN_PX * 2) - VIEWPORT_MARGIN_PX);
    const height = Math.min(popH, viewH - VIEWPORT_MARGIN_PX - top);
    if (height < MIN_SIDE_HEIGHT_PX) return null;
    return { top, left, width: usedW, height, place: side };
  }
  const avail = cut.left - POPOVER_GAP_PX - VIEWPORT_MARGIN_PX;
  if (avail < MIN_SIDE_HEIGHT_PX) return null;
  const usedW = Math.min(width, avail);
  if (usedW <= 0) return null;
  const left = cut.left - POPOVER_GAP_PX - usedW;
  const top = clamp(cut.top, VIEWPORT_MARGIN_PX, viewH - Math.min(popH, viewH - VIEWPORT_MARGIN_PX * 2) - VIEWPORT_MARGIN_PX);
  const height = Math.min(popH, viewH - VIEWPORT_MARGIN_PX - top);
  if (height < MIN_SIDE_HEIGHT_PX) return null;
  return { top, left, width: usedW, height, place: "left" };
}

/**
 * Whether two viewport rectangles overlap. Touching edges do not count.
 * @param {{top:number,left:number,width:number,height:number}} a
 * @param {{top:number,left:number,width:number,height:number}} b
 * @returns {boolean}
 */
function rectsOverlap(a, b) {
  return a.left < b.left + b.width && a.left + a.width > b.left
    && a.top < b.top + b.height && a.top + a.height > b.top;
}

/**
 * Fallback when no side has MIN_SIDE_HEIGHT_PX: pin inside the viewport
 * without covering the cutout if that is still possible.
 * @param {{top:number,left:number,width:number,height:number}} cut
 * @param {number} popW
 * @param {number} popH
 * @param {number} viewW
 * @param {number} viewH
 * @returns {PopBox}
 */
function fallbackBox(cut, popW, popH, viewW, viewH) {
  const width = Math.min(popW, viewW - VIEWPORT_MARGIN_PX * 2);
  const height = Math.min(popH, viewH - VIEWPORT_MARGIN_PX * 2);
  const belowTop = cut.top + cut.height + POPOVER_GAP_PX;
  const belowAvail = viewH - VIEWPORT_MARGIN_PX - belowTop;
  if (belowAvail >= height * 0.5) {
    return { top: belowTop, left: VIEWPORT_MARGIN_PX, width, height: Math.min(height, Math.max(belowAvail, 1)), place: "below" };
  }
  const aboveAvail = cut.top - POPOVER_GAP_PX - VIEWPORT_MARGIN_PX;
  if (aboveAvail > 0) {
    const h = Math.min(height, aboveAvail);
    return { top: cut.top - POPOVER_GAP_PX - h, left: VIEWPORT_MARGIN_PX, width, height: h, place: "above" };
  }
  return { top: VIEWPORT_MARGIN_PX, left: VIEWPORT_MARGIN_PX, width, height, place: "below" };
}

/**
 * Choose a popover box that does not overlap the cutout.
 * @param {{top:number,left:number,width:number,height:number}} cut
 * @param {HTMLElement} pop
 * @returns {PopBox}
 */
function placePopover(cut, pop) {
  const viewW = document.documentElement.clientWidth;
  const viewH = document.documentElement.clientHeight;
  pop.style.maxHeight = `${viewH - VIEWPORT_MARGIN_PX * 2}px`;
  pop.style.width = `${Math.min(360, viewW - VIEWPORT_MARGIN_PX * 2)}px`;
  pop.style.height = "auto";
  const popW = pop.offsetWidth;
  const popH = pop.scrollHeight;
  const sides = sidesBySpace(cut, viewW, viewH);
  for (const side of sides) {
    const box = positionForSide(side, cut, popW, popH, viewW, viewH);
    if (!box) continue;
    if (rectsOverlap(box, cut)) continue;
    return box;
  }
  return fallbackBox(cut, popW, popH, viewW, viewH);
}

/**
 * Point the diamond at the cutout along the attached edge.
 * @param {PopBox} box
 * @param {{top:number,left:number,width:number,height:number}} cut
 * @param {HTMLElement} pointer
 * @returns {void}
 */
function positionPointer(box, cut, pointer) {
  const cx = cut.left + cut.width / 2;
  const cy = cut.top + cut.height / 2;
  pointer.style.top = "";
  pointer.style.bottom = "";
  pointer.style.left = "";
  pointer.style.right = "";
  if (box.place === "below" || box.place === "above") {
    pointer.style.left = `${clamp(cx - box.left - POINTER_HALF_PX, POINTER_EDGE_MIN_PX, box.width - POINTER_EDGE_MAX_INSET_PX)}px`;
  } else {
    pointer.style.top = `${clamp(cy - box.top - POINTER_HALF_PX, POINTER_EDGE_MIN_PX, box.height - POINTER_EDGE_MAX_INSET_PX)}px`;
  }
}

/**
 * Paint the cutout over the current targets.
 * @param {{top:number,left:number,width:number,height:number}|null} cut
 * @returns {void}
 */
function applyCutout(cut) {
  const el = document.getElementById("tour-cutout");
  if (!(el instanceof HTMLElement)) return;
  if (!cut) {
    el.style.display = "none";
    return;
  }
  el.style.display = "block";
  if (prefersReducedMotion()) el.style.transition = "none";
  el.style.top = `${cut.top}px`;
  el.style.left = `${cut.left}px`;
  el.style.width = `${cut.width}px`;
  el.style.height = `${cut.height}px`;
}

/**
 * Apply a computed popover box.
 * @param {PopBox} box
 * @param {HTMLElement} pop
 * @returns {void}
 */
function applyPopoverBox(box, pop) {
  pop.style.top = `${box.top}px`;
  pop.style.left = `${box.left}px`;
  pop.style.width = `${box.width}px`;
  pop.style.maxHeight = `${box.height}px`;
  pop.setAttribute("data-place", box.place);
}

/**
 * Scroll the first target into view, then lay out cutout and popover.
 * A generation number drops any layout that a later step or scroll superseded.
 * @returns {Promise<void>}
 */
async function layoutTour() {
  const gen = ++state.layoutGen;
  await runLayout(gen);
}

/**
 * @param {number} gen
 * @returns {Promise<void>}
 */
async function runLayout(gen) {
  if (!state.open) return;
  const stepIndex = state.step;
  const step = STEPS[stepIndex];
  const nodes = stepNodes(step);
  if (!nodes.length) return;
  await scrollNodeIntoView(nodes[0]);
  if (!state.open || gen !== state.layoutGen || state.step !== stepIndex) return;
  const content = unionRect(stepNodes(step));
  if (!content) return;
  const cut = paddedCutout(content);
  applyCutout(cut);
  const pop = document.getElementById("tour-popover");
  const pointer = document.getElementById("tour-pointer");
  if (!(pop instanceof HTMLElement) || !(pointer instanceof HTMLElement)) return;
  const box = placePopover(cut, pop);
  applyPopoverBox(box, pop);
  positionPointer(box, cut, pointer);
}

/**
 * Fill the body from plain text or mixed text/kbd parts.
 * @param {TourStep} step
 * @param {HTMLElement} body
 * @returns {void}
 */
function setBodyContent(step, body) {
  body.replaceChildren();
  if (step.bodyParts) {
    for (const part of step.bodyParts) {
      if (part.kbd) {
        const kbd = document.createElement("kbd");
        kbd.className = "kbd";
        kbd.textContent = part.kbd;
        body.append(kbd);
      } else if (part.text) {
        body.append(document.createTextNode(part.text));
      }
    }
    return;
  }
  body.textContent = step.body || "";
}

/**
 * Fill popover copy for the current step and refresh layout.
 * @returns {Promise<void>}
 */
async function showStep() {
  const step = STEPS[state.step];
  const count = document.getElementById("tour-count");
  const title = document.getElementById("tour-title");
  const body = document.getElementById("tour-body");
  const back = document.getElementById("tour-back");
  const next = document.getElementById("tour-next");
  const pop = document.getElementById("tour-popover");
  if (pop) pop.removeAttribute("data-ready");
  if (count) count.textContent = `Step ${state.step + 1} of ${STEP_COUNT}`;
  if (title) title.textContent = step.title;
  if (body instanceof HTMLElement) setBodyContent(step, body);
  if (back instanceof HTMLButtonElement) back.disabled = state.step === FIRST_STEP;
  if (next) next.textContent = state.step === STEP_COUNT - 1 ? "Done" : "Next";
  state.suppressViewport = true;
  try {
    await layoutTour();
  } finally {
    state.suppressViewport = false;
  }
  if (pop) {
    pop.setAttribute("data-step", String(state.step));
    pop.setAttribute("data-ready", "1");
  }
  if (next instanceof HTMLElement) next.focus();
}

/**
 * Mark every page landmark inert except the tour itself.
 * @param {boolean} on
 * @returns {void}
 */
function setPageInert(on) {
  Array.prototype.forEach.call(document.body.children, (el) => {
    if (!(el instanceof HTMLElement)) return;
    if (el.id === "tour-root") return;
    if (on) el.setAttribute("inert", "");
    else el.removeAttribute("inert");
  });
}

/**
 * Focusable controls inside the popover, in tab order.
 * @returns {HTMLElement[]}
 */
function focusables() {
  const root = document.getElementById("tour-popover");
  if (!root) return [];
  return Array.prototype.slice.call(root.querySelectorAll("button:not([disabled])"));
}

/**
 * Keep Tab inside the popover while the dialog is open.
 * @param {KeyboardEvent} event
 * @returns {void}
 */
function trapFocus(event) {
  if (!state.open || event.key !== "Tab") return;
  const nodes = focusables();
  if (!nodes.length) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * Whether an element can actually receive focus.
 * @param {Element|null} node
 * @returns {boolean}
 */
function canFocus(node) {
  if (!(node instanceof HTMLElement) || typeof node.focus !== "function") return false;
  if (!document.contains(node)) return false;
  if (node.closest("[hidden]")) return false;
  const rects = node.getClientRects();
  return rects.length > 0;
}

/**
 * Return focus to where it was, or to the account chip if that node is gone.
 * @returns {void}
 */
function restoreFocus() {
  if (canFocus(state.lastFocus)) {
    /** @type {HTMLElement} */ (state.lastFocus).focus();
    return;
  }
  const account = document.querySelector("header.site .chip-btn");
  if (account instanceof HTMLElement) account.focus();
}

/**
 * Tell the server this account has seen the tour. Swallowed on failure so a
 * network blip cannot print a console error; they will simply see it again.
 * @returns {Promise<void>}
 */
async function markSeen() {
  if (!state.persist) return;
  try {
    await fetch("/api/tour/seen", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
  } catch {
    /* leave tour_seen_at null so the next visit can try again */
  }
}

/**
 * Close the tour, optionally recording that it was seen.
 * @param {{seen?: boolean}} [opts]
 * @returns {Promise<void>}
 */
async function closeTour(opts = {}) {
  if (!state.open) return;
  state.open = false;
  document.removeEventListener("keydown", onTourKey, true);
  window.removeEventListener("resize", onViewportChange);
  window.removeEventListener("scroll", onViewportChange);
  if (opts.seen) await markSeen();
  if (state.root) state.root.hidden = true;
  setPageInert(false);
  restoreFocus();
}

/**
 * Advance one step, or finish on the last step.
 * @returns {Promise<void>}
 */
async function nextStep() {
  if (state.step >= STEP_COUNT - 1) {
    await closeTour({ seen: true });
    return;
  }
  state.step += 1;
  await showStep();
}

/**
 * Go back one step.
 * @returns {Promise<void>}
 */
async function prevStep() {
  if (state.step === FIRST_STEP) return;
  state.step -= 1;
  await showStep();
}

/**
 * Handle tour keys: arrows, Escape, Enter, and the Tab trap.
 * @param {KeyboardEvent} event
 * @returns {void}
 */
function onTourKey(event) {
  if (!state.open) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    void closeTour({ seen: true });
    return;
  }
  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    event.preventDefault();
    event.stopPropagation();
    void nextStep();
    return;
  }
  if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    event.preventDefault();
    event.stopPropagation();
    void prevStep();
    return;
  }
  if (event.key === "Enter") {
    const tag = event.target instanceof HTMLElement ? event.target.tagName : "";
    if (tag === "BUTTON") return;
    event.preventDefault();
    event.stopPropagation();
    void nextStep();
    return;
  }
  if (event.key === "Tab") {
    trapFocus(event);
    event.stopPropagation();
  }
}

/**
 * Relayout on viewport change. Bound so it can be removed.
 * @returns {void}
 */
function onViewportChange() {
  if (state.suppressViewport) return;
  void layoutTour();
}

/**
 * Build the tour DOM once and reuse it.
 * @returns {HTMLElement}
 */
function buildDom() {
  const existing = document.getElementById("tour-root");
  if (existing instanceof HTMLElement) return existing;
  const root = document.createElement("div");
  root.id = "tour-root";
  root.hidden = true;
  const stage = document.createElement("div");
  stage.className = "tour-stage";
  stage.setAttribute("aria-hidden", "true");
  const cut = document.createElement("div");
  cut.className = "cutout";
  cut.id = "tour-cutout";
  stage.append(cut);
  const pop = document.createElement("div");
  pop.className = "popover";
  pop.id = "tour-popover";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-modal", "true");
  pop.setAttribute("aria-labelledby", "tour-title");
  pop.setAttribute("aria-describedby", "tour-body");
  pop.tabIndex = -1;
  const pointer = document.createElement("span");
  pointer.className = "popover-pointer";
  pointer.id = "tour-pointer";
  pointer.setAttribute("aria-hidden", "true");
  const count = document.createElement("p");
  count.className = "step-count";
  count.id = "tour-count";
  count.setAttribute("aria-live", "polite");
  const title = document.createElement("h2");
  title.id = "tour-title";
  const body = document.createElement("p");
  body.id = "tour-body";
  const actions = document.createElement("div");
  actions.className = "popover-actions";
  const skip = document.createElement("button");
  skip.type = "button";
  skip.className = "btn btn-ghost";
  skip.id = "tour-skip";
  skip.textContent = "Skip";
  skip.addEventListener("click", () => { void closeTour({ seen: true }); });
  const grow = document.createElement("span");
  grow.className = "grow";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "btn btn-back";
  back.id = "tour-back";
  back.textContent = "Back";
  back.addEventListener("click", () => { void prevStep(); });
  const next = document.createElement("button");
  next.type = "button";
  next.className = "btn btn-next";
  next.id = "tour-next";
  next.textContent = "Next";
  next.addEventListener("click", () => { void nextStep(); });
  actions.append(skip, grow, back, next);
  pop.append(pointer, count, title, body, actions);
  root.append(stage, pop);
  document.body.append(root);
  return root;
}

/**
 * Run the tour once the first target exists.
 * @param {TourOptions} options
 * @returns {Promise<void>}
 */
async function runTour(options) {
  if (!tourAvailable()) return;
  const first = await waitForSelector(STEPS[FIRST_STEP].selectors[0]);
  if (!first) return;
  if (state.open) await closeTour({ seen: false });
  state.lastFocus = document.activeElement instanceof Element ? document.activeElement : null;
  state.persist = options.persist !== false;
  state.step = FIRST_STEP;
  state.root = buildDom();
  state.open = true;
  state.root.hidden = false;
  setPageInert(true);
  document.addEventListener("keydown", onTourKey, true);
  window.addEventListener("resize", onViewportChange);
  window.addEventListener("scroll", onViewportChange, { passive: true });
  await showStep();
}

/**
 * Open the tour on the first step.
 * @param {TourOptions} [options]
 * @returns {void}
 */
export function startTour(options = {}) {
  void runTour(options);
}
