import { test } from "node:test";
import assert from "node:assert/strict";
import { renderComment } from "../github.js";
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

test("escalate with NO agent_actions: pure human-approval banner", () => {
  const md = renderComment(escalateResult({ agent: [], human: ["Override-merge the protected change"] }));
  assert.ok(md.includes("nothing for the agent to fix"));
  assert.ok(md.includes("🧑 Human must decide"));
  assert.ok(!md.includes("🤖 Agent can do now"));
});
