import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end for `plumb check` (#39): the default local pre-flight runs the
// shape floor ONLY and must never print a bare gate verdict; `--review` runs the
// semantic layer too, and degrades cleanly to shape-only when no key is present.

const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A repo on branch `work` with a committed change + a valid, diff-stamped receipt. */
function repoWithReceipt(): string {
  const dir = mkdtempSync(join(tmpdir(), "plumbline-check-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t.dev");
  git(dir, "config", "user.name", "t");
  git(dir, "checkout", "-q", "-b", "base");

  mkdirSync(join(dir, ".plumbline", "receipts"), { recursive: true });
  writeFileSync(join(dir, ".plumbline", "MISSION.md"), "# Mission\nKeep changes honest and reviewed.\n");
  writeFileSync(
    join(dir, ".plumbline", "policy.json"),
    JSON.stringify({
      version: "1.0",
      mission_file: ".plumbline/MISSION.md",
      required_checks: [],
      ci_evidence_checks: [],
      protected_paths: [".plumbline/**", ".github/workflows/**"],
      min_review_confidence: 0.8,
      human_review_level: "balanced",
      review_provider: "anthropic",
      max_receipt_bytes: 262144,
      skip_review: { docs_only: false, config_only: false, below_diff_chars: 0 },
      review_cache: { enabled: false, dir: ".plumbline/cache/review" },
      budget: { use_cheap_model: false, max_usd_per_pr: 0 },
    }) + "\n",
  );
  writeFileSync(join(dir, "app.txt"), "v0\n");
  git(dir, "add", "."); git(dir, "commit", "-qm", "base");

  git(dir, "checkout", "-q", "-b", "work");
  writeFileSync(join(dir, "app.txt"), "v1 — a real change\n");
  writeFileSync(
    join(dir, ".plumbline", "receipts", "work.json"),
    JSON.stringify({
      receipt_version: "1.0",
      task_id: "work",
      agent_id: "test",
      intent: "Change app.txt from v0 to v1 to exercise the local check flow end to end.",
      self_modifying: false,
      policy_refs: [".plumbline/MISSION.md"],
      validation_plan: [{ command: "true", reason: "no-op check for the fixture", required: true }],
      execution_evidence: [{ command: "true", status: "passed", output_ref: "ok" }],
      changed_files: ["app.txt"],
      diff_sha256: "0".repeat(64),
      result_summary: "app.txt changed from v0 to v1; verified locally in the check-flow fixture.",
    }) + "\n",
  );
  git(dir, "add", "."); git(dir, "commit", "-qm", "work");

  // Stamp the correct diff_sha256 / changed_files against the committed HEAD.
  execFileSync("node", [CLI, "receipt", "--write", "--task", "work", "--base", "base"], {
    cwd: dir,
    encoding: "utf8",
  });
  return dir;
}

const RECEIPT = ".plumbline/receipts/work.json";
const POLICY = ".plumbline/policy.json";
// Env with every review-provider key stripped, to force the degrade path.
const NO_KEYS = { ...process.env, ANTHROPIC_API_KEY: "", PLUMBLINE_API_KEY: "", PROOFGATE_API_KEY: "" };

test("plumb check (default): prints the shape pre-flight banner, never a bare gate verdict", () => {
  const dir = repoWithReceipt();
  try {
    const r = spawnSync("node", [CLI, "check", "--base", "base", "--receipt", RECEIPT, "--policy", POLICY], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(r.status, 0, `check should pass shape; stderr:\n${r.stderr}`);
    assert.match(r.stdout, /shape pre-flight: PASS/);
    // The honesty fix: default check must NOT emit the final-verdict banner.
    assert.doesNotMatch(r.stdout, /plumbline: APPROVE/);
    assert.match(r.stderr, /semantic review runs in CI/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plumb check --review without a key: degrades to shape-only with an explicit note", () => {
  const dir = repoWithReceipt();
  try {
    const r = spawnSync(
      "node",
      [CLI, "check", "--review", "--base", "base", "--receipt", RECEIPT, "--policy", POLICY],
      { cwd: dir, encoding: "utf8", env: NO_KEYS },
    );
    assert.equal(r.status, 0, `should degrade to a passing shape pre-flight; stderr:\n${r.stderr}`);
    // Explicit degrade note — never silently claim a verdict it didn't compute.
    assert.match(r.stderr, /Falling back to shape-only pre-flight/);
    assert.match(r.stdout, /shape pre-flight: PASS/);
    assert.doesNotMatch(r.stdout, /plumbline: APPROVE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
