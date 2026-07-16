import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderComment,
  countRounds,
  extractPriorCapsule,
  appendAttemptHistory,
} from "../github.js";
import type { GateResult, FailureCapsule, Verdict } from "../types.js";

function gate(final: Verdict, capsule?: FailureCapsule): GateResult {
  return {
    shape: { pass: true, errors: [], warnings: [] },
    final,
    reasons: [],
    review: {
      verdict: final,
      confidence: 0.9,
      validation_coverage_notes: "cov",
      mission_alignment_notes: "mis",
      risk_notes: "risk",
      failure_capsule: capsule,
    },
  };
}

// ── rendering: a REVIEW comment has zero 🤖 items ──────────────────────────

test("renderComment: a review carries only 🧑 items — zero 🤖", () => {
  const md = renderComment(
    gate("review", {
      failing_check: "fc",
      suspected_cause: "sc",
      next_action_requested: "na",
      agent_actions: [],
      human_actions: ["decide the trade-off"],
      advisory: [],
      changed_files_implicated: [],
      severity: "review",
    }),
  );
  assert.match(md, /🧑 Human must decide/);
  assert.doesNotMatch(md, /🤖 Agent can do now/);
});

test("renderComment: a rework carries only 🤖 items — zero 🧑", () => {
  const md = renderComment(
    gate("rework", {
      failing_check: "fc",
      suspected_cause: "sc",
      next_action_requested: "na",
      agent_actions: ["fix the bug"],
      human_actions: [],
      advisory: [],
      changed_files_implicated: [],
      severity: "fixable",
    }),
  );
  assert.match(md, /🤖 Agent can do now/);
  assert.doesNotMatch(md, /🧑 Human must decide/);
});

test("renderComment: optional follow-ups render in their own non-blocking section (#56)", () => {
  const md = renderComment(
    gate("rework", {
      failing_check: "fc",
      suspected_cause: "sc",
      next_action_requested: "na",
      agent_actions: ["fix the bug"],
      human_actions: [],
      follow_ups: ["consider renaming foo"],
      changed_files_implicated: [],
      severity: "fixable",
    }),
  );
  assert.match(md, /💡 Optional follow-ups — non-blocking \(auto-filed as tracked issues\)/);
  assert.match(md, /consider renaming foo/);
});

test("renderComment: legacy `advisory` field still renders (back-compat)", () => {
  const md = renderComment(
    gate("rework", {
      failing_check: "fc",
      suspected_cause: "sc",
      next_action_requested: "na",
      agent_actions: ["fix the bug"],
      human_actions: [],
      advisory: ["consider renaming foo"],
      changed_files_implicated: [],
      severity: "fixable",
    }),
  );
  assert.match(md, /consider renaming foo/);
});

test("renderComment: did_not_converge shows the human-decides banner", () => {
  const md = renderComment(
    gate("review", {
      failing_check: "fc",
      suspected_cause: "sc",
      next_action_requested: "na",
      agent_actions: [],
      human_actions: ["decide"],
      advisory: [],
      changed_files_implicated: [],
      severity: "review",
      did_not_converge: true,
    }),
  );
  assert.match(md, /did not converge/i);
});

// ── round counting ─────────────────────────────────────────────────────────

test("countRounds: no prior comment ⇒ round 1", () => {
  assert.equal(countRounds(undefined), 1);
});

test("countRounds: a comment with no archived history ⇒ round 2", () => {
  const first = renderComment(gate("rework", {
    failing_check: "fc", suspected_cause: "sc", next_action_requested: "na",
    agent_actions: ["x"], human_actions: [], advisory: [], changed_files_implicated: [], severity: "fixable",
  }));
  assert.equal(countRounds(first), 2);
});

test("countRounds: increments with each archived attempt", () => {
  const cap = (n: string): FailureCapsule => ({
    failing_check: n, suspected_cause: "sc", next_action_requested: "na",
    agent_actions: ["x"], human_actions: [], advisory: [], changed_files_implicated: [], severity: "fixable",
  });
  const a1 = renderComment(gate("rework", cap("one")));
  const a2 = renderComment(gate("rework", cap("two")));
  const merged = appendAttemptHistory(a2, a1);
  // one archived attempt + current + this run = 3
  assert.equal(countRounds(merged), 3);
});

// ── prior-capsule extraction (round-trips through the rendered comment) ────

test("extractPriorCapsule: recovers the capsule from the rendered comment", () => {
  const capsule: FailureCapsule = {
    failing_check: "missing test",
    suspected_cause: "the new branch is untested",
    next_action_requested: "add a test",
    agent_actions: ["add a test for parseFoo"],
    human_actions: [],
    advisory: ["consider a helper"],
    changed_files_implicated: ["src/foo.ts"],
    severity: "fixable",
  };
  const md = renderComment(gate("rework", capsule));
  const got = extractPriorCapsule(md);
  assert.ok(got);
  assert.deepEqual(got?.agent_actions, ["add a test for parseFoo"]);
  assert.equal(got?.failing_check, "missing test");
});

test("extractPriorCapsule: prefers the CURRENT section over archived history", () => {
  const cur: FailureCapsule = {
    failing_check: "current-round", suspected_cause: "sc", next_action_requested: "na",
    agent_actions: ["current item"], human_actions: [], advisory: [], changed_files_implicated: [], severity: "fixable",
  };
  const old: FailureCapsule = {
    failing_check: "old-round", suspected_cause: "sc", next_action_requested: "na",
    agent_actions: ["old item"], human_actions: [], advisory: [], changed_files_implicated: [], severity: "fixable",
  };
  const merged = appendAttemptHistory(renderComment(gate("rework", cur)), renderComment(gate("rework", old)));
  const got = extractPriorCapsule(merged);
  assert.equal(got?.failing_check, "current-round");
});

test("extractPriorCapsule: no capsule (approve) ⇒ undefined", () => {
  const md = renderComment(gate("approve"));
  assert.equal(extractPriorCapsule(md), undefined);
});
