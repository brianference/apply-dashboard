import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeSqlLiteral, renderInsertIgnore } from "../sql.mjs";

test("escapeSqlLiteral doubles single quotes", () => {
  assert.equal(escapeSqlLiteral("O'Reilly"), "'O''Reilly'");
});

test("escapeSqlLiteral emits NULL for nullish values", () => {
  assert.equal(escapeSqlLiteral(null), "NULL");
  assert.equal(escapeSqlLiteral(undefined), "NULL");
});

test("escapeSqlLiteral does not concatenate unescaped values", () => {
  const injected = "x'); DROP TABLE jobs; --";
  assert.equal(escapeSqlLiteral(injected), "'x''); DROP TABLE jobs; --'");
});

test("renderInsertIgnore produces INSERT OR IGNORE with escaped fields", () => {
  const sql = renderInsertIgnore({
    dedupe_key: "acme|senior pm",
    company: "Acme",
    title: "Senior PM",
    url: "https://example.com/job",
    match_pct: 72,
    source: "greenhouse",
    status: "queued",
    lane: "ft",
    submitted_at: null,
    posted: "2026-08-01",
    work_type: "Remote US",
    updated_at: "2026-08-22T00:00:00.000Z"
  });
  assert.match(sql, /^INSERT OR IGNORE INTO jobs \(/);
  assert.match(sql, /'acme\|senior pm'/);
  assert.match(sql, /NULL,/);
  assert.doesNotMatch(sql, /\$\{/);
});
