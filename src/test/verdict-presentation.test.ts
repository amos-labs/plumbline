import { test } from "node:test";
import assert from "node:assert/strict";
import { verdictPresentation } from "../verdict.js";
import { renderComment, renderCiSummary } from "../github.js";
import type { GateResult } from "../types.js";

// #54: PASS / REWORK / REVIEW must be UNMISTAKABLY distinct end-to-end. These
// tests pin the verdict → (check-run name, conclusion, comment title,
// annotation) mapping so the three states can never collapse into one identical
// red "failure" again (the amos-platform#211 accident: a REWORK merged as if it
// were a REVIEW).

// ── the single presentation table ─────────────────────────────────────────

test("verdictPresentation: three DISTINCT check-run names", () => {
  const names = (["approve", "rework", "review"] as const).map((v) => verdictPresentation(v).checkName);
  assert.equal(new Set(names).size, 3, `check names must be distinct, got ${JSON.stringify(names)}`);
  assert.match(verdictPresentation("approve").checkName, /PASS/);
  assert.match(verdictPresentation("rework").checkName, /REWORK/);
  assert.match(verdictPresentation("review").checkName, /REVIEW/);
});

test("verdictPresentation: distinct GitHub check conclusions — rework=failure, review=action_required, approve=success", () => {
  assert.equal(verdictPresentation("approve").conclusion, "success");
  assert.equal(verdictPresentation("rework").conclusion, "failure");
  // The key #54 distinction: REVIEW is action_required (needs a human), NOT a
  // plain failure — so it reads differently from a REWORK in the GitHub UI.
  assert.equal(verdictPresentation("review").conclusion, "action_required");
  assert.notEqual(
    verdictPresentation("rework").conclusion,
    verdictPresentation("review").conclusion,
    "REWORK and REVIEW must NOT share a conclusion",
  );
});

test("verdictPresentation: only PASS is ordinarily mergeable", () => {
  assert.equal(verdictPresentation("approve").mergeable, true);
  assert.equal(verdictPresentation("rework").mergeable, false);
  assert.equal(verdictPresentation("review").mergeable, false);
});

test("verdictPresentation: comment titles scream the verdict + are distinct", () => {
  const titles = (["approve", "rework", "review"] as const).map((v) => verdictPresentation(v).commentTitle);
  assert.equal(new Set(titles).size, 3);
  assert.match(verdictPresentation("rework").commentTitle, /do NOT merge/i);
  assert.match(verdictPresentation("review").commentTitle, /human approval/i);
});

// ── the mapping is actually WIRED into the rendered surfaces ────────────────

function gate(final: GateResult["final"]): GateResult {
  return {
    shape: { pass: final !== "rework", errors: [], warnings: [] },
    review:
      final === "approve"
        ? undefined
        : {
            verdict: final,
            confidence: 0.9,
            validation_coverage_notes: "ok",
            mission_alignment_notes: "ok",
            risk_notes: "1) a risk.",
            failure_capsule: {
              failing_check: "fc",
              suspected_cause: "sc",
              next_action_requested: "na",
              agent_actions: final === "rework" ? ["fix the thing"] : [],
              human_actions: final === "review" ? ["approve the thing"] : [],
              advisory: [],
              changed_files_implicated: [],
              severity: final === "rework" ? "fixable" : "review",
            },
          },
    final,
    reasons: [],
  };
}

test("renderComment: each verdict's H2 title comes from the presentation table", () => {
  assert.ok(renderComment(gate("approve")).startsWith(`## ${verdictPresentation("approve").commentTitle}`));
  assert.ok(renderComment(gate("rework")).startsWith(`## ${verdictPresentation("rework").commentTitle}`));
  assert.ok(renderComment(gate("review")).startsWith(`## ${verdictPresentation("review").commentTitle}`));
});

test("renderComment: REWORK and REVIEW headers are never the same string", () => {
  const reworkHead = renderComment(gate("rework")).split("\n")[0];
  const reviewHead = renderComment(gate("review")).split("\n")[0];
  assert.notEqual(reworkHead, reviewHead);
  assert.match(reworkHead, /REWORK/);
  assert.match(reviewHead, /REVIEW/);
});

test("renderCiSummary: annotation level + title track the verdict distinctly", () => {
  assert.equal(renderCiSummary(gate("approve")).level, "notice");
  assert.equal(renderCiSummary(gate("rework")).level, "error");
  assert.equal(renderCiSummary(gate("review")).level, "warning");

  assert.match(renderCiSummary(gate("rework")).title, /REWORK/);
  assert.match(renderCiSummary(gate("review")).title, /REVIEW/);
  // rework and review annotations must not be interchangeable.
  assert.notEqual(renderCiSummary(gate("rework")).level, renderCiSummary(gate("review")).level);
});
