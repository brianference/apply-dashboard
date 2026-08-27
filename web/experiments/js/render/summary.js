/**
 * The arm comparison, and the sentence that stops it being believed too early.
 */

import { el } from "../lib/dom.js";
import { wilson, readOut } from "../lib/stats.js";

/** Stages that count as the employer having come back to you. */
const RESPONDED = new Set(["recruiter-screen", "hiring-manager", "interview", "onsite", "offer"]);

/**
 * Successes and trials per arm. A trial is a SENT application; an assignment
 * whose application never went out is not a trial and must not sit in the
 * denominator quietly making both arms look worse.
 *
 * @param {object[]} assignments rows from /api/experiments?name=
 * @returns {Record<string, {successes: number, trials: number, pending: number}>}
 */
export function tally(assignments) {
  /** @type {Record<string, {successes: number, trials: number, pending: number}>} */
  const byArm = {};
  for (const row of assignments || []) {
    const arm = String(row.arm || "unassigned");
    if (!byArm[arm]) byArm[arm] = { successes: 0, trials: 0, pending: 0 };
    if (row.status !== "submitted") {
      byArm[arm].pending += 1;
      continue;
    }
    byArm[arm].trials += 1;
    if (RESPONDED.has(String(row.latest_stage || ""))) byArm[arm].successes += 1;
  }
  return byArm;
}

/**
 * @param {number} value 0..1
 * @returns {string}
 */
const pct = (value) => `${(value * 100).toFixed(0)}%`;

/**
 * @param {object[]} assignments
 * @returns {HTMLElement}
 */
export function renderSummary(assignments) {
  const byArm = tally(assignments);
  const arms = Object.keys(byArm).sort();
  if (!arms.length) {
    return el("p", { class: "empty" }, ["Nothing assigned to this experiment yet."]);
  }

  const cards = arms.map((arm) => {
    const { successes, trials, pending } = byArm[arm];
    const w = wilson(successes, trials);
    return el("div", { class: "arm" }, [
      el("h3", {}, [arm]),
      el("b", {}, [trials ? pct(w.point) : "—"]),
      el("span", {}, [`${successes} of ${trials} sent`]),
      el("span", { class: "range" }, [trials ? `95% range ${pct(w.low)} to ${pct(w.high)}` : "no applications sent yet"]),
      pending ? el("span", { class: "pending" }, [`${pending} assigned, not yet sent`]) : ""
    ]);
  });

  const parts = [el("div", { class: "arms" }, cards)];

  if (arms.length === 2) {
    const verdict = readOut(byArm[arms[0]], byArm[arms[1]]);
    parts.push(
      el("div", { class: verdict.separated ? "verdict separated" : "verdict" }, [
        el("strong", {}, [verdict.verdict]),
        el("p", {}, [verdict.detail])
      ])
    );
  } else if (arms.length > 2) {
    parts.push(el("p", { class: "note" }, [
      "Three or more arms split the same volume further, so each one reaches a usable size later than a two-arm split would."
    ]));
  }
  return el("section", { class: "summary" }, parts);
}
