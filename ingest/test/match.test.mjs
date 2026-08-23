import { test } from "node:test";
import assert from "node:assert/strict";
import { assignLane, dedupeKey, scoreMatch } from "../match.mjs";

test("scoreMatch is deterministic for the same inputs", () => {
  const a = scoreMatch({
    title: "Senior Product Manager, Growth",
    work_type: "Remote US"
  });
  const b = scoreMatch({
    title: "Senior Product Manager, Growth",
    work_type: "Remote US"
  });
  assert.equal(a, b);
});

test("scoreMatch rewards senior PM + remote US + growth", () => {
  const score = scoreMatch({
    title: "Senior Product Manager, Growth",
    work_type: "Remote United States"
  });
  assert.equal(score, 80);
});

test("scoreMatch rewards principal AI PM above a generic PM", () => {
  const principal = scoreMatch({
    title: "Principal Product Manager, AI Platform",
    work_type: "Remote US"
  });
  const generic = scoreMatch({
    title: "Product Manager",
    work_type: "New York, NY"
  });
  assert.ok(principal > generic);
  assert.equal(principal, 100);
  assert.equal(generic, 40);
});

test("scoreMatch is not random and stays in 0..100", () => {
  const samples = [
    { title: "Intern", work_type: "" },
    { title: "Staff Product Manager, Platform", work_type: "Remote USA" },
    { title: "Technical Program Manager", work_type: "Remote" },
    { title: "Contract Product Manager (1099)", work_type: "Part-time remote US" }
  ];
  for (const sample of samples) {
    const score = scoreMatch(sample);
    assert.equal(Number.isInteger(score), true);
    assert.ok(score >= 0 && score <= 100);
  }
});

test("assignLane marks contract / C2C / part-time / 1099 as ptc2c", () => {
  assert.equal(assignLane({ title: "Product Manager (contract)", work_type: "Remote" }), "ptc2c");
  assert.equal(assignLane({ title: "Senior PM", work_type: "C2C" }), "ptc2c");
  assert.equal(assignLane({ title: "Fractional Product Manager", work_type: "" }), "ptc2c");
  assert.equal(assignLane({ title: "PM", work_type: "1099 contractor" }), "ptc2c");
  assert.equal(assignLane({ title: "Part-time Product Manager", work_type: "Remote US" }), "ptc2c");
});

test("assignLane defaults full-time roles to ft", () => {
  assert.equal(assignLane({ title: "Senior Product Manager", work_type: "Remote US" }), "ft");
});

test("dedupeKey lowercases company and title", () => {
  assert.equal(dedupeKey("GitLab", "Senior Product Manager, Growth"), "gitlab|senior product manager, growth");
});
