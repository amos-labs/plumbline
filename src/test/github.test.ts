import { test } from "node:test";
import assert from "node:assert/strict";
import { renderComment, renderCiSummary, isOwnGateRun } from "../github.js";
import type { GateResult } from "../types.js";

// --- poll-wait self-detection (#6) — mirrors templates/workflow.yml ---

const RUN_ID = "12345";

test("isOwnGateRun: matches by run id in details_url (survives a job rename)", () => {
  assert.equal(
    isOwnGateRun(
      { name: "some-renamed-job", details_url: `https://github.com/o/r/actions/runs/${RUN_ID}/job/99` },
      RUN_ID,
    ),
    true,
  );
});

test("isOwnGateRun: a 'plumbline'-named check from a DIFFERENT run is NOT self (no deadlock)", () => {
  assert.equal(
    isOwnGateRun(
      { name: "plumbline-extra", details_url: `https://github.com/o/r/actions/runs/99999/job/1` },
      RUN_ID,
    ),
    false,
  );
});

test("isOwnGateRun: an unrelated CI check is not self", () => {
  assert.equal(
    isOwnGateRun({ name: "test", details_url: `https://github.com/o/r/actions/runs/77/job/2` }, RUN_ID),
    false,
  );
});

test("isOwnGateRun: name fallback ONLY when there is no url to key on", () => {
  assert.equal(isOwnGateRun({ name: "plumbline", details_url: null, html_url: null }, RUN_ID), true);
  assert.equal(isOwnGateRun({ name: "gate", details_url: null }, RUN_ID), true);
  assert.equal(isOwnGateRun({ name: "test" }, RUN_ID), false);
  // With a url present, the bare-name fallback is NOT used (avoids false self).
  assert.equal(
    isOwnGateRun({ name: "plumbline", details_url: `https://github.com/o/r/actions/runs/88/job/3` }, RUN_ID),
    false,
  );
});

function reviewResult(opts: { agent: string[]; human: string[] }): GateResult {
  return {
    shape: { pass: true, errors: [], warnings: [] },
    review: {
      verdict: "review",
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
        severity: "review",
      },
    },
    final: "review",
    reasons: [],
  };
}

test("review is the human's turn only (#41): human items render, banner is human-decides", () => {
  // Under turn-based verdicts a REVIEW is emitted only when the agent set is
  // empty — a review comment is a pure human decision list. (Any agent-fixable
  // defect would have made the verdict REWORK instead.)
  const md = renderComment(reviewResult({ agent: [], human: ["Approve the migration"] }));
  assert.ok(md.includes("🧑 Human must decide"));
  assert.ok(md.includes("Approve the migration"));
  assert.ok(!md.includes("🤖 Agent can do now"));
  assert.ok(md.includes("Human approval required"));
});

test("review with NO agent_actions: human-approval banner still flags findings to read", () => {
  const md = renderComment(reviewResult({ agent: [], human: ["Override-merge the protected change"] }));
  assert.ok(md.includes("Human approval required"));
  assert.ok(md.includes("no agent rework needed"));
  // The whole point of this change: review must NOT read as a rubber stamp —
  // it must point the human at the substantive findings.
  assert.ok(md.includes("NOT a rubber stamp"));
  assert.ok(md.includes("Review findings below"));
  assert.ok(md.includes("🧑 Human must decide"));
  assert.ok(!md.includes("🤖 Agent can do now"));
});

test("findings-at-a-glance: counts numbered risks for a non-approve verdict", () => {
  const r = reviewResult({ agent: [], human: ["approve"] });
  r.review!.risk_notes = "1) leak risk. 2) timezone bug. 3) missing FK.";
  const md = renderComment(r);
  assert.ok(md.includes("3 risk findings"));
  assert.ok(md.includes("Review findings below"));
});

test("renderCiSummary: review is a warning annotation that says read the findings", () => {
  const s = renderCiSummary(reviewResult({ agent: [], human: ["approve"] }));
  assert.equal(s.level, "warning");
  assert.ok(s.title.includes("REVIEW"));
  assert.ok(/rubber stamp|read the/i.test(s.message));
});

test("renderCiSummary: rework is an error annotation; approve is a notice", () => {
  const rework: GateResult = {
    shape: { pass: true, errors: [], warnings: [] },
    review: {
      verdict: "rework", confidence: 0.8,
      validation_coverage_notes: "ok", mission_alignment_notes: "ok", risk_notes: "ok",
      failure_capsule: {
        failing_check: "missing spec", suspected_cause: "no test",
        next_action_requested: "add a spec", agent_actions: ["add a spec"], human_actions: [],
        changed_files_implicated: [], severity: "fixable",
      },
    },
    final: "rework", reasons: [],
  };
  assert.equal(renderCiSummary(rework).level, "error");

  const approve: GateResult = {
    shape: { pass: true, errors: [], warnings: [] },
    review: undefined,
    final: "approve", reasons: [],
  };
  const a = renderCiSummary(approve);
  assert.equal(a.level, "notice");
  // #54: the PASS state is titled "Plumbline: PASS" (distinct, verdict-legible).
  assert.ok(a.title.includes("PASS"));
});
