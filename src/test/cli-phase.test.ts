import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Phased gate (#58, v0.6.0): `plumb run --phase quality|verify|full`.
//
// What we assert here is the ONE behavioral hinge of the feature: whether the
// ci-evidence gate runs. In `--phase quality` it must be SKIPPED (tests haven't
// run yet) with a note that reads clearly as "tests were skipped, not passed";
// in `verify` / `full` it must be attempted. We drive `plumb run` locally with
// a policy that has `ci_evidence_checks` set but no GitHub PR context, so the
// ci-evidence path emits a deterministic, observable stderr line in each case
// WITHOUT needing a live GitHub API or an LLM key. We do NOT re-test the
// ci-evidence gate LOGIC (that's covered elsewhere) — only WHEN it runs.

const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A repo on branch `work` with a committed change + a valid, diff-stamped receipt. */
function repoWithReceipt(): string {
  const dir = mkdtempSync(join(tmpdir(), "plumbline-phase-"));
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
      // A required CI check — the ci-evidence gate keys on this being present.
      ci_evidence_checks: ["test"],
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
      intent: "Change app.txt from v0 to v1 to exercise the phased run flow end to end.",
      self_modifying: false,
      policy_refs: [".plumbline/MISSION.md"],
      validation_plan: [
        { command: "test", reason: "the suite", required: true, ci_covered: true },
      ],
      execution_evidence: [{ command: "test", status: "skipped", skip_reason: "CI runs it" }],
      changed_files: ["app.txt"],
      diff_sha256: "0".repeat(64),
      result_summary: "app.txt changed from v0 to v1; verified in the phased-run fixture.",
    }) + "\n",
  );
  git(dir, "add", "."); git(dir, "commit", "-qm", "work");

  execFileSync("node", [CLI, "receipt", "--write", "--task", "work", "--base", "base"], {
    cwd: dir,
    encoding: "utf8",
  });
  return dir;
}

const POLICY = ".plumbline/policy.json";
const RECEIPT = ".plumbline/receipts/work.json";
// No provider key + no GitHub context: the ci-evidence path degrades to a
// deterministic "no GitHub PR context" note, and semantic review fails closed —
// both fine, we only assert on the ci-evidence phase behavior.
const NO_CI = {
  ...process.env,
  ANTHROPIC_API_KEY: "",
  PLUMBLINE_API_KEY: "",
  PROOFGATE_API_KEY: "",
  GITHUB_TOKEN: "",
  GITHUB_REPOSITORY: "",
  GITHUB_ACTIONS: "",
  CI: "",
};

function run(dir: string, ...extra: string[]) {
  return spawnSync(
    "node",
    [CLI, "run", "--base", "base", "--receipt", RECEIPT, "--policy", POLICY, "--no-git", ...extra],
    { cwd: dir, encoding: "utf8", env: NO_CI },
  );
}

test("plumb run --phase quality: ci-evidence is SKIPPED (tests not yet run)", () => {
  const dir = repoWithReceipt();
  try {
    const r = run(dir, "--phase", "quality");
    assert.match(r.stderr, /ci-evidence: SKIPPED in --phase quality/);
    // Must NOT attempt the ci-evidence verify path in phase 1.
    assert.doesNotMatch(r.stderr, /ci-evidence gate: (PASS|FAIL)/);
    assert.doesNotMatch(r.stderr, /ci-evidence: configured but no GitHub PR context/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plumb run --phase verify: ci-evidence IS attempted", () => {
  const dir = repoWithReceipt();
  try {
    const r = run(dir, "--phase", "verify");
    // With ci_evidence_checks set but no GitHub context, the gate attempts the
    // ci-evidence path and reports it couldn't corroborate — it did NOT skip.
    assert.doesNotMatch(r.stderr, /ci-evidence: SKIPPED in --phase quality/);
    assert.match(r.stderr, /ci-evidence: configured but no GitHub PR context/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plumb run --phase full (default): ci-evidence IS attempted (back-compat)", () => {
  const dir = repoWithReceipt();
  try {
    const explicit = run(dir, "--phase", "full");
    const implicit = run(dir); // no --phase → defaults to full
    for (const r of [explicit, implicit]) {
      assert.doesNotMatch(r.stderr, /ci-evidence: SKIPPED in --phase quality/);
      assert.match(r.stderr, /ci-evidence: configured but no GitHub PR context/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plumb run --phase bogus: rejected with a clear error + exit 2", () => {
  const dir = repoWithReceipt();
  try {
    const r = run(dir, "--phase", "bogus");
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown --phase "bogus"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
