import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The #1 setup trap: the CLI used to hardcode `origin/main`, so `stamp`/`check`
// errored ("ambiguous argument origin/main") on repos whose default branch is
// `master`. This drives the REAL built CLI against a master-default repo and
// asserts base auto-detection resolves origin/master (no --base, no error).
const CLI = fileURLToPath(new URL("../cli.js", import.meta.url)); // dist/cli.js

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

test("stamp auto-detects a master default branch (no --base, no ambiguous-arg error)", () => {
  const root = mkdtempSync(join(tmpdir(), "proofgate-base-"));
  const repo = join(root, "repo");
  const origin = join(root, "origin.git");
  try {
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q", "--bare", "--initial-branch=master", origin]);
    git(repo, "init", "-q", "--initial-branch=master");
    git(repo, "config", "user.email", "t@t.dev");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "app.txt"), "v0\n");
    git(repo, "add", "."); git(repo, "commit", "-qm", "B0");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-q", "-u", "origin", "master");
    git(repo, "remote", "set-head", "origin", "master"); // refs/remotes/origin/HEAD → origin/master

    // a work branch with a real change + a per-PR receipt to stamp
    git(repo, "checkout", "-q", "-b", "work");
    writeFileSync(join(repo, "app.txt"), "v1\n");
    mkdirSync(join(repo, ".proofgate", "receipts"), { recursive: true });
    const rcpt = join(repo, ".proofgate", "receipts", "work.json");
    writeFileSync(rcpt, "{}\n");
    git(repo, "add", "."); git(repo, "commit", "-qm", "work");

    // No --base: must auto-detect origin/master and stamp a real hash.
    let stderr = "";
    try {
      execFileSync("node", [CLI, "stamp", "--cwd", repo, "--receipt", rcpt], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e: any) {
      stderr = String(e.stderr ?? e.message ?? e);
      throw new Error(`stamp failed (base auto-detect regression?): ${stderr}`);
    }
    assert.ok(!/ambiguous argument/i.test(stderr), "must not hit the origin/main ambiguous-argument trap");
    const stamped = JSON.parse(readFileSync(rcpt, "utf8"));
    assert.ok(typeof stamped.diff_sha256 === "string" && stamped.diff_sha256.length === 64, "stamp must write a real diff_sha256");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
