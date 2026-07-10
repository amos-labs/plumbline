import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { reviewUnavailableVerdict, reviewSkippedUnavailableVerdict } from "../review.js";
import { PolicySchema } from "../types.js";

// Trust-integrity fail-closed (P1): when the semantic review is REQUIRED but
// cannot run (no key / provider error / timeout), the gate must BLOCK — never
// fall through to a shape-only pass. When explicitly opted out
// (require_semantic_review:false), shape-only passes but every surface says
// LOUDLY that the review did not run.

const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));

// ── Unit: the two verdict builders ────────────────────────────────────────

test("require_semantic_review defaults to TRUE (safe-by-default)", () => {
  const p = PolicySchema.parse({ version: "1.0" });
  assert.equal(p.require_semantic_review, true);
});

test("reviewUnavailableVerdict: a BLOCKING human-turn review verdict", () => {
  const v = reviewUnavailableVerdict("no API key");
  assert.equal(v.verdict, "review");
  assert.equal(v.confidence, 0);
  // Has a blocking finding so it can never read as a clean pass.
  const findings = v.failure_capsule?.findings ?? [];
  assert.ok(findings.some((f) => f.class === "blocking"), "must carry a blocking finding");
  assert.match(v.risk_notes, /FAILING CLOSED/);
  assert.match(v.risk_notes, /no API key/);
  // No audit → the caller must never cache this as a real verdict.
  assert.equal(v.audit, undefined);
});

test("reviewSkippedUnavailableVerdict: shape-pass → approve, but LOUD that review didn't run", () => {
  const pass = reviewSkippedUnavailableVerdict("no API key", true);
  assert.equal(pass.verdict, "approve");
  assert.match(pass.risk_notes, /SEMANTIC REVIEW DID NOT RUN/);
  // Never a clean pass silently: no failure_capsule, but the notes shout it.
  assert.match(pass.mission_alignment_notes, /did not run/i);

  const fail = reviewSkippedUnavailableVerdict("no API key", false);
  assert.equal(fail.verdict, "rework"); // shape already failed
});

// ── End-to-end: `plumb run` with no provider key ──────────────────────────

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, encoding: "utf8" });
}

/**
 * A repo on branch `work` with a committed change + a valid, diff-stamped
 * receipt that PASSES the shape gate — so the only thing standing between the
 * PR and an approve is the semantic review. `requireReview` sets the policy flag.
 */
function repoWithPassingShape(requireReview: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "plumbline-failclosed-"));
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
      require_semantic_review: requireReview,
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
      intent: "Change app.txt from v0 to v1 to exercise the fail-closed review flow end to end.",
      self_modifying: false,
      policy_refs: [".plumbline/MISSION.md"],
      validation_plan: [{ command: "true", reason: "no-op check for the fixture", required: true }],
      execution_evidence: [{ command: "true", status: "passed", output_ref: "ok" }],
      changed_files: ["app.txt"],
      diff_sha256: "0".repeat(64),
      result_summary: "app.txt changed from v0 to v1; verified in the fail-closed fixture.",
    }) + "\n",
  );
  git(dir, "add", "."); git(dir, "commit", "-qm", "work");
  execFileSync("node", [CLI, "receipt", "--write", "--task", "work", "--base", "base"], {
    cwd: dir,
    encoding: "utf8",
  });
  return dir;
}

// Strip every provider key so the review CANNOT run.
const NO_KEYS = { ...process.env, ANTHROPIC_API_KEY: "", PLUMBLINE_API_KEY: "", PROOFGATE_API_KEY: "" };
const ARGS = (r: string, p: string) => ["run", "--base", "base", "--receipt", r, "--policy", p, "--cwd"];
const RECEIPT = ".plumbline/receipts/work.json";
const POLICY = ".plumbline/policy.json";

test("plumb run: review REQUIRED + no provider → BLOCK (fail closed), not a shape-only pass", () => {
  const dir = repoWithPassingShape(true);
  try {
    const r = spawnSync("node", [CLI, ...ARGS(RECEIPT, POLICY), dir], {
      cwd: dir,
      encoding: "utf8",
      env: NO_KEYS,
    });
    // Non-zero exit → the required check goes red. This is the whole point.
    assert.notEqual(r.status, 0, `must fail closed; stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(r.stderr, /FAILING CLOSED/);
    // Shape passed, but the verdict is NOT approve.
    assert.match(r.stdout, /plumbline: REVIEW/);
    assert.doesNotMatch(r.stdout, /plumbline: APPROVE/);
    assert.match(r.stdout, /semantic review unavailable — failing closed/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plumb run: review OPTED OUT + no provider → shape-only PASS, but LOUD it did not run", () => {
  const dir = repoWithPassingShape(false);
  try {
    const r = spawnSync("node", [CLI, ...ARGS(RECEIPT, POLICY), dir], {
      cwd: dir,
      encoding: "utf8",
      env: NO_KEYS,
    });
    assert.equal(r.status, 0, `opt-out should pass on shape; stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(r.stdout, /plumbline: APPROVE/);
    // But it must SHOUT that the semantic review did not run.
    assert.match(r.stdout, /SEMANTIC REVIEW DID NOT RUN/);
    assert.match(r.stderr, /review did NOT run/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
