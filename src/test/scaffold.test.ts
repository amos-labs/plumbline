import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit, sanitizeTaskId, newReceipt, resolveStack, policyForStack } from "../scaffold.js";

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

// ── Batteries-included (#22) ───────────────────────────────────────────────

test("runInit: the scaffolded gate workflow ships WITH the ci-evidence poll-wait wired", () => {
  const dir = mkdtempSync(join(tmpdir(), "plumbline-pollwait-"));
  runInit(dir);
  const wf = readFileSync(join(dir, ".github/workflows/plumbline.yml"), "utf8");
  // Poll-wait step present so the gate never races CI.
  assert.match(wf, /Wait for CI checks to finish/);
  assert.match(wf, /checks\.listForRef/);
  assert.match(wf, /PLUMBLINE_POLL_TIMEOUT_SECONDS/);
  // checks:read permission needed to read the check-runs.
  assert.match(wf, /checks: read/);
});

function rustSqlxRepo(withDockerfile = false): string {
  const dir = mkdtempSync(join(tmpdir(), "plumbline-rust-"));
  writeFileSync(join(dir, "Cargo.toml"), '[dependencies]\nsqlx = "0.8"\n');
  mkdirSync(join(dir, "migrations"));
  if (withDockerfile) writeFileSync(join(dir, "Dockerfile"), "FROM rust\n");
  return dir;
}

test("resolveStack: --stack overrides, else auto-detect", () => {
  const plain = mkdtempSync(join(tmpdir(), "plumbline-plain-"));
  assert.equal(resolveStack(plain), undefined);
  assert.equal(resolveStack(plain, "rust-sqlx"), "rust-sqlx");
  assert.equal(resolveStack(rustSqlxRepo()), "rust-sqlx");
});

test("runInit: a detected rust-sqlx repo scaffolds migration-guard + rust-cache CI + binds policy", () => {
  const dir = rustSqlxRepo();
  const items = runInit(dir);
  // Migration guard + parallelized rust-cache CI.
  assert.ok(existsSync(join(dir, ".github/workflows/migration-guard.yml")));
  const ci = readFileSync(join(dir, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /Swatinem\/rust-cache/);
  // Parallelized: fmt/clippy/test are independent jobs (no needs: chain).
  // Match a real YAML key (indented `needs:`), not the word in a comment.
  assert.ok(!/^\s+needs:/m.test(ci), "preset CI must not chain jobs with needs:");
  assert.match(ci, /name: test/);
  // Policy binds ci_evidence to the real CI jobs.
  const policy = JSON.parse(readFileSync(join(dir, ".plumbline/policy.json"), "utf8"));
  assert.ok(policy.ci_evidence_checks.includes("test"));
  assert.ok(policy.ci_evidence_checks.includes("migration-guard"));
  // The preset items are labelled.
  assert.ok(items.some((i) => i.dest === ".github/workflows/ci.yml" && i.note === "rust-sqlx preset"));
});

test("runInit: cargo-chef hint only when a Dockerfile is present", () => {
  const without = rustSqlxRepo(false);
  runInit(without);
  assert.ok(!existsSync(join(without, "Dockerfile.cargo-chef.example")), "no Dockerfile → no chef hint");
  const withDf = rustSqlxRepo(true);
  runInit(withDf);
  const hint = readFileSync(join(withDf, "Dockerfile.cargo-chef.example"), "utf8");
  assert.match(hint, /cargo chef cook/);
  assert.match(hint, /cache-to.*mode=max/);
});

test("runInit: --no-stack yields core-only even on a rust-sqlx repo", () => {
  const dir = rustSqlxRepo();
  runInit(dir, { noStack: true });
  assert.ok(!existsSync(join(dir, ".github/workflows/migration-guard.yml")));
  assert.ok(!existsSync(join(dir, ".github/workflows/ci.yml")));
  const policy = JSON.parse(readFileSync(join(dir, ".plumbline/policy.json"), "utf8"));
  assert.deepEqual(policy.ci_evidence_checks, []);
});

test("runInit: idempotent with a stack preset — re-run creates nothing", () => {
  const dir = rustSqlxRepo(true);
  runInit(dir);
  const second = runInit(dir);
  assert.ok(second.every((i) => !i.created), "re-run should create nothing");
});

test("policyForStack: adds test + migration-guard to ci_evidence_checks for rust-sqlx only", () => {
  const base = '{"version":"1.0","ci_evidence_checks":[]}';
  const patched = JSON.parse(policyForStack(base, "rust-sqlx"));
  assert.deepEqual(patched.ci_evidence_checks.sort(), ["migration-guard", "test"]);
  // No stack → untouched.
  assert.equal(policyForStack(base, undefined), base);
});
