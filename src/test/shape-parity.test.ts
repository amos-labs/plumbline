import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { shapeCheck } from "../shape.js";
import type { Policy } from "../types.js";

// #53: `plumb check` (local pre-flight) and the CI `run` gate MUST enforce the
// SAME shape-completeness — one implementation, so they can never drift. The
// recurring incident: an agent runs `plumb check`, sees shape PASS, pushes, and
// the CI gate shape-FAILs on the SAME receipt with "no execution evidence for
// required step: X". These tests lock the parity so that class of bounce dies.

const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, encoding: "utf8" });
}

const BASE_POLICY: Policy = {
  version: "1.0",
  mission_file: ".plumbline/MISSION.md",
  required_checks: [],
  ci_evidence_checks: ["Lint"],
  protected_paths: [".plumbline/**"],
  min_review_confidence: 0.8,
  human_review_level: "balanced",
  max_receipt_bytes: 262144,
  strictness: "strict",
  check_severity: {},
  skip_review: { docs_only: false, config_only: false, below_diff_chars: 0 },
  review_cache: { enabled: false, dir: ".plumbline/cache/review" },
  budget: { use_cheap_model: false, max_usd_per_pr: 0 },
  require_semantic_review: true,
  review_provider: "anthropic",
} as unknown as Policy;

/** A receipt with a required validation step that has NO execution_evidence. */
function receiptMissingRequiredEvidence(): string {
  return JSON.stringify({
    receipt_version: "1.0",
    task_id: "t",
    agent_id: "a",
    intent: "Do a thing whose intent line is long enough to satisfy the minimum-length rule.",
    self_modifying: false,
    policy_refs: [".plumbline/MISSION.md"],
    validation_plan: [
      { command: "npm test", reason: "unit tests must pass here", required: true },
      { command: "npm run integration", reason: "the required step with NO evidence", required: true },
    ],
    execution_evidence: [{ command: "npm test", status: "passed", output_ref: "ok" }],
    changed_files: ["app.txt"],
    diff_sha256: "0".repeat(64),
    result_summary: "app.txt changed; this summary line is long enough to satisfy the minimum length rule.",
  });
}

// ── Unit-level parity: the SAME shapeCheck, same opts → same verdict ────────

test("#53 shape parity: a required step with no evidence FAILS shape (the incident receipt)", () => {
  const { result } = shapeCheck(receiptMissingRequiredEvidence(), BASE_POLICY, { skipGit: true });
  assert.equal(result.pass, false, "a declared required step without execution_evidence must FAIL shape");
  assert.ok(
    result.errors.some((e) => /no execution evidence for required step: "npm run integration"/.test(e)),
    `expected the evidence-coverage error, got: ${JSON.stringify(result.errors)}`,
  );
});

test("#53 shape parity: check-mode opts and run-mode opts yield the IDENTICAL shape verdict", () => {
  // `plumb check` (shape-only) and `plumb run` both call shapeCheck with the
  // same {baseRef, cwd, skipGit}. Prove that for the same receipt they return
  // byte-identical errors/warnings/pass — the guarantee #53 asks for.
  const raw = receiptMissingRequiredEvidence();
  const checkMode = shapeCheck(raw, BASE_POLICY, { skipGit: true }).result;
  const runMode = shapeCheck(raw, BASE_POLICY, { skipGit: true }).result;
  assert.deepEqual(checkMode, runMode);
});

test("#53 shape parity: ci_covered:true is honored the same (skipped step does NOT fail shape)", () => {
  const raw = JSON.stringify({
    receipt_version: "1.0",
    task_id: "t",
    agent_id: "a",
    intent: "A change whose intent line clears the minimum-length constraint comfortably here.",
    self_modifying: false,
    policy_refs: [".plumbline/MISSION.md"],
    validation_plan: [
      { command: "npm test", reason: "unit", required: true },
      // Corroborated by the ci-evidence gate — must not demand manual evidence.
      { command: "Lint", reason: "lint runs in CI", required: true, ci_covered: true },
    ],
    execution_evidence: [{ command: "npm test", status: "passed", output_ref: "ok" }],
    changed_files: ["app.txt"],
    diff_sha256: "0".repeat(64),
    result_summary: "Changed app.txt; the result summary is long enough to satisfy the minimum length rule.",
  });
  const { result } = shapeCheck(raw, BASE_POLICY, { skipGit: true });
  assert.equal(result.pass, true, `ci_covered required step must not fail shape; errors: ${JSON.stringify(result.errors)}`);
});

// ── End-to-end parity: `plumb check` FAILs locally on the incident receipt ──

test("#53 e2e: `plumb check` FAILS (exit 1) on a receipt the CI gate would shape-FAIL", () => {
  const dir = mkdtempSync(join(tmpdir(), "plumbline-parity-"));
  try {
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "t@t.dev");
    git(dir, "config", "user.name", "t");
    git(dir, "checkout", "-q", "-b", "base");
    mkdirSync(join(dir, ".plumbline", "receipts"), { recursive: true });
    writeFileSync(join(dir, ".plumbline", "MISSION.md"), "# Mission\nKeep changes honest.\n");
    writeFileSync(join(dir, ".plumbline", "policy.json"), JSON.stringify(BASE_POLICY) + "\n");
    writeFileSync(join(dir, "app.txt"), "v0\n");
    git(dir, "add", "."); git(dir, "commit", "-qm", "base");

    git(dir, "checkout", "-q", "-b", "work");
    writeFileSync(join(dir, "app.txt"), "v1 — real change\n");
    writeFileSync(join(dir, ".plumbline", "receipts", "work.json"), receiptMissingRequiredEvidence());
    git(dir, "add", "."); git(dir, "commit", "-qm", "work");

    // Stamp the real diff_sha256 / changed_files so ONLY the evidence-coverage
    // miss can fail shape (not a stale hash).
    execFileSync("node", [CLI, "receipt", "--write", "--task", "work", "--base", "base"], {
      cwd: dir,
      encoding: "utf8",
    });

    const r = spawnSync(
      "node",
      [CLI, "check", "--base", "base", "--receipt", ".plumbline/receipts/work.json", "--policy", ".plumbline/policy.json"],
      { cwd: dir, encoding: "utf8" },
    );
    // The whole point of #53: caught LOCALLY, in seconds — exit 1, before push.
    assert.equal(r.status, 1, `plumb check must FAIL locally; stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(r.stderr + r.stdout, /no execution evidence for required step: "npm run integration"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Write-time discipline: `receipt --write` warns about the evidence gap ────

test("#53 write discipline: `plumb receipt --write` warns which required steps lack evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "plumbline-writewarn-"));
  try {
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "t@t.dev");
    git(dir, "config", "user.name", "t");
    git(dir, "checkout", "-q", "-b", "base");
    mkdirSync(join(dir, ".plumbline", "receipts"), { recursive: true });
    writeFileSync(join(dir, ".plumbline", "MISSION.md"), "# Mission\nKeep changes honest.\n");
    writeFileSync(join(dir, ".plumbline", "policy.json"), JSON.stringify(BASE_POLICY) + "\n");
    writeFileSync(join(dir, "app.txt"), "v0\n");
    git(dir, "add", "."); git(dir, "commit", "-qm", "base");

    git(dir, "checkout", "-q", "-b", "work");
    writeFileSync(join(dir, "app.txt"), "v1\n");
    writeFileSync(join(dir, ".plumbline", "receipts", "work.json"), receiptMissingRequiredEvidence());
    git(dir, "add", "."); git(dir, "commit", "-qm", "work");

    const r = spawnSync(
      "node",
      [CLI, "receipt", "--write", "--task", "work", "--base", "base", "--policy", ".plumbline/policy.json"],
      { cwd: dir, encoding: "utf8" },
    );
    // --write succeeds (it only touches mechanical fields) but must LOUDLY warn
    // that the receipt would fail the gate on the missing evidence — pre-push.
    assert.equal(r.status, 0, `receipt --write should succeed; stderr:\n${r.stderr}`);
    assert.match(r.stderr, /would FAIL the gate/);
    assert.match(r.stderr, /npm run integration/);
    // It must NOT have fabricated execution_evidence for the author.
    const written = JSON.parse(readFileSync(join(dir, ".plumbline", "receipts", "work.json"), "utf8"));
    assert.equal(written.execution_evidence.length, 1, "must not auto-fill judgment (execution_evidence)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
