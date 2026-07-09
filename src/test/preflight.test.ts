import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPreflight } from "../preflight.js";
import type { ShapeResult } from "../types.js";

const pass: ShapeResult = { pass: true, errors: [], warnings: [] };
const fail: ShapeResult = {
  pass: false,
  errors: ["diff_sha256 mismatch: receipt says abc… but diff is def…"],
  warnings: [],
};

// #39 — the whole point: the local shape pre-flight must NOT masquerade as the
// full gate verdict. It reports only the shape dimension.

test("renderPreflight PASS: reports the shape dimension, never a bare gate verdict", () => {
  const out = renderPreflight(pass);
  assert.match(out, /shape pre-flight: PASS/);
  // must NOT print the final-verdict banner vocabulary
  assert.doesNotMatch(out, /plumbline: APPROVE/);
  assert.doesNotMatch(out, /plumbline: REVIEW/);
  assert.doesNotMatch(out, /plumbline: REWORK/);
  // must point at where the real verdict comes from
  assert.match(out, /--review/);
  assert.match(out, /CI/);
  assert.match(out, /NOT the full gate verdict/);
});

test("renderPreflight FAIL: says FAIL and surfaces the shape errors", () => {
  const out = renderPreflight(fail);
  assert.match(out, /shape pre-flight: FAIL/);
  assert.match(out, /❌ diff_sha256 mismatch/);
  // still not a gate verdict word
  assert.doesNotMatch(out, /plumbline: REWORK/);
});

test("renderPreflight: warnings render, and a passing shape still says pass", () => {
  const out = renderPreflight({
    pass: true,
    errors: [],
    warnings: ["step 'npm test' is skipped locally but ci-covered"],
  });
  assert.match(out, /Shape gate:\*\* pass/);
  assert.match(out, /⚠️ step 'npm test'/);
});
