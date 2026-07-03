import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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
  const dir = mkdtempSync(join(tmpdir(), "plumbline-init-"));
  const first = runInit(dir);
  // Key artifacts land under the canonical .plumbline/ on a fresh repo.
  for (const p of [
    ".github/workflows/plumbline.yml",
    ".plumbline/policy.json",
    ".plumbline/MISSION.md",
    ".plumbline/AGENTS.md",
    ".plumbline/receipts/EXAMPLE.json",
  ]) {
    assert.ok(existsSync(join(dir, p)), `expected ${p} to be created`);
  }
  // All files reported created on a fresh repo.
  assert.ok(first.some((i) => i.dest === ".plumbline/AGENTS.md" && i.created));
  // The scaffolded workflow had its "# Copy to …" hint stripped.
  const wf = readFileSync(join(dir, ".github/workflows/plumbline.yml"), "utf8");
  assert.ok(!/^# Copy to /.test(wf));
  assert.match(wf, /amos-labs\/plumbline@v0/);

  // Idempotency: modify a file, re-run, confirm it's left as-is (not clobbered).
  const policyPath = join(dir, ".plumbline/policy.json");
  writeFileSync(policyPath, '{"version":"1.0","custom":true}\n');
  const second = runInit(dir);
  assert.equal(readFileSync(policyPath, "utf8"), '{"version":"1.0","custom":true}\n');
  assert.ok(second.every((i) => !i.created), "re-run should create nothing");
});

test("runInit: a legacy .proofgate/ repo keeps its dir (back-compat, no dual tree)", () => {
  const dir = mkdtempSync(join(tmpdir(), "plumbline-legacy-init-"));
  mkdirSync(join(dir, ".proofgate"), { recursive: true });
  runInit(dir);
  // Scaffolds into the existing legacy dir — never creates a second config tree.
  assert.ok(existsSync(join(dir, ".proofgate/policy.json")));
  assert.ok(!existsSync(join(dir, ".plumbline")), "must not create .plumbline beside .proofgate");
});
