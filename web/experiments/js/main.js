/**
 * Entry point. Wires the modules together and owns nothing else.
 */

import { el, mount, replace } from "./lib/dom.js";
import { getState, setState, subscribe } from "./state.js";
import * as api from "./api.js";
import { renderSummary } from "./render/summary.js";
import { renderTable } from "./render/table.js";
import { trialsNeededPerArm } from "./lib/stats.js";
import { mountSiteNav } from "/shared/site-nav.js";

const DEFAULT_STAGES = ["no-response", "rejected", "recruiter-screen", "hiring-manager", "interview", "onsite", "offer", "withdrawn"];

/** @type {string[]} */
let stages = DEFAULT_STAGES;

/**
 * @param {string} message
 * @returns {void}
 */
function flash(message) {
  const bar = mount("#flash");
  bar.textContent = message;
  bar.hidden = !message;
}

/**
 * @returns {Promise<void>}
 */
async function loadExperiments() {
  const { experiments } = await api.fetchExperiments();
  setState({ experiments, loading: false });
  const names = [...new Set(experiments.map((e) => e.experiment))];
  const picker = mount("#picker");
  replace(picker, names.length
    ? names.map((name) => el("button", {
        type: "button",
        class: name === getState().selected ? "tab on" : "tab",
        onclick: () => selectExperiment(name)
      }, [name]))
    : [el("span", { class: "empty" }, ["No experiments yet. Create one below."])]);
  if (!getState().selected && names.length) await selectExperiment(names[0]);
}

/**
 * @param {string} name
 * @returns {Promise<void>}
 */
async function selectExperiment(name) {
  setState({ selected: name });
  try {
    const { assignments } = await api.fetchExperiment(name);
    replace(mount("#summary"), [renderSummary(assignments)]);
    replace(mount("#table"), [renderTable(assignments, stages, recordOutcome)]);
    for (const tab of document.querySelectorAll("#picker .tab")) {
      tab.classList.toggle("on", tab.textContent === name);
    }
  } catch (error) {
    flash(String(error.message || error));
  }
}

/**
 * @param {string} dedupeKey
 * @param {string} stage
 * @param {string} occurredOn
 * @returns {Promise<void>}
 */
async function recordOutcome(dedupeKey, stage, occurredOn) {
  try {
    await api.recordOutcome(dedupeKey, stage, occurredOn);
    flash(`recorded ${stage}`);
    if (getState().selected) await selectExperiment(getState().selected);
  } catch (error) {
    flash(String(error.message || error));
  }
}

/**
 * Assignment is manual and one application at a time. The variant content
 * lives in the local profile and answer bank, which never leave the machine
 * and are not in this public repository, so this page records the arm label
 * an application went out under rather than the material itself.
 * @returns {Promise<void>}
 */
async function assignFromForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const experiment = form.experiment.value.trim();
  const arm = form.arm.value.trim();
  const key = form.dedupe_key.value.trim();
  try {
    await api.assignArm(key, experiment, arm);
    flash(`assigned to ${arm}`);
    form.dedupe_key.value = "";
    await loadExperiments();
    await selectExperiment(experiment);
  } catch (error) {
    flash(String(error.message || error));
  }
}

/**
 * @returns {Promise<void>}
 */
/**
 * Signed out, this page shows why it is empty rather than an empty tool. The
 * job list is a deliberate free preview; an experiment is a record of what
 * Brian did, so it needs the session.
 * @returns {void}
 */
function renderSignInPrompt() {
  const panel = el("div", { class: "panel" }, [
    el("p", {}, ["Sign in to assign applications to an arm and record what came back."]),
    el("p", { class: "note" }, ["The job list is readable without an account. Experiments are not, because they are a record of what you actually sent."]),
    el("p", {}, [el("a", { class: "bannerbtn", href: "/login/" }, ["Sign in"])])
  ]);
  replace(mount("#summary"), [panel]);
  replace(mount("#table"), []);
  replace(mount("#picker"), []);
}

async function start() {
  mount("#assign").addEventListener("submit", assignFromForm);

  /* The number that matters most on this page, said before any result is. */
  mount("#power").textContent =
    `At a 5 percent callback rate, telling a real doubling from noise takes about ${trialsNeededPerArm(0.05, 0.05)} applications in EACH arm.`;

  const who = await mountSiteNav("#sitenav");
  if (!who.authenticated) {
    mount("#assign").hidden = true;
    renderSignInPrompt();
    return;
  }

  try {
    const [{ stages: fromApi }] = await Promise.all([api.fetchOutcomes(), loadExperiments()]);
    if (Array.isArray(fromApi) && fromApi.length) stages = fromApi;
  } catch (error) {
    flash(String(error.message || error));
  }
}

subscribe(() => {});
start();
