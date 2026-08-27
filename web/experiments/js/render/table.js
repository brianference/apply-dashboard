/**
 * The assignment table: one row per application in the experiment, with the
 * outcome recorded against it.
 */

import { el } from "../lib/dom.js";

/**
 * @param {string} value
 * @returns {string}
 */
const short = (value) => String(value || "").slice(0, 10);

/**
 * @param {object[]} assignments
 * @param {string[]} stages
 * @param {(key: string, stage: string, date: string) => void} onRecord
 * @returns {HTMLElement}
 */
export function renderTable(assignments, stages, onRecord) {
  if (!assignments || !assignments.length) {
    return el("p", { class: "empty" }, ["No applications assigned yet."]);
  }
  const head = el("thead", {}, [
    el("tr", {}, ["Arm", "Company", "Role", "Sent", "Furthest stage", "Record"].map((h) => el("th", {}, [h])))
  ]);
  const rows = assignments.map((row) => {
    const select = el("select", { class: "stage" }, [
      el("option", { value: "" }, ["record an outcome"]),
      ...stages.map((s) => el("option", { value: s }, [s.replace(/-/g, " ")]))
    ]);
    const date = el("input", { type: "date", class: "on", value: new Date().toISOString().slice(0, 10) });
    const save = el("button", {
      type: "button",
      onclick: () => {
        if (!select.value) return;
        onRecord(row.dedupe_key, select.value, date.value);
      }
    }, ["Save"]);
    return el("tr", {}, [
      el("td", {}, [el("span", { class: "chip" }, [row.arm])]),
      el("td", {}, [row.company || "—"]),
      el("td", { class: "role" }, [row.title || "—"]),
      el("td", {}, [row.status === "submitted" ? short(row.submitted_at) : el("span", { class: "muted" }, ["not sent"])]),
      el("td", {}, [
        row.latest_stage
          ? el("span", { class: "stagechip" }, [String(row.latest_stage).replace(/-/g, " ")])
          : el("span", { class: "muted" }, ["nothing recorded"])
      ]),
      el("td", { class: "record" }, [select, date, save])
    ]);
  });
  return el("table", { class: "assignments" }, [head, el("tbody", {}, rows)]);
}
