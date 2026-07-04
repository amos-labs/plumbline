import { test } from "node:test";
import assert from "node:assert/strict";
import { appendAttemptHistory, HISTORY_CAP, renderComment } from "../github.js";
import type { GateResult } from "../types.js";

function gate(final: GateResult["final"], errors: string[] = []): GateResult {
  return {
    shape: { pass: errors.length === 0, errors, warnings: [] },
    final,
    reasons: [],
  };
}

const NOW = new Date("2026-07-04T12:00:00Z");

test("attempt history: first rerun archives the prior comment under a details block", () => {
  const first = renderComment(gate("revise", ["diff_sha256 mismatch: receipt=aa actual=bb"]));
  const second = renderComment(gate("approve"));
  const merged = appendAttemptHistory(second, first, NOW);

  // Current result on top, history below.
  assert.ok(merged.startsWith("## ✅ plumbline: APPROVE"));
  assert.ok(merged.includes("Attempt history (1)"));
  assert.ok(merged.includes("REVISE — superseded 2026-07-04 12:00 UTC"));
  // The prior attempt's content is preserved inside the history.
  assert.ok(merged.includes("diff_sha256 mismatch: receipt=aa actual=bb"));
});

test("attempt history: grows newest-first across reruns", () => {
  const a1 = renderComment(gate("revise", ["error one"]));
  const a2 = renderComment(gate("revise", ["error two"]));
  const a3 = renderComment(gate("approve"));

  const afterSecond = appendAttemptHistory(a2, a1, NOW);
  const afterThird = appendAttemptHistory(a3, afterSecond, NOW);

  assert.ok(afterThird.includes("Attempt history (2)"));
  // Newest archived attempt (error two) appears before the older one (error one).
  const idx2 = afterThird.indexOf("error two");
  const idx1 = afterThird.indexOf("error one");
  assert.ok(idx2 > 0 && idx1 > idx2, "newest-first ordering");
  // Current body isn't polluted by prior errors above the marker.
  const currentPart = afterThird.slice(0, afterThird.indexOf("<!-- plumbline:attempt-history -->"));
  assert.ok(!currentPart.includes("error one"));
});

test(`attempt history: capped at ${HISTORY_CAP}`, () => {
  let body = renderComment(gate("revise", ["error 0"]));
  for (let i = 1; i <= HISTORY_CAP + 3; i++) {
    body = appendAttemptHistory(renderComment(gate("revise", [`error ${i}`])), body, NOW);
  }
  assert.ok(body.includes(`Attempt history (${HISTORY_CAP})`));
  // The oldest attempts fell off.
  assert.ok(!body.includes("error 0"));
});

test("attempt history: truncation re-balances details tags", () => {
  const huge = renderComment(gate("revise", ["x".repeat(6000)]));
  // The prior body contains an open <details> pair via renderComment? Build one explicitly:
  const withDetails = `${huge}\n<details><summary>big</summary>\n${"y".repeat(3000)}\n</details>`;
  const merged = appendAttemptHistory(renderComment(gate("approve")), withDetails, NOW);
  const opens = (merged.match(/<details/g) ?? []).length;
  const closes = (merged.match(/<\/details>/g) ?? []).length;
  assert.equal(opens, closes, "details tags balanced after truncation");
  assert.ok(merged.includes("… (truncated)"));
});
