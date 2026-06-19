import { test } from "node:test";
import assert from "node:assert/strict";
import { renderComment, renderCiSummary } from "../github.js";
import type { GateResult } from "../types.js";

function escalateResult(opts: { agent: string[]; human: string[] }): GateResult {
  return {
    shape: { pass: true, errors: [], warnings: [] },
    review: {
      verdict: "escalate",
      confidence: 0.9,
      validation_coverage_notes: "ok",
      mission_alignment_notes: "ok",
      risk_notes: "ok",
      failure_capsule: {
        failing_check: "Protected surface + a fixable security item",
        suspected_cause: "Touches a migration and also lacks input escaping.",
        next_action_requested: "see lists",
        agent_actions: opts.agent,
        human_actions: opts.human,
        changed_files_implicated: ["db/migrate/x.rb"],
        severity: "escalation",
      },
    },
    final: "escalate",
    reasons: [],
  };
}

test("escalate WITH agent_actions: shows both lists, no 'nothing for the agent' claim", () => {
  const md = renderComment(
    escalateResult({ agent: ["Escape user input in the attribute"], human: ["Approve the migration"] }),
  );
  assert.ok(md.includes("🧑 Human must decide"));
  assert.ok(md.includes("Approve the migration"));
  assert.ok(md.includes("🤖 Agent can do now"));
  assert.ok(md.includes("Escape user input in the attribute"));
  assert.ok(md.includes("agent-fixable items too"));
  assert.ok(!md.includes("nothing for the agent to fix"));
});

test("escalate with NO agent_actions: human-approval banner still flags findings to read", () => {
  const md = renderComment(escalateResult({ agent: [], human: ["Override-merge the protected change"] }));
  assert.ok(md.includes("Human approval required"));
  assert.ok(md.includes("no agent rework needed"));
  // The whole point of this change: escalate must NOT read as a rubber stamp —
  // it must point the human at the substantive findings.
  assert.ok(md.includes("NOT a rubber stamp"));
  assert.ok(md.includes("Review findings below"));
  assert.ok(md.includes("🧑 Human must decide"));
  assert.ok(!md.includes("🤖 Agent can do now"));
});

test("findings-at-a-glance: counts numbered risks for a non-approve verdict", () => {
  const r = escalateResult({ agent: [], human: ["approve"] });
  r.review!.risk_notes = "1) leak risk. 2) timezone bug. 3) missing FK.";
  const md = renderComment(r);
  assert.ok(md.includes("3 risk findings"));
  assert.ok(md.includes("Review findings below"));
});

test("renderCiSummary: escalate is a warning annotation that says read the findings", () => {
  const s = renderCiSummary(escalateResult({ agent: [], human: ["approve"] }));
  assert.equal(s.level, "warning");
  assert.ok(s.title.includes("ESCALATE"));
  assert.ok(/rubber stamp|read the/i.test(s.message));
});

test("renderCiSummary: revise is an error annotation; approve is a notice", () => {
  const revise: GateResult = {
    shape: { pass: true, errors: [], warnings: [] },
    review: {
      verdict: "revise", confidence: 0.8,
      validation_coverage_notes: "ok", mission_alignment_notes: "ok", risk_notes: "ok",
      failure_capsule: {
        failing_check: "missing spec", suspected_cause: "no test",
        next_action_requested: "add a spec", agent_actions: ["add a spec"], human_actions: [],
        changed_files_implicated: [], severity: "fixable",
      },
    },
    final: "revise", reasons: [],
  };
  assert.equal(renderCiSummary(revise).level, "error");

  const approve: GateResult = {
    shape: { pass: true, errors: [], warnings: [] },
    review: undefined,
    final: "approve", reasons: [],
  };
  const a = renderCiSummary(approve);
  assert.equal(a.level, "notice");
  assert.ok(a.title.includes("APPROVE"));
});
