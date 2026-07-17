import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";

// v0.6.2 — REVIEW is a TERMINAL verdict ONLY.
//
// The 2026-07-16 incident: `plumb run --phase quality` on a PR touching a
// protected surface produced a semantic "review" outcome and then EXITED 1 +
// published a blocking "REVIEW — awaiting human approval" check-run. That
// blocked the test jobs (needs: chain) → phase 3 (verify) saw the required
// checks as conclusion=skipped → ci-evidence FAIL → a SECOND, contradictory
// REWORK. One PR got both REVIEW and REWORK.
//
// The contract these tests pin:
//   phase quality + semantic "review"  → exit 0, PASS-style output, NO REVIEW
//   phase quality + semantic "rework"  → exit 1, REWORK
//   phase quality + shape fail          → exit 1, REWORK
//   phase verify  + review-warranted    → exit 1, REVIEW (terminal)
//   phase verify  + ci-fail             → exit 1, REWORK
//   phase full    + review-warranted    → exit 1, REVIEW (terminal, unchanged)
//
// We force the semantic verdict deterministically by pointing the gate at a
// mock OpenAI-compatible endpoint that serves a scripted review JSON — no live
// LLM, no Anthropic key. ci-evidence runs with no GitHub context (verify/full
// then report "no GitHub PR context"), so the ONLY thing that can turn the
// terminal verdict into REVIEW is the semantic judgment we script.

const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A review-model JSON body: one blocking+human finding ⇒ verdict "review". */
const REVIEW_BODY = JSON.stringify({
  verdict: "review",
  confidence: 0.95,
  validation_coverage_notes: "Covered.",
  mission_alignment_notes: "Aligned.",
  risk_notes: "Touches a protected surface — a human must sign off.",
  failure_capsule: {
    failing_check: "protected-surface change",
    suspected_cause: "The change touches a protected path.",
    next_action_requested: "A maintainer should approve.",
    findings: [
      {
        description: "Protected-surface change needs a human sign-off.",
        class: "blocking",
        actor: "human",
        materiality: "material",
      },
    ],
    changed_files_implicated: ["app.txt"],
    severity: "review",
  },
});

/** One blocking+agent finding ⇒ verdict "rework". */
const REWORK_BODY = JSON.stringify({
  verdict: "rework",
  confidence: 0.9,
  validation_coverage_notes: "Missing a test.",
  mission_alignment_notes: "Aligned.",
  risk_notes: "A regression is possible.",
  failure_capsule: {
    failing_check: "missing test",
    suspected_cause: "The changed path has no validation.",
    next_action_requested: "Add a test for the changed behavior.",
    findings: [
      {
        description: "Add a test for the changed behavior.",
        class: "blocking",
        actor: "agent",
        materiality: "material",
      },
    ],
    changed_files_implicated: ["app.txt"],
    severity: "fixable",
  },
});

/** No findings ⇒ verdict "approve". */
const PASS_BODY = JSON.stringify({
  verdict: "approve",
  confidence: 0.99,
  validation_coverage_notes: "Fully covered.",
  mission_alignment_notes: "Advances the mission.",
  risk_notes: "No concerns.",
});

/** Spin a mock OpenAI-compatible endpoint that always returns `content`. */
function mockReviewServer(content: string): Promise<{ base: string; close: () => void }> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

/**
 * A repo on branch `work` with a committed change + a valid receipt.
 * `selfModifying` marks a protected-surface change (drives the receipt).
 */
function repoWithReceipt(opts: { selfModifying?: boolean; brokenShape?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "plumbline-review-terminal-"));
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
      ci_evidence_checks: ["test"],
      protected_paths: [".plumbline/**", ".github/workflows/**"],
      min_review_confidence: 0.8,
      human_review_level: "balanced",
      review_provider: "openai",
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
  const receipt: Record<string, unknown> = {
    receipt_version: "1.0",
    task_id: "work",
    agent_id: "test",
    intent: "Change app.txt from v0 to v1 to exercise the phased-run REVIEW-terminal contract.",
    self_modifying: opts.selfModifying === true,
    policy_refs: [".plumbline/MISSION.md"],
    validation_plan: [{ command: "test", reason: "the suite", required: true, ci_covered: true }],
    execution_evidence: [{ command: "test", status: "skipped", skip_reason: "CI runs it" }],
    changed_files: ["app.txt"],
    diff_sha256: "0".repeat(64),
    result_summary: "app.txt changed from v0 to v1; verified in the REVIEW-terminal fixture.",
  };
  // A broken-shape receipt: drop a required judgment field so the shape gate FAILs.
  if (opts.brokenShape) delete receipt.result_summary;
  writeFileSync(join(dir, ".plumbline", "receipts", "work.json"), JSON.stringify(receipt) + "\n");
  git(dir, "add", "."); git(dir, "commit", "-qm", "work");

  execFileSync("node", [CLI, "receipt", "--write", "--task", "work", "--base", "base"], {
    cwd: dir,
    encoding: "utf8",
  });
  return dir;
}

const POLICY = ".plumbline/policy.json";
const RECEIPT = ".plumbline/receipts/work.json";

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run `plumb run` against the mock review endpoint, no GitHub context.
 *
 * ASYNC (spawn, not spawnSync) on purpose: the mock review server runs in THIS
 * test process, and the CLI subprocess makes an HTTP call to it. A synchronous
 * spawnSync would block this process's event loop → the server could never
 * accept the connection → deadlock. Awaiting an async spawn keeps the loop free.
 */
function run(dir: string, base: string, ...extra: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "node",
      [CLI, "run", "--base", "base", "--receipt", RECEIPT, "--policy", POLICY, ...extra],
      {
        cwd: dir,
        env: {
          ...process.env,
          PLUMBLINE_PROVIDER: "openai",
          PLUMBLINE_API_BASE: base,
          PLUMBLINE_API_KEY: "test-key",
          PLUMBLINE_MODEL: "mock-model",
          ANTHROPIC_API_KEY: "",
          GITHUB_TOKEN: "",
          GITHUB_REPOSITORY: "",
          GITHUB_ACTIONS: "",
          CI: "",
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

// ── phase quality: REVIEW is NOT blocking (the core fix) ────────────────────

test("phase quality + semantic review → exit 0, PASS output, no REVIEW check", async () => {
  const srv = await mockReviewServer(REVIEW_BODY);
  const dir = repoWithReceipt({ selfModifying: true });
  try {
    const r = await run(dir, srv.base, "--phase", "quality");
    assert.equal(r.status, 0, `phase-1 review must NOT block (exit 0)\nstderr:\n${r.stderr}`);
    // The semantic model genuinely returned "review"…
    assert.match(r.stderr, /semantic review: review/);
    // …but the rendered verdict must be PASS, not the REVIEW check-run/title.
    assert.match(r.stdout, /Plumbline: PASS/);
    assert.doesNotMatch(r.stdout, /REVIEW — awaiting explicit human approval/);
    // And the reason explains REVIEW is deferred to verify (terminal-only).
    assert.match(r.stdout, /Phase 1 \(quality\) PASSED \(no rework\)/);
  } finally {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("phase quality + semantic rework → exit 1, REWORK", async () => {
  const srv = await mockReviewServer(REWORK_BODY);
  const dir = repoWithReceipt();
  try {
    const r = await run(dir, srv.base, "--phase", "quality");
    assert.equal(r.status, 1, `a rework finding must still block phase 1\nstderr:\n${r.stderr}`);
    assert.match(r.stdout, /REWORK/);
    assert.doesNotMatch(r.stdout, /Plumbline: PASS/);
  } finally {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("phase quality + shape fail → exit 1, REWORK", async () => {
  const srv = await mockReviewServer(PASS_BODY);
  const dir = repoWithReceipt({ brokenShape: true });
  try {
    const r = await run(dir, srv.base, "--phase", "quality");
    assert.equal(r.status, 1, `a shape failure must block phase 1 as REWORK\nstderr:\n${r.stderr}`);
    assert.match(r.stderr, /shape gate: FAIL/);
    assert.match(r.stdout, /REWORK/);
  } finally {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── phase verify: REVIEW is emitted terminally ──────────────────────────────

test("phase verify + ci-pass + review-warranted → REVIEW (terminal)", async () => {
  const srv = await mockReviewServer(REVIEW_BODY);
  const dir = repoWithReceipt({ selfModifying: true });
  try {
    // No GitHub context → ci-evidence can't corroborate but does NOT fail the
    // gate (it degrades to "no PR context", not an error), so the terminal
    // verdict is driven by the semantic review = review.
    const r = await run(dir, srv.base, "--phase", "verify");
    assert.equal(r.status, 1, `REVIEW is non-passing (needs a human)\nstderr:\n${r.stderr}`);
    assert.match(r.stdout, /REVIEW — awaiting explicit human approval/);
    // verify must NOT skip ci-evidence (that's phase-1 only).
    assert.doesNotMatch(r.stderr, /ci-evidence: SKIPPED in --phase quality/);
  } finally {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("phase verify + ci-fail (broken shape) → REWORK", async () => {
  const srv = await mockReviewServer(PASS_BODY);
  const dir = repoWithReceipt({ brokenShape: true });
  try {
    const r = await run(dir, srv.base, "--phase", "verify");
    assert.equal(r.status, 1);
    assert.match(r.stdout, /REWORK/);
    assert.doesNotMatch(r.stdout, /REVIEW — awaiting explicit human approval/);
  } finally {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("phase verify + ci-pass + not-warranted → PASS", async () => {
  const srv = await mockReviewServer(PASS_BODY);
  const dir = repoWithReceipt();
  try {
    const r = await run(dir, srv.base, "--phase", "verify");
    assert.equal(r.status, 0, `a clean review with no rework should PASS\nstderr:\n${r.stderr}`);
    assert.match(r.stdout, /Plumbline: PASS/);
  } finally {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── phase full: REVIEW terminal behavior is unchanged ───────────────────────

test("phase full + review-warranted → REVIEW (terminal, unchanged)", async () => {
  const srv = await mockReviewServer(REVIEW_BODY);
  const dir = repoWithReceipt({ selfModifying: true });
  try {
    const r = await run(dir, srv.base, "--phase", "full");
    assert.equal(r.status, 1);
    assert.match(r.stdout, /REVIEW — awaiting explicit human approval/);
  } finally {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
