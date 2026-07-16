import { test } from "node:test";
import assert from "node:assert/strict";
import {
  selectVerdict,
  partitionFindings,
  findingMateriality,
  normalizeFindings,
} from "../review.js";
import { followUpFingerprint } from "../github.js";
import type { ReviewFinding, FailureCapsule } from "../types.js";

// #56: verdict CLASSIFICATION. Any material, agent-fixable finding ⇒ REWORK
// (even on a protected surface); REVIEW is human-only with NO agent-fixable
// items outstanding; optional-but-good ⇒ tracked follow-up (never lost); noise
// ⇒ dropped.

const F = (over: Partial<ReviewFinding>): ReviewFinding => ({
  description: over.description ?? "x",
  class: over.class ?? "blocking",
  actor: over.actor ?? "agent",
  materiality: over.materiality,
  regression: over.regression,
});

// ── routing: agent-fixable always beats REVIEW, even on protected surface ──

test("#56: a blocking+agent finding ⇒ REWORK even with the protected floor set", () => {
  const v = selectVerdict([F({ class: "blocking", actor: "agent" })], { protectedFloor: true });
  assert.equal(v, "rework", "agent-fixable defect on a protected surface must REWORK first, not skip to REVIEW");
});

test("#56: sequential — agent-fixable + human finding together ⇒ REWORK (human waits)", () => {
  const v = selectVerdict(
    [F({ class: "blocking", actor: "agent" }), F({ class: "blocking", actor: "human" })],
    { protectedFloor: false },
  );
  assert.equal(v, "rework", "cannot reach human-REVIEW while an agent-fixable finding remains");
});

test("#56: REVIEW only once no agent-fixable findings remain (protected floor alone)", () => {
  assert.equal(selectVerdict([], { protectedFloor: true }), "review");
  assert.equal(selectVerdict([F({ class: "blocking", actor: "human" })], { protectedFloor: false }), "review");
});

test("#56: no blocking findings + no floor ⇒ PASS (advisories never gate)", () => {
  const v = selectVerdict(
    [F({ class: "advisory", actor: "agent", materiality: "optional" }), F({ class: "advisory", materiality: "noise" })],
    { protectedFloor: false },
  );
  assert.equal(v, "approve");
});

// ── materiality: 3-way bucket ──────────────────────────────────────────────

test("#56 findingMateriality: blocking is always material; advisory defaults to optional; noise honored", () => {
  assert.equal(findingMateriality(F({ class: "blocking" })), "material");
  assert.equal(findingMateriality(F({ class: "blocking", materiality: "noise" })), "material", "a blocking finding is material regardless of tag");
  assert.equal(findingMateriality(F({ class: "advisory" })), "optional", "an untagged advisory is captured, not lost");
  assert.equal(findingMateriality(F({ class: "advisory", materiality: "optional" })), "optional");
  assert.equal(findingMateriality(F({ class: "advisory", materiality: "noise" })), "noise");
});

test("#56 partition: optional advisories ⇒ follow-ups; noise ⇒ dropped; blocking ⇒ action lists", () => {
  const p = partitionFindings([
    F({ description: "fix the bug", class: "blocking", actor: "agent" }),
    F({ description: "approve the migration", class: "blocking", actor: "human" }),
    F({ description: "consider extracting a helper", class: "advisory", materiality: "optional" }),
    F({ description: "you could rename x", class: "advisory", materiality: "noise" }),
    F({ description: "untagged advisory", class: "advisory" }),
  ]);
  assert.deepEqual(p.agentActions, ["fix the bug"]);
  assert.deepEqual(p.humanActions, ["approve the migration"]);
  // optional + untagged-advisory captured as follow-ups; noise dropped.
  assert.deepEqual(p.followUps, ["consider extracting a helper", "untagged advisory"]);
  assert.ok(!p.followUps.includes("you could rename x"), "noise must be dropped, not filed");
  // advisory is the back-compat alias of followUps.
  assert.deepEqual(p.advisory, p.followUps);
});

// ── normalizeFindings carries materiality through ──────────────────────────

test("#56 normalizeFindings: preserves the materiality tag from the model", () => {
  const capsule: FailureCapsule = {
    failing_check: "fc",
    suspected_cause: "sc",
    next_action_requested: "na",
    changed_files_implicated: [],
    severity: "review",
    findings: [
      { description: "a", class: "advisory", actor: "agent", materiality: "optional" } as ReviewFinding,
      { description: "b", class: "advisory", actor: "agent", materiality: "noise" } as ReviewFinding,
      { description: "c", class: "blocking", actor: "agent" } as ReviewFinding,
    ],
  };
  const out = normalizeFindings(capsule);
  assert.equal(out[0].materiality, "optional");
  assert.equal(out[1].materiality, "noise");
  assert.equal(out[2].materiality, undefined, "blocking findings need no explicit tag");
});

// ── follow-up fingerprint is stable + dedup-friendly ───────────────────────

test("#56 followUpFingerprint: stable for same (pr, description), differs otherwise", () => {
  const a = followUpFingerprint(211, "consider extracting a helper");
  const b = followUpFingerprint(211, "consider extracting a helper");
  const c = followUpFingerprint(212, "consider extracting a helper");
  const d = followUpFingerprint(211, "a different suggestion");
  assert.equal(a, b, "same inputs ⇒ same fingerprint (dedup works across re-runs)");
  assert.notEqual(a, c);
  assert.notEqual(a, d);
  assert.match(a, /^[0-9a-f]{16}$/);
});
