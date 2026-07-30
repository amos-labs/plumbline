import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gitDiffExcludingReceiptFrom,
  computeDiffSha256,
  diffBindings,
  diffMatches,
  DIFF_ALGO_CURRENT,
} from "../shape.js";

/**
 * Regression cover for amos-labs/plumbline#69.
 *
 * `git diff` output is NOT a pure function of the tree — it varies with the
 * machine's git config. Because the receipt binding is a sha256 over that
 * output, a differing `core.abbrev` or `diff.algorithm` on the stamping machine
 * produced a hash the gate could not reproduce: local pre-flight PASS, CI FAIL,
 * surfacing as a generic "receipt fumble".
 *
 * Observed in the wild on NuvolaNetworks/cuspr: the stamped hash a973ec40… is
 * exactly what `core.abbrev=7` yields for a tree the gate hashed as 401688b5….
 * Six PRs blocked; the content was byte-identical throughout.
 *
 * These tests assert the binding is now invariant under every config knob known
 * to change diff output, and that legacy receipts still verify.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A repo with a base commit and a work commit carrying a multi-hunk change. */
function makeRepo(): { dir: string; baseSha: string } {
  const dir = mkdtempSync(join(tmpdir(), "plumbline-hermetic-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t.dev");
  git(dir, "config", "user.name", "t");

  // Enough lines that hunk-splitting choices (algorithm, context, indent
  // heuristic) actually have room to differ.
  const base = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") + "\n";
  writeFileSync(join(dir, "app.txt"), base);
  writeFileSync(join(dir, "keep.txt"), "unchanged\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
  const baseSha = git(dir, "rev-parse", "HEAD").trim();

  const edited = base
    .replace("line 3", "line 3 CHANGED")
    .replace("line 20", "line 20 CHANGED")
    .replace("line 37", "line 37 CHANGED");
  writeFileSync(join(dir, "app.txt"), edited);
  mkdirSync(join(dir, ".plumbline", "receipts"), { recursive: true });
  writeFileSync(join(dir, ".plumbline", "receipts", "work.json"), '{"task_id":"work"}\n');
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "work");

  return { dir, baseSha };
}

/** Every knob that measurably changes `git diff` bytes for an identical tree. */
const HOSTILE_CONFIGS: Array<[string, string]> = [
  ["core.abbrev", "7"], // the exact knob that broke cuspr
  ["core.abbrev", "12"],
  ["core.abbrev", "40"],
  ["diff.algorithm", "histogram"],
  ["diff.algorithm", "patience"],
  ["diff.algorithm", "minimal"],
  ["diff.context", "1"],
  ["diff.context", "7"],
  ["diff.noprefix", "true"],
  ["diff.mnemonicPrefix", "true"],
  ["diff.indentHeuristic", "false"],
  ["diff.renames", "false"],
  ["diff.suppressBlankEmpty", "true"],
  ["diff.relative", "true"],
];

test("v1 binding is invariant under every git config knob that changes diff output", () => {
  const { dir, baseSha } = makeRepo();
  try {
    const expected = computeDiffSha256(gitDiffExcludingReceiptFrom(baseSha, dir));

    for (const [key, value] of HOSTILE_CONFIGS) {
      git(dir, "config", key, value);
      const got = computeDiffSha256(gitDiffExcludingReceiptFrom(baseSha, dir));
      assert.equal(
        got,
        expected,
        `hermetic binding drifted under ${key}=${value} — this is exactly the #69 failure`,
      );
      git(dir, "config", "--unset", key);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the LEGACY binding really does drift — proving the bug this fixes was real", () => {
  const { dir, baseSha } = makeRepo();
  try {
    const clean = diffBindings(`${baseSha}..HEAD`, dir).legacy;

    // NOTE: `core.abbrev=7` — the value that actually broke cuspr — is a NO-OP
    // here, because git's default abbrev is auto-scaled by object count and a
    // fresh fixture repo already abbreviates to 7. It only diverges in a repo
    // large enough to need more digits. That asymmetry is precisely why this
    // class of bug survived a test suite built on small fixtures, so assert
    // with a length that differs regardless of repo size.
    git(dir, "config", "core.abbrev", "40");
    const abbrev40 = diffBindings(`${baseSha}..HEAD`, dir).legacy;
    git(dir, "config", "--unset", "core.abbrev");

    git(dir, "config", "diff.context", "7");
    const context7 = diffBindings(`${baseSha}..HEAD`, dir).legacy;

    // diff.algorithm is deliberately NOT asserted here: on a fixture of simple
    // single-line replacements every algorithm emits identical hunks, so it
    // would be a flaky witness. It does diverge on real diffs (it did on cuspr),
    // and test 1 asserts the hermetic hash is invariant under histogram and
    // patience regardless — which is the direction that matters.
    //
    // If these ever become equal the fixture stopped exercising the bug.
    assert.notEqual(abbrev40, clean, "core.abbrev no longer affects the legacy hash");
    assert.notEqual(context7, clean, "diff.context no longer affects the legacy hash");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("diff_algo=v1 receipts verify against the hermetic hash only", () => {
  const { dir, baseSha } = makeRepo();
  try {
    const { v1, legacy } = diffBindings(`${baseSha}..HEAD`, dir);
    const range = `${baseSha}..HEAD`;

    const ok = diffMatches(v1, range, dir, DIFF_ALGO_CURRENT);
    assert.ok(ok.matched);
    assert.equal(ok.matchedLegacy, false);

    // A v1 receipt must NOT be satisfied by a legacy hash — under v1 that is a
    // genuine difference, not a config artefact.
    if (legacy !== v1) {
      assert.equal(diffMatches(legacy, range, dir, DIFF_ALGO_CURRENT).matched, false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy receipts (no diff_algo) still verify under either binding", () => {
  const { dir, baseSha } = makeRepo();
  try {
    const { v1, legacy } = diffBindings(`${baseSha}..HEAD`, dir);
    const range = `${baseSha}..HEAD`;

    const asV1 = diffMatches(v1, range, dir, undefined);
    assert.ok(asV1.matched, "hermetic hash must verify for an unstamped receipt");
    assert.equal(asV1.matchedLegacy, false);

    const asLegacy = diffMatches(legacy, range, dir, undefined);
    assert.ok(asLegacy.matched, "legacy hash must still verify — no fleet-wide REWORK");
    if (legacy !== v1) {
      assert.ok(asLegacy.matchedLegacy, "a legacy-only match must be flagged for re-stamp");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a real content change still fails under both algorithms", () => {
  const { dir, baseSha } = makeRepo();
  try {
    const range = `${baseSha}..HEAD`;
    const { v1 } = diffBindings(range, dir);

    writeFileSync(join(dir, "app.txt"), "totally different\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "tamper");

    assert.equal(diffMatches(v1, range, dir, DIFF_ALGO_CURRENT).matched, false);
    assert.equal(diffMatches(v1, range, dir, undefined).matched, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
