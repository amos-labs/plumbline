import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { uncommittedReceipts } from "../cli.js";

// #49: `plumb check` auto-discovery must find a receipt the agent just wrote but
// has NOT yet `git add`ed (the first-run trap: the AGENTS.md TL;DR runs check
// before add). Discovery is diff-based (committed only), so an untracked receipt
// was invisible and check errored "no receipt found". The fix: locally, also
// consider untracked/unstaged receipts. CI stays strictly diff-based.

const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A repo on branch `work` with a real committed change, and a receipt whose
 *  tracked-ness the caller controls. Returns the repo dir. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "plumbline-untracked-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t.dev");
  git(dir, "config", "user.name", "t");
  git(dir, "checkout", "-q", "-b", "base");
  mkdirSync(join(dir, ".plumbline", "receipts"), { recursive: true });
  writeFileSync(join(dir, ".plumbline", "MISSION.md"), "# Mission\nKeep changes honest.\n");
  writeFileSync(
    join(dir, ".plumbline", "policy.json"),
    JSON.stringify({
      version: "1.0",
      mission_file: ".plumbline/MISSION.md",
      required_checks: [],
      ci_evidence_checks: [],
      protected_paths: [".plumbline/**"],
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
  git(dir, "add", "app.txt"); git(dir, "commit", "-qm", "work");
  return dir;
}

/** Write a valid receipt (mechanical fields stamped) but DON'T git add it. */
function writeUntrackedReceipt(dir: string): void {
  writeFileSync(
    join(dir, ".plumbline", "receipts", "work.json"),
    JSON.stringify({
      receipt_version: "1.0",
      task_id: "work",
      agent_id: "test",
      intent: "Change app.txt from v0 to v1 to exercise untracked-receipt discovery end to end.",
      self_modifying: false,
      policy_refs: [".plumbline/MISSION.md"],
      validation_plan: [{ command: "true", reason: "no-op check for the fixture", required: true }],
      execution_evidence: [{ command: "true", status: "passed", output_ref: "ok" }],
      changed_files: ["app.txt"],
      diff_sha256: "0".repeat(64),
      result_summary: "app.txt changed from v0 to v1; verified locally in the untracked-discovery fixture.",
    }) + "\n",
  );
  // Stamp the correct diff_sha256 / changed_files (still leaves it untracked).
  execFileSync("node", [CLI, "receipt", "--write", "--task", "work", "--base", "base"], {
    cwd: dir,
    encoding: "utf8",
  });
}

test("#49 uncommittedReceipts: lists an untracked receipt under receipts/", () => {
  const dir = repo();
  try {
    writeUntrackedReceipt(dir);
    const found = uncommittedReceipts(dir);
    assert.deepEqual(found, [".plumbline/receipts/work.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#49 e2e: `plumb check` discovers an UNTRACKED receipt (auto, no --receipt) and PASSES shape", () => {
  const dir = repo();
  try {
    writeUntrackedReceipt(dir);
    // No --receipt: auto-discovery. Not in CI (no GITHUB_ACTIONS), so the local
    // untracked fallback applies.
    const env = { ...process.env, GITHUB_ACTIONS: "", TF_BUILD: "" };
    const r = spawnSync("node", [CLI, "check", "--base", "base"], { cwd: dir, encoding: "utf8", env });
    assert.equal(r.status, 0, `check must find the untracked receipt and pass; stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(r.stdout, /shape pre-flight: PASS/);
    // The old failure mode was this exact error — it must NOT appear now.
    assert.doesNotMatch(r.stderr, /no receipt found/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#49 e2e: once committed, auto-discovery still works (no regression)", () => {
  const dir = repo();
  try {
    writeUntrackedReceipt(dir);
    git(dir, "add", ".plumbline/receipts/work.json");
    git(dir, "commit", "-qm", "receipt");
    const env = { ...process.env, GITHUB_ACTIONS: "", TF_BUILD: "" };
    const r = spawnSync("node", [CLI, "check", "--base", "base"], { cwd: dir, encoding: "utf8", env });
    assert.equal(r.status, 0, `committed receipt must still be discovered; stderr:\n${r.stderr}`);
    assert.match(r.stdout, /shape pre-flight: PASS/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
