import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitDiffExcludingReceipt, computeDiffSha256 } from "../shape.js";

// Pins the receipt-binding diff formula so it can never silently drift from
// what the CI gate computes (the gate runs this exact function via `cli.js run`).
// The contract: `git diff <base>...HEAD` (3-dot / merge-base), over the
// COMMITTED HEAD, excluding the receipt file(s). NOT 2-dot, NOT --cached, NOT
// the working tree. A local `plumb stamp`/`check` therefore matches CI.
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

test("gitDiffExcludingReceipt is 3-dot, committed-HEAD, receipt-excluded", () => {
  const dir = mkdtempSync(join(tmpdir(), "plumbline-diff-"));
  try {
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "t@t.dev");
    git(dir, "config", "user.name", "t");
    git(dir, "checkout", "-q", "-b", "base");

    // base commit B0
    writeFileSync(join(dir, "app.txt"), "v0\n");
    git(dir, "add", "."); git(dir, "commit", "-qm", "B0");

    // work branch off B0: real change + a per-PR receipt file
    git(dir, "checkout", "-q", "-b", "work");
    writeFileSync(join(dir, "app.txt"), "v1\n");
    mkdirSync(join(dir, ".proofgate", "receipts"), { recursive: true });
    writeFileSync(join(dir, ".proofgate", "receipts", "work.json"), '{"task_id":"work"}\n');
    git(dir, "add", "."); git(dir, "commit", "-qm", "work");

    // base advances AFTER the branch point (only reachable from base, not HEAD)
    git(dir, "checkout", "-q", "base");
    writeFileSync(join(dir, "base-only.txt"), "x\n");
    git(dir, "add", "."); git(dir, "commit", "-qm", "B1");
    git(dir, "checkout", "-q", "work");

    const d1 = gitDiffExcludingReceipt("base", dir);
    // includes the real change …
    assert.match(d1, /app\.txt/);
    assert.match(d1, /\+v1/);
    // … excludes the receipt file …
    assert.ok(!d1.includes("receipts/work.json"), "receipt file must be excluded from the binding diff");
    // … and excludes base-only changes → proves 3-dot (merge-base), not 2-dot.
    assert.ok(!d1.includes("base-only.txt"), "3-dot diff must not include commits only on base");

    const h1 = computeDiffSha256(d1);

    // Uncommitted working-tree edit must NOT change the hash → proves the gate
    // binds the COMMITTED HEAD, not the working tree / index. (This is exactly
    // the trap: hand-computing with `git diff --cached` gives a different hash.)
    writeFileSync(join(dir, "app.txt"), "v2-uncommitted\n");
    const h2 = computeDiffSha256(gitDiffExcludingReceipt("base", dir));
    assert.equal(h2, h1, "uncommitted changes must not affect the committed-HEAD binding");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
