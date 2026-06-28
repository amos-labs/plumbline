import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit, sanitizeTaskId, newReceipt } from "../scaffold.js";

test("sanitizeTaskId: strips refs/heads, slugs unsafe chars, never empty", () => {
  assert.equal(sanitizeTaskId("refs/heads/feat/ISSUE-142"), "feat-ISSUE-142");
  assert.equal(sanitizeTaskId("Fix: weird @name!"), "Fix-weird-name");
  assert.equal(sanitizeTaskId("---"), "TASK");
  assert.equal(sanitizeTaskId("ISSUE-7"), "ISSUE-7");
});

test("newReceipt: has the required receipt fields + defaults", () => {
  const r = newReceipt({ taskId: "ISSUE-7", agentId: "claude-code" });
  assert.equal(r.receipt_version, "1.0");
  assert.equal(r.task_id, "ISSUE-7");
  assert.equal(r.agent_id, "claude-code");
  assert.equal(r.self_modifying, false);
  assert.equal(r.diff_sha256, "0".repeat(64)); // placeholder until stamped
  assert.ok(Array.isArray(r.validation_plan) && (r.validation_plan as unknown[]).length >= 1);
  assert.ok(Array.isArray(r.execution_evidence) && (r.execution_evidence as unknown[]).length >= 1);
  const r2 = newReceipt({ taskId: "x", agentId: "a", diffSha256: "a".repeat(64), changedFiles: ["f.rb"] });
  assert.equal(r2.diff_sha256, "a".repeat(64));
  assert.deepEqual(r2.changed_files, ["f.rb"]);
});

test("runInit: scaffolds the expected files and is idempotent (never clobbers)", () => {
  const dir = mkdtempSync(join(tmpdir(), "proofgate-init-"));
  const first = runInit(dir);
  // Key artifacts land.
  for (const p of [
    ".github/workflows/proofgate.yml",
    ".proofgate/policy.json",
    ".proofgate/MISSION.md",
    ".proofgate/AGENTS.md",
    ".proofgate/receipts/EXAMPLE.json",
  ]) {
    assert.ok(existsSync(join(dir, p)), `expected ${p} to be created`);
  }
  // All files reported created on a fresh repo.
  assert.ok(first.some((i) => i.dest === ".proofgate/AGENTS.md" && i.created));
  // The scaffolded workflow had its "# Copy to …" hint stripped.
  const wf = readFileSync(join(dir, ".github/workflows/proofgate.yml"), "utf8");
  assert.ok(!/^# Copy to /.test(wf));
  assert.match(wf, /amos-labs\/proofgate@v0/);

  // Idempotency: modify a file, re-run, confirm it's left as-is (not clobbered).
  const policyPath = join(dir, ".proofgate/policy.json");
  writeFileSync(policyPath, '{"version":"1.0","custom":true}\n');
  const second = runInit(dir);
  assert.equal(readFileSync(policyPath, "utf8"), '{"version":"1.0","custom":true}\n');
  assert.ok(second.every((i) => !i.created), "re-run should create nothing");
});
