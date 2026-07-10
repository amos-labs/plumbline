import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  reviewUnavailableVerdict,
  reviewSkippedUnavailableVerdict,
  resolveUnavailableVerdict,
  semanticReview,
  PROMPT_VERSION,
} from "../review.js";
import { readReviewCache, writeReviewCache } from "../cost.js";
import { PolicySchema, type Policy, type Receipt } from "../types.js";
import type { ReviewProvider } from "../provider.js";

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

// ── Item 1: the RUNTIME-CALL failure branch (not the construction branch) ──
//
// Stripping the API key makes provider CONSTRUCTION fail (provider === null),
// so the e2e fixtures above never reach the try/catch around semanticReview().
// This is the OTHER branch: a provider IS constructed (a key is present) but the
// call itself throws — an API 5xx/429, a network error, or a timeout. Drive
// semanticReview() with a provider whose complete() rejects and prove (a) it
// propagates (so the CLI catch fires) and (b) resolveUnavailableVerdict — the
// exact function that catch calls — yields the fail-closed BLOCK.

function pol(overrides: Record<string, unknown> = {}): Policy {
  return PolicySchema.parse({ version: "1.0", ...overrides });
}

function rcpt(): Receipt {
  return {
    receipt_version: "1.0",
    task_id: "T-1",
    agent_id: "a",
    intent: "x".repeat(41),
    self_modifying: false,
    policy_refs: [".plumbline/MISSION.md"],
    validation_plan: [{ command: "npm test", reason: "r", required: true }],
    execution_evidence: [{ command: "npm test", status: "passed" }],
    changed_files: ["README.md"],
    diff_sha256: "a".repeat(64),
    result_summary: "y".repeat(41),
  } as Receipt;
}

const throwingProvider = (msg: string): ReviewProvider => ({
  id: "anthropic",
  async complete() {
    throw new Error(msg);
  },
});

test("runtime-call failure: semanticReview() propagates the provider error to the CLI catch", async () => {
  await assert.rejects(
    () => semanticReview("mission", rcpt(), "diff", pol(), throwingProvider("API error 529: overloaded")),
    /529|overloaded/,
    "a provider call failure must throw so the CLI try/catch can fail closed",
  );
});

test("runtime-call failure + required → fail-closed BLOCK (verdict review, no audit → uncacheable)", () => {
  const reason = "the review provider call failed (timeout after 60s)";
  const v = resolveUnavailableVerdict(pol({ require_semantic_review: true }), reason, /*shapePassed*/ true);
  assert.equal(v.verdict, "review");
  assert.ok((v.failure_capsule?.findings ?? []).some((f) => f.class === "blocking"));
  assert.match(v.risk_notes, /FAILING CLOSED/);
  assert.match(v.risk_notes, /timeout/);
  assert.equal(v.audit, undefined, "a fail-closed verdict carries no audit → the cache guard skips it");
});

test("runtime-call failure + opted out → shape verdict stands, LOUD it did not run", () => {
  const reason = "the review provider call failed (ECONNRESET)";
  const v = resolveUnavailableVerdict(pol({ require_semantic_review: false }), reason, /*shapePassed*/ true);
  assert.equal(v.verdict, "approve");
  assert.match(v.risk_notes, /SEMANTIC REVIEW DID NOT RUN/);
  assert.equal(v.audit, undefined);
});

// ── Item 2: require_semantic_review:false AND the shape gate itself FAILS ───
//
// The opt-out only governs the review-UNAVAILABLE case. A shape failure is a
// hard defect and must still BLOCK regardless of the opt-out — the opt-out must
// never turn a broken receipt into a pass.

/** Same as repoWithPassingShape but with a STALE diff_sha256 so shape FAILS. */
function repoWithFailingShape(requireReview: boolean): string {
  const dir = repoWithPassingShape(requireReview);
  // Corrupt the committed receipt's diff_sha256 so diff_integrity fails.
  const receiptPath = join(dir, RECEIPT);
  const r = JSON.parse(readFileSync(receiptPath, "utf8"));
  r.diff_sha256 = "b".repeat(64);
  writeFileSync(receiptPath, JSON.stringify(r, null, 2) + "\n");
  git(dir, "add", "."); git(dir, "commit", "-qm", "break shape");
  return dir;
}

test("plumb run: shape FAILS + opted out (require_semantic_review:false) → still BLOCK (exit != 0)", () => {
  const dir = repoWithFailingShape(false);
  try {
    const r = spawnSync("node", [CLI, ...ARGS(RECEIPT, POLICY), dir], {
      cwd: dir,
      encoding: "utf8",
      env: NO_KEYS,
    });
    // Opt-out must NOT rescue a broken shape: the gate stays red.
    assert.notEqual(r.status, 0, `shape failure must block even when review is opted out; stdout:\n${r.stdout}`);
    assert.doesNotMatch(r.stdout, /plumbline: APPROVE/);
    assert.match(r.stdout, /Shape gate:\*\* FAIL|shape.*FAIL/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plumb run: shape FAILS + required → BLOCK (exit != 0), review not reached", () => {
  const dir = repoWithFailingShape(true);
  try {
    const r = spawnSync("node", [CLI, ...ARGS(RECEIPT, POLICY), dir], {
      cwd: dir,
      encoding: "utf8",
      env: NO_KEYS,
    });
    assert.notEqual(r.status, 0, `shape failure must block; stdout:\n${r.stdout}`);
    assert.doesNotMatch(r.stdout, /plumbline: APPROVE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Item 3: the cache guard — a fail-closed verdict is NEVER cached/served ──
//
// The CLI writes the cache only under `if (review.audit && …)`. A fail-closed /
// opt-out verdict has audit === undefined, so it is never persisted — and even
// if one were somehow on disk, it must not be treated as a normal reusable
// verdict. Prove both the guard predicate and that a real verdict IS cacheable.

test("cache guard: fail-closed verdicts have no audit → the write guard skips them", () => {
  const failClosed = reviewUnavailableVerdict("no API key");
  const optOut = reviewSkippedUnavailableVerdict("no API key", true);
  // The CLI guard is literally `if (review.audit && …) writeReviewCache(…)`.
  assert.equal(Boolean(failClosed.audit), false, "fail-closed verdict must not pass the cache-write guard");
  assert.equal(Boolean(optOut.audit), false, "opt-out verdict must not pass the cache-write guard");
});

test("cache guard: a fail-closed verdict written to disk is never SERVED as a real hit", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "plumbline-cache-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sha = "c".repeat(64);
  // Simulate the (guarded-against) case: a fail-closed verdict on disk. The
  // guard means the CLI would never have written it — but assert defense in
  // depth: reading it back must not resurrect it as a passing/real verdict.
  writeReviewCache(dir, sha, "anthropic", "m", PROMPT_VERSION, reviewUnavailableVerdict("no key"));
  const hit = readReviewCache(dir, sha, "anthropic", "m", PROMPT_VERSION);
  // If a hit comes back at all, it is still the BLOCK verdict with no audit —
  // never an approve, never a verdict the gate would treat as a clean pass.
  if (hit) {
    assert.equal(hit.verdict, "review");
    assert.equal(hit.audit, undefined);
    assert.notEqual(hit.verdict, "approve");
  }
});
