import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseDir, resolveDualPath, CANONICAL_DIR, LEGACY_DIR } from "../basedir.js";

test("baseDir: fresh repo gets the canonical .plumbline", () => {
  const dir = mkdtempSync(join(tmpdir(), "basedir-fresh-"));
  assert.equal(baseDir(dir), CANONICAL_DIR);
});

test("baseDir: legacy .proofgate repo keeps .proofgate (back-compat)", () => {
  const dir = mkdtempSync(join(tmpdir(), "basedir-legacy-"));
  mkdirSync(join(dir, LEGACY_DIR));
  assert.equal(baseDir(dir), LEGACY_DIR);
});

test("baseDir: .plumbline wins when both dirs exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "basedir-both-"));
  mkdirSync(join(dir, LEGACY_DIR));
  mkdirSync(join(dir, CANONICAL_DIR));
  assert.equal(baseDir(dir), CANONICAL_DIR);
});

test("resolveDualPath: canonical default falls back to the legacy twin (and vice versa)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dualpath-"));
  mkdirSync(join(dir, LEGACY_DIR, "receipts"), { recursive: true });
  // Neither file exists → path returned unchanged (caller errors normally).
  assert.equal(resolveDualPath(dir, ".plumbline/nope.json"), ".plumbline/nope.json");
  // Legacy twin exists → canonical default resolves to it.
  writeFileSync(join(dir, LEGACY_DIR, "policy.json"), "{}");
  assert.equal(resolveDualPath(dir, ".plumbline/policy.json"), ".proofgate/policy.json");
  // And vice versa: a legacy path resolves to the canonical twin when only that exists.
  mkdirSync(join(dir, CANONICAL_DIR), { recursive: true });
  writeFileSync(join(dir, CANONICAL_DIR, "MISSION.md"), "m");
  assert.equal(resolveDualPath(dir, ".proofgate/MISSION.md"), ".plumbline/MISSION.md");
  // Paths outside either dir pass through untouched.
  assert.equal(resolveDualPath(dir, "src/lib.rs"), "src/lib.rs");
});
