import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveSeverity,
  validateSeverityConfig,
  applySeverities,
  STRICTNESS_PRESETS,
  PROTECTED_CHECKS,
} from "../severity.js";
import { shapeCheck, computeDiffSha256, gitDiffExcludingReceipt } from "../shape.js";
import { PolicySchema, type Policy } from "../types.js";

function policy(overrides: Record<string, unknown> = {}): Policy {
  return PolicySchema.parse({ version: "1.0", ...overrides });
}

/** A receipt whose only shape problem is a missing-evidence required step. */
function receiptMissingEvidence(): string {
  return JSON.stringify({
    receipt_version: "1.0",
    task_id: "SEV-1",
    agent_id: "tester",
    intent: "A perfectly reasonable intent statement that easily clears forty characters.",
    self_modifying: false,
    policy_refs: [".plumbline/policy.json"],
    validation_plan: [{ command: "npm test", reason: "asserts behavior", required: true }],
    execution_evidence: [{ command: "npm run lint", status: "passed" }], // wrong command — no coverage
    changed_files: ["src/app.ts"],
    diff_sha256: "a".repeat(64),
    result_summary: "Summary of what shipped, long enough to satisfy the schema minimum easily.",
  });
}

test("severity: default is strict — everything error, presets untouched", () => {
  const p = policy();
  assert.equal(p.strictness, "strict");
  assert.equal(resolveSeverity("evidence_coverage", p), "error");
  assert.equal(resolveSeverity("undeclared_files", p), "error");
  assert.deepEqual(STRICTNESS_PRESETS.strict, {});
});

test("severity: standard preset warns undeclared_files + receipt_size only", () => {
  const p = policy({ strictness: "standard" });
  assert.equal(resolveSeverity("undeclared_files", p), "warn");
  assert.equal(resolveSeverity("receipt_size", p), "warn");
  assert.equal(resolveSeverity("evidence_coverage", p), "error");
  assert.equal(resolveSeverity("required_checks", p), "error");
});

test("severity: lenient additionally warns evidence/required/ci_evidence", () => {
  const p = policy({ strictness: "lenient" });
  for (const c of ["undeclared_files", "receipt_size", "evidence_coverage", "required_checks", "ci_evidence"] as const) {
    assert.equal(resolveSeverity(c, p), "warn", c);
  }
});

test("severity: explicit check_severity wins over the preset", () => {
  const p = policy({ strictness: "lenient", check_severity: { evidence_coverage: "error" } });
  assert.equal(resolveSeverity("evidence_coverage", p), "error");
  const p2 = policy({ check_severity: { undeclared_files: "off" } });
  assert.equal(resolveSeverity("undeclared_files", p2), "off");
});

test("severity: the protected floor can never be downgraded", () => {
  const p = policy({
    strictness: "lenient",
    check_severity: { diff_integrity: "off", protected_paths: "warn", schema: "off" },
  });
  for (const c of PROTECTED_CHECKS) {
    assert.equal(resolveSeverity(c, p), "error", c);
  }
  const notes = validateSeverityConfig(p);
  assert.equal(notes.filter((n) => n.includes("cannot be downgraded")).length, 3);
});

test("severity: unknown check names in check_severity produce a warning", () => {
  const p = policy({ check_severity: { evidnce_coverage: "warn" } }); // typo
  const notes = validateSeverityConfig(p);
  assert.ok(notes.some((n) => n.includes('unknown check "evidnce_coverage"')));
});

test("applySeverities: off suppresses to a single per-check note", () => {
  const p = policy({ check_severity: { undeclared_files: "off" } });
  const { errors, warnings } = applySeverities(
    [
      { check: "undeclared_files", message: "one" },
      { check: "undeclared_files", message: "two" },
    ],
    p,
  );
  assert.equal(errors.length, 0);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('suppressed 2 finding(s) from check "undeclared_files"'));
});

test("shapeCheck: missing evidence gates under strict, warns under lenient", () => {
  const strict = shapeCheck(receiptMissingEvidence(), policy(), { skipGit: true });
  assert.equal(strict.result.pass, false);
  assert.ok(strict.result.errors.some((e) => e.includes("no execution evidence")));

  const lenient = shapeCheck(receiptMissingEvidence(), policy({ strictness: "lenient" }), {
    skipGit: true,
  });
  assert.equal(lenient.result.pass, true);
  assert.ok(lenient.result.warnings.some((w) => w.includes("[evidence_coverage: warn]")));
});

test("shapeCheck: oversized receipt blocks under strict, continues under standard", () => {
  const big = receiptMissingEvidence();
  const p = policy({ max_receipt_bytes: 64 }); // everything is oversized
  const strict = shapeCheck(big, p, { skipGit: true });
  assert.equal(strict.result.pass, false);
  assert.ok(strict.result.errors.some((e) => e.includes("max size")));

  const std = policy({ max_receipt_bytes: 64, strictness: "standard" });
  const relaxed = shapeCheck(big, std, { skipGit: true });
  // Size is only a warning now — but the receipt still gets fully evaluated,
  // so the evidence problem still gates.
  assert.ok(relaxed.result.warnings.some((w) => w.includes("[receipt_size: warn]")));
  assert.ok(relaxed.result.errors.some((e) => e.includes("no execution evidence")));
});

test("shapeCheck: an invalid receipt (schema) fails even under lenient", () => {
  const res = shapeCheck(`{"receipt_version":"1.0"}`, policy({ strictness: "lenient" }), {
    skipGit: true,
  });
  assert.equal(res.result.pass, false);
  assert.ok(res.result.errors.some((e) => e.startsWith("schema:")));
});

// ── E2E git fixture: the same failing receipt gates differently by preset,
//    and the diff_sha256 floor holds even when the policy tries to soften it ──

test("E2E: strict vs lenient on a real repo; diff_integrity refuses downgrade", () => {
  const dir = mkdtempSync(join(tmpdir(), "plumb-sev-"));
  try {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(dir, "app.ts"), "export const a = 1;\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    git("checkout", "-qb", "feat");
    writeFileSync(join(dir, "app.ts"), "export const a = 2;\n");
    writeFileSync(join(dir, "extra.ts"), "export const b = 1;\n"); // will be undeclared
    git("add", "-A");
    git("commit", "-qm", "change");

    const goodSha = computeDiffSha256(gitDiffExcludingReceipt("main", dir));
    const receipt = (sha: string) =>
      JSON.stringify({
        receipt_version: "1.0",
        task_id: "SEV-E2E",
        agent_id: "tester",
        intent: "Change the constant value of a in app.ts as part of the severity fixture.",
        self_modifying: false,
        policy_refs: ["policy.json"],
        validation_plan: [{ command: "npm test", reason: "asserts", required: true }],
        execution_evidence: [{ command: "npm test", status: "passed" }],
        changed_files: ["app.ts"], // extra.ts undeclared on purpose
        diff_sha256: sha,
        result_summary: "Bumped the constant and verified the suite still passes end to end.",
      });
    mkdirSync(join(dir, ".plumbline"), { recursive: true });

    // strict: undeclared_files is an error
    const strict = shapeCheck(receipt(goodSha), policy(), { baseRef: "main", cwd: dir });
    assert.equal(strict.result.pass, false);
    assert.ok(strict.result.errors.some((e) => e.includes("extra.ts")));

    // lenient: same receipt passes; the finding is a warning
    const lenient = shapeCheck(receipt(goodSha), policy({ strictness: "lenient" }), {
      baseRef: "main",
      cwd: dir,
    });
    assert.equal(lenient.result.pass, true);
    assert.ok(lenient.result.warnings.some((w) => w.includes("extra.ts")));

    // a wrong hash fails EVEN when the policy tries to turn diff_integrity off
    const attack = shapeCheck(
      receipt("f".repeat(64)),
      policy({ strictness: "lenient", check_severity: { diff_integrity: "off" } }),
      { baseRef: "main", cwd: dir },
    );
    assert.equal(attack.result.pass, false);
    assert.ok(attack.result.errors.some((e) => e.includes("diff_sha256 mismatch")));
    assert.ok(attack.result.warnings.some((w) => w.includes("cannot be downgraded")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
