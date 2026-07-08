import { test } from "node:test";
import assert from "node:assert/strict";
import {
  selectVerdict,
  partitionFindings,
  applyConvergenceCap,
  normalizeFindings,
  buildReviewPrompt,
  buildDeltaSection,
  semanticReview,
} from "../review.js";
import { PolicySchema, type Policy, type Receipt, type ReviewFinding } from "../types.js";
import type { ReviewProvider } from "../provider.js";

function pol(overrides: Record<string, unknown> = {}): Policy {
  return PolicySchema.parse({ version: "1.0", ...overrides });
}

function rcpt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    receipt_version: "1.0",
    task_id: "T-1",
    agent_id: "a",
    intent: "x".repeat(41),
    self_modifying: false,
    policy_refs: [".plumbline/MISSION.md"],
    validation_plan: [{ command: "npm test", reason: "r", required: true }],
    execution_evidence: [{ command: "npm test", status: "passed" }],
    changed_files: ["src/foo.ts"],
    diff_sha256: "a".repeat(64),
    result_summary: "y".repeat(41),
    ...overrides,
  } as Receipt;
}

const F = {
  agentBlock: { description: "fix the bug", class: "blocking", actor: "agent" } as ReviewFinding,
  humanBlock: { description: "decide the trade-off", class: "blocking", actor: "human" } as ReviewFinding,
  agentAdvice: { description: "consider renaming", class: "advisory", actor: "agent" } as ReviewFinding,
  humanAdvice: { description: "maybe revisit later", class: "advisory", actor: "human" } as ReviewFinding,
  regression: { description: "fix broke X", class: "blocking", actor: "agent", regression: true } as ReviewFinding,
};

// ── Change 1: turn-based verdict selection ─────────────────────────────────

test("selectVerdict: any blocking+agent finding ⇒ rework (agent's turn)", () => {
  assert.equal(selectVerdict([F.agentBlock], { protectedFloor: false }), "rework");
});

test("selectVerdict: blocking+agent ⇒ REWORK even on a protected/self_modifying path", () => {
  // The floor forbids auto-APPROVE — it must NOT skip the agent-iteration phase.
  assert.equal(selectVerdict([F.agentBlock], { protectedFloor: true }), "rework");
  // Even mixed with human blockers, an agent blocker still means the agent's turn.
  assert.equal(
    selectVerdict([F.agentBlock, F.humanBlock], { protectedFloor: true }),
    "rework",
  );
});

test("selectVerdict: no agent-blocking, a human-blocking ⇒ review (human's turn)", () => {
  assert.equal(selectVerdict([F.humanBlock], { protectedFloor: false }), "review");
});

test("selectVerdict: empty blocking set + protected floor ⇒ review (floor forbids approve)", () => {
  assert.equal(selectVerdict([], { protectedFloor: true }), "review");
  // advisory-only + floor is still review (advisory never gates, floor holds).
  assert.equal(
    selectVerdict([F.agentAdvice, F.humanAdvice], { protectedFloor: true }),
    "review",
  );
});

test("selectVerdict: empty blocking set, no floor ⇒ approve", () => {
  assert.equal(selectVerdict([], { protectedFloor: false }), "approve");
  assert.equal(
    selectVerdict([F.agentAdvice, F.humanAdvice], { protectedFloor: false }),
    "approve",
  );
});

// ── Change 2: advisory partitioning (advisory never blocks) ────────────────

test("partitionFindings: advisory items go to the advisory list, never to actions", () => {
  const p = partitionFindings([F.agentBlock, F.humanBlock, F.agentAdvice, F.humanAdvice]);
  assert.deepEqual(p.agentActions, ["fix the bug"]);
  assert.deepEqual(p.humanActions, ["decide the trade-off"]);
  assert.deepEqual(p.advisory, ["consider renaming", "maybe revisit later"]);
});

test("advisory-only findings never affect the verdict", () => {
  assert.equal(selectVerdict([F.agentAdvice], { protectedFloor: false }), "approve");
  assert.equal(selectVerdict([F.humanAdvice], { protectedFloor: false }), "approve");
});

// ── normalization + backward compat ────────────────────────────────────────

test("normalizeFindings: reads the new findings array", () => {
  const out = normalizeFindings({
    failing_check: "x",
    suspected_cause: "y",
    next_action_requested: "z",
    findings: [F.agentBlock, F.agentAdvice],
    changed_files_implicated: [],
    severity: "review",
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].class, "blocking");
  assert.equal(out[1].class, "advisory");
});

test("normalizeFindings: legacy agent_actions/human_actions ⇒ blocking findings", () => {
  const out = normalizeFindings({
    failing_check: "x",
    suspected_cause: "y",
    next_action_requested: "z",
    agent_actions: ["do a"],
    human_actions: ["decide b"],
    changed_files_implicated: [],
    severity: "review",
  });
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((f) => ({ description: f.description, class: f.class, actor: f.actor })),
    [
      { description: "do a", class: "blocking", actor: "agent" },
      { description: "decide b", class: "blocking", actor: "human" },
    ],
  );
});

test("normalizeFindings: undefined capsule ⇒ [] (clean pass)", () => {
  assert.deepEqual(normalizeFindings(undefined), []);
});

// ── Change 3: convergence cap ──────────────────────────────────────────────

test("applyConvergenceCap: below the cap, findings pass through unchanged", () => {
  const r = applyConvergenceCap([F.agentBlock], 2);
  assert.equal(r.capped, false);
  assert.deepEqual(r.findings, [F.agentBlock]);
});

test("applyConvergenceCap: at round 3, a non-regression agent blocker escalates to human", () => {
  const r = applyConvergenceCap([F.agentBlock], 3);
  assert.equal(r.capped, true);
  assert.equal(r.findings[0].actor, "human");
  assert.equal(r.findings[0].class, "blocking");
  // ⇒ the verdict becomes review, not another rework round.
  assert.equal(selectVerdict(r.findings, { protectedFloor: false }), "review");
});

test("applyConvergenceCap: at round 3, a REGRESSION agent blocker still blocks (rework)", () => {
  const r = applyConvergenceCap([F.regression], 3);
  assert.equal(r.capped, false);
  assert.equal(r.findings[0].actor, "agent");
  assert.equal(selectVerdict(r.findings, { protectedFloor: false }), "rework");
});

test("applyConvergenceCap: mixed regression + nit at cap — regression blocks, nit escalates", () => {
  const r = applyConvergenceCap([F.regression, F.agentBlock], 3);
  assert.equal(r.capped, true);
  // regression stays agent (blocks), the other became human.
  assert.equal(r.findings[0].actor, "agent");
  assert.equal(r.findings[1].actor, "human");
  // an agent regression still present ⇒ rework.
  assert.equal(selectVerdict(r.findings, { protectedFloor: false }), "rework");
});

// ── delta-prompt construction ──────────────────────────────────────────────

test("buildDeltaSection: includes prior blocking items + fix commits + narrow contract", () => {
  const s = buildDeltaSection({
    round: 2,
    priorCapsule: {
      failing_check: "x",
      suspected_cause: "y",
      next_action_requested: "z",
      agent_actions: ["add a test for parseFoo"],
      human_actions: [],
      changed_files_implicated: [],
      severity: "fixable",
    },
    fixCommits: ["abc123 add test", "def456 tidy"],
  });
  assert.match(s, /delta_review_contract round="2"/);
  assert.match(s, /add a test for parseFoo/);
  assert.match(s, /abc123 add test/);
  assert.match(s, /MUST NOT raise NEW findings/);
  assert.doesNotMatch(s, /CONVERGENCE CAP/); // round 2 is below the cap
});

test("buildDeltaSection: at round 3 includes the convergence-cap instruction", () => {
  const s = buildDeltaSection({
    round: 3,
    priorCapsule: {
      failing_check: "x",
      suspected_cause: "y",
      next_action_requested: "z",
      changed_files_implicated: [],
      severity: "fixable",
    },
  });
  assert.match(s, /CONVERGENCE CAP/);
  assert.match(s, /Only true regressions/);
});

test("buildReviewPrompt: no delta section on a first review (no context)", () => {
  const p = buildReviewPrompt("mission", rcpt(), "diff", "balanced");
  assert.doesNotMatch(p, /delta_review_contract/);
  assert.match(p, /Report every issue as a FINDING/);
});

test("buildReviewPrompt: includes the delta contract when a prior capsule is passed", () => {
  const p = buildReviewPrompt("mission", rcpt(), "diff", "balanced", {
    round: 2,
    priorCapsule: {
      failing_check: "x",
      suspected_cause: "y",
      next_action_requested: "z",
      agent_actions: ["fix parse"],
      changed_files_implicated: [],
      severity: "fixable",
    },
  });
  assert.match(p, /delta_review_contract/);
  assert.match(p, /fix parse/);
});

// ── end-to-end via semanticReview (verdict derived, not trusted) ───────────

function fakeProvider(json: string): ReviewProvider {
  return { id: "anthropic", async complete() { return json; } };
}

const findingsJson = (findings: ReviewFinding[], modelVerdict = "approve") =>
  JSON.stringify({
    verdict: modelVerdict,
    confidence: 0.95,
    validation_coverage_notes: "a",
    mission_alignment_notes: "b",
    risk_notes: "c",
    failure_capsule: {
      failing_check: "fc",
      suspected_cause: "sc",
      next_action_requested: "na",
      findings,
      changed_files_implicated: [],
      severity: "fixable",
    },
  });

test("semanticReview: agent-blocking on a protected path ⇒ rework (not review)", async () => {
  const r = await semanticReview(
    "m",
    rcpt({ self_modifying: true }),
    "diff",
    pol(),
    // model wrongly guesses "review"; the gate must recompute to rework.
    fakeProvider(findingsJson([F.agentBlock], "review")),
  );
  assert.equal(r.verdict, "rework");
  assert.deepEqual(r.failure_capsule?.human_actions, []);
});

test("semanticReview: a REVIEW carries ZERO agent (🤖) items", async () => {
  const r = await semanticReview(
    "m",
    rcpt({ self_modifying: true }),
    "diff",
    pol(),
    fakeProvider(findingsJson([F.humanBlock, F.agentAdvice])),
  );
  assert.equal(r.verdict, "review");
  assert.deepEqual(r.failure_capsule?.agent_actions, []);
  assert.deepEqual(r.failure_capsule?.human_actions, ["decide the trade-off"]);
  // advisory recorded, never in the action lists.
  assert.deepEqual(r.failure_capsule?.advisory, ["consider renaming"]);
});

test("semanticReview: advisory-only ⇒ approve (advisory never blocks)", async () => {
  const r = await semanticReview(
    "m",
    rcpt(),
    "diff",
    pol(),
    fakeProvider(findingsJson([F.agentAdvice, F.humanAdvice], "rework")),
  );
  assert.equal(r.verdict, "approve");
  assert.equal(r.failure_capsule?.advisory?.length, 2);
});

test("semanticReview: clean pass (no findings) ⇒ approve, no capsule", async () => {
  const r = await semanticReview("m", rcpt(), "diff", pol(), fakeProvider(findingsJson([])));
  assert.equal(r.verdict, "approve");
  assert.equal(r.failure_capsule, undefined);
});

test("semanticReview: convergence cap at round 3 escalates a non-regression nit to review", async () => {
  const r = await semanticReview(
    "m",
    rcpt(),
    "diff",
    pol(),
    fakeProvider(findingsJson([F.agentBlock])),
    { round: 3, priorCapsule: { failing_check: "x", suspected_cause: "y", next_action_requested: "z", changed_files_implicated: [], severity: "fixable" } },
  );
  assert.equal(r.verdict, "review");
  assert.equal(r.failure_capsule?.did_not_converge, true);
});

test("semanticReview: regression at round 3 still reworks", async () => {
  const r = await semanticReview(
    "m",
    rcpt(),
    "diff",
    pol(),
    fakeProvider(findingsJson([F.regression])),
    { round: 3, priorCapsule: { failing_check: "x", suspected_cause: "y", next_action_requested: "z", changed_files_implicated: [], severity: "fixable" } },
  );
  assert.equal(r.verdict, "rework");
});
