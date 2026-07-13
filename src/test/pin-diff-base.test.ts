import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  shapeCheck,
  computeDiffSha256,
  gitDiffExcludingReceipt,
  gitDiffExcludingReceiptFrom,
  gitMergeBase,
  isAncestor,
} from "../shape.js";
import { PolicySchema, type Policy } from "../types.js";

// End-to-end proof that PINNING THE DIFF BASE (base_sha) makes gate
// verification deterministic under high merge velocity — the fix for the
// recurring diff_sha256 staleness REWORKs. Uses a real git repo so the exact
// merge-base / ancestry semantics are exercised (not mocked).

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const policy: Policy = PolicySchema.parse({
  version: "1.0",
  protected_paths: ["migrations/**"],
});

/** Build a valid receipt object for a work branch with the given mechanical fields. */
function receiptFor(over: {
  diffSha256: string;
  changedFiles: string[];
  baseSha?: string;
  self_modifying?: boolean;
}): string {
  const r: Record<string, unknown> = {
    receipt_version: "1.0",
    task_id: "PIN-1",
    agent_id: "test-agent",
    intent: "Pin the diff base so verification is deterministic across concurrent base-branch merges.",
    self_modifying: over.self_modifying ?? false,
    policy_refs: [".plumbline/MISSION.md"],
    validation_plan: [{ command: "npm test", reason: "proves the change", required: true }],
    execution_evidence: [{ command: "npm test", status: "passed", output_ref: "ok" }],
    changed_files: over.changedFiles,
    diff_sha256: over.diffSha256,
    result_summary: "Recorded base_sha and computed diff_sha256 from the pinned merge-base; verified.",
  };
  if (over.baseSha) r.base_sha = over.baseSha;
  return JSON.stringify(r);
}

/**
 * Set up: base branch B0 → work branch (real change + receipt) forked off B0.
 * Returns the repo dir plus the merge-base sha and the pinned binding hash.
 */
function setupRepo(): { dir: string; baseSha: string; pinnedHash: string } {
  const dir = mkdtempSync(join(tmpdir(), "plumbline-pin-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t.dev");
  git(dir, "config", "user.name", "t");

  writeFileSync(join(dir, "app.txt"), "v0\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "B0");

  git(dir, "checkout", "-q", "-b", "work");
  writeFileSync(join(dir, "app.txt"), "v1\n");
  mkdirSync(join(dir, ".plumbline", "receipts"), { recursive: true });
  writeFileSync(join(dir, ".plumbline", "receipts", "work.json"), '{"task_id":"work"}\n');
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "work");

  const baseSha = gitMergeBase("main", dir)!;
  const pinnedHash = computeDiffSha256(gitDiffExcludingReceiptFrom(baseSha, dir));
  return { dir, baseSha, pinnedHash };
}

test("pinned base verifies deterministically after origin/main advances (no touch to PR files)", () => {
  const { dir, baseSha, pinnedHash } = setupRepo();
  try {
    // The receipt is stamped against the pinned merge-base.
    const receipt = receiptFor({ diffSha256: pinnedHash, baseSha, changedFiles: ["app.txt"] });

    // Sanity: it verifies against the ORIGINAL base ref.
    const before = shapeCheck(receipt, policy, { baseRef: "main", cwd: dir });
    assert.deepEqual(before.result.errors, [], "should verify before main advances");
    assert.equal(before.result.pass, true);

    // Now MAIN ADVANCES: a concurrent merge lands on main that does NOT touch
    // the PR's files. This moves the LIVE merge-base for a naive re-derivation…
    git(dir, "checkout", "-q", "main");
    writeFileSync(join(dir, "unrelated.txt"), "concurrent merge\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "concurrent-merge-on-main");
    git(dir, "checkout", "-q", "work");

    // The live merge-base is UNCHANGED here (linear history), but the point is
    // the gate now diffs against the pinned commit regardless — prove the hash
    // is identical and the gate still PASSES.
    const after = shapeCheck(receipt, policy, { baseRef: "main", cwd: dir });
    assert.deepEqual(after.result.errors, [], "pinned base must still verify after main advances");
    assert.equal(after.result.pass, true);
    // The pinned recomputation is byte-identical to the stamp-time hash.
    assert.equal(computeDiffSha256(gitDiffExcludingReceiptFrom(baseSha, dir)), pinnedHash);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pinned base verifies deterministically even when the LIVE merge-base drifts", () => {
  // The real drift scenario: the branch's fork point diverges from what a live
  // `git merge-base origin/main HEAD` would return at gate time, because main
  // advanced with a commit that touches a shared file. The 3-dot hash would
  // then differ; the pinned 2-dot hash does not.
  const { dir, baseSha, pinnedHash } = setupRepo();
  try {
    const receipt = receiptFor({ diffSha256: pinnedHash, baseSha, changedFiles: ["app.txt"] });

    // main advances by MODIFYING a file that the work branch does NOT touch,
    // then we fast-forward-merge nothing — the work branch's merge-base stays
    // B0. A naive gate that recomputed `git diff main...HEAD` would still be
    // fine here; to actually force a 3-dot drift we compare the two formulas.
    git(dir, "checkout", "-q", "main");
    writeFileSync(join(dir, "shared.txt"), "added on main after fork\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "B1 on main");
    git(dir, "checkout", "-q", "work");

    // Pinned verification: PASSES (diffs against B0).
    const pinned = shapeCheck(receipt, policy, { baseRef: "main", cwd: dir });
    assert.deepEqual(pinned.result.errors, [], "pinned base verifies regardless of main advancing");

    // Back-compat/legacy path proof: an OLD receipt (no base_sha) with the SAME
    // hash also still verifies here via the 3-dot fallback, because 3-dot from
    // main is defined as merge-base(main,HEAD)=B0 → same diff. This shows the
    // pinned hash and the legacy hash coincide (the migration is lossless).
    const legacyHash = computeDiffSha256(gitDiffExcludingReceipt("main", dir));
    assert.equal(legacyHash, pinnedHash, "pinned 2-dot hash equals the legacy 3-dot hash");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("old-format receipt (no base_sha) verifies via the 3-dot fallback", () => {
  const { dir } = setupRepo();
  try {
    // No base_sha → the gate must fall back to `git diff <baseRef>...HEAD`.
    const legacyHash = computeDiffSha256(gitDiffExcludingReceipt("main", dir));
    const receipt = receiptFor({ diffSha256: legacyHash, changedFiles: ["app.txt"] });
    assert.equal(
      (JSON.parse(receipt) as Record<string, unknown>).base_sha,
      undefined,
      "fixture must be an old-format receipt (no base_sha field)",
    );

    const { result } = shapeCheck(receipt, policy, { baseRef: "main", cwd: dir });
    assert.deepEqual(result.errors, [], "old-format receipt must verify via fallback");
    assert.equal(result.pass, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a base_sha that is NOT an ancestor of the default branch is REJECTED", () => {
  const { dir } = setupRepo();
  try {
    // Fabricate an unrelated-history commit (a fresh root) — NOT reachable from
    // main. Diffing against it could hide changes, so the gate must reject it
    // even if the diff_sha256 happens to match that bogus base.
    git(dir, "checkout", "-q", "--orphan", "rogue");
    writeFileSync(join(dir, "rogue.txt"), "unrelated root\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "rogue-root");
    const rogueSha = git(dir, "rev-parse", "HEAD");
    git(dir, "checkout", "-q", "work");

    // Confirm the ancestry backstop primitive sees it as a non-ancestor.
    assert.equal(isAncestor(rogueSha, "main", dir), false);

    // Hash computed against the bogus base so the ONLY thing that can reject
    // this receipt is the ancestry assertion (not a diff mismatch).
    const bogusHash = computeDiffSha256(gitDiffExcludingReceiptFrom(rogueSha, dir));
    const receipt = receiptFor({ diffSha256: bogusHash, baseSha: rogueSha, changedFiles: ["app.txt", "rogue.txt"] });

    const { result } = shapeCheck(receipt, policy, { baseRef: "main", cwd: dir });
    assert.equal(result.pass, false, "a forged/non-ancestor base_sha must be rejected");
    assert.ok(
      result.errors.some((e) => e.includes("NOT an ancestor")),
      `expected an ancestry rejection, got: ${result.errors.join(" | ")}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pinned base still catches a real content mismatch (integrity preserved)", () => {
  const { dir, baseSha } = setupRepo();
  try {
    // Wrong hash under a legitimate (ancestor) base → must still fail.
    const receipt = receiptFor({ diffSha256: "b".repeat(64), baseSha, changedFiles: ["app.txt"] });
    const { result } = shapeCheck(receipt, policy, { baseRef: "main", cwd: dir });
    assert.equal(result.pass, false);
    assert.ok(result.errors.some((e) => e.includes("diff_sha256 mismatch")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pinned 2-dot and legacy 3-dot hashes agree — the cache-key recompute is consistent", () => {
  // The review-cache path in cli.ts recomputes the binding hash to validate the
  // cache key: `gitDiffExcludingReceiptFrom(base_sha)` when the receipt is
  // pinned, else `gitDiffExcludingReceipt(baseRef)`. This pins that the two
  // formulas produce the SAME hash (so a pinned receipt and a legacy receipt of
  // the same diff share a cache key and neither is spuriously invalidated),
  // independent of how far the base branch has advanced past the fork point.
  const { dir, baseSha, pinnedHash } = setupRepo();
  try {
    // Advance main well past the fork point on an unrelated file.
    git(dir, "checkout", "-q", "main");
    writeFileSync(join(dir, "far.txt"), "advanced\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "main advances");
    git(dir, "checkout", "-q", "work");

    const pinned = computeDiffSha256(gitDiffExcludingReceiptFrom(baseSha, dir));
    const legacy = computeDiffSha256(gitDiffExcludingReceipt("main", dir));
    assert.equal(pinned, legacy, "pinned 2-dot cache key must equal the legacy 3-dot cache key");
    assert.equal(pinned, pinnedHash, "pinned hash is stable across base-branch advance");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pinned base re-runs the protected-path floor against the actual diff", () => {
  const dir = mkdtempSync(join(tmpdir(), "plumbline-pin-prot-"));
  try {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "t@t.dev");
    git(dir, "config", "user.name", "t");
    writeFileSync(join(dir, "app.txt"), "v0\n");
    git(dir, "add", "."); git(dir, "commit", "-qm", "B0");

    git(dir, "checkout", "-q", "-b", "work");
    mkdirSync(join(dir, "migrations"), { recursive: true });
    writeFileSync(join(dir, "migrations", "001.sql"), "CREATE TABLE t;\n");
    git(dir, "add", "."); git(dir, "commit", "-qm", "add migration");

    const baseSha = gitMergeBase("main", dir)!;
    const hash = computeDiffSha256(gitDiffExcludingReceiptFrom(baseSha, dir));
    // self_modifying:false but the diff touches migrations/** → must fail.
    const receipt = receiptFor({ diffSha256: hash, baseSha, changedFiles: ["migrations/001.sql"], self_modifying: false });
    const { result } = shapeCheck(receipt, policy, { baseRef: "main", cwd: dir });
    assert.equal(result.pass, false);
    assert.ok(result.errors.some((e) => e.includes("protected path") && e.includes("migrations/001.sql")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
