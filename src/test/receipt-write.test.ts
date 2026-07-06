import { test } from "node:test";
import assert from "node:assert/strict";
import {
  protectedHits,
  refreshMechanical,
  checkMechanical,
  type MechanicalFields,
} from "../receipt-write.js";

const GLOBS = ["**/auth/**", "migrations/**", ".github/workflows/**"];

function mech(over: Partial<MechanicalFields> = {}): MechanicalFields {
  return {
    diffSha256: "a".repeat(64),
    changedFiles: ["src/app.ts"],
    hits: [],
    ...over,
  };
}

test("protectedHits matches nested auth via **/auth/** (the SmileWise policy hole)", () => {
  const hits = protectedHits(["fastapi_app/auth/router.py", "src/ui.tsx"], GLOBS);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, "fastapi_app/auth/router.py");
  assert.equal(hits[0].glob, "**/auth/**");
});

test("protectedHits: root-level auth/** style miss is why the glob must be widened", () => {
  // Documenting the failure mode: a root-anchored glob does NOT match nested auth.
  assert.equal(protectedHits(["fastapi_app/auth/router.py"], ["auth/**"]).length, 0);
});

test("refreshMechanical updates hash+files, preserves judgment fields byte-for-byte", () => {
  const receipt: Record<string, unknown> = {
    receipt_version: "1.0",
    task_id: "84",
    intent: "My carefully written intent — the judgment half of the receipt, over 40 chars.",
    self_modifying: false,
    validation_plan: [{ command: "npx vitest run", reason: "asserts behavior", required: true }],
    execution_evidence: [{ command: "npx vitest run", status: "passed" }],
    changed_files: ["old.ts"],
    diff_sha256: "b".repeat(64),
    result_summary: "A human-authored summary of what shipped and how it was verified.",
  };
  const m = mech({ changedFiles: ["src/new.ts"] });
  const { receipt: out, changed, notes } = refreshMechanical(receipt, m);
  assert.equal(changed, true);
  assert.equal(out.diff_sha256, m.diffSha256);
  assert.deepEqual(out.changed_files, ["src/new.ts"]);
  // Judgment fields untouched:
  assert.equal(out.intent, receipt.intent);
  assert.deepEqual(out.validation_plan, receipt.validation_plan);
  assert.deepEqual(out.execution_evidence, receipt.execution_evidence);
  assert.equal(out.result_summary, receipt.result_summary);
  assert.ok(notes.length >= 2);
});

test("refreshMechanical upgrades self_modifying on protected hits, never silently downgrades", () => {
  const base = { diff_sha256: "a".repeat(64), changed_files: ["migrations/x.sql"], self_modifying: false };
  const withHit = mech({
    changedFiles: ["migrations/x.sql"],
    hits: [{ file: "migrations/x.sql", glob: "migrations/**" }],
  });
  const up = refreshMechanical({ ...base }, withHit);
  assert.equal(up.receipt.self_modifying, true);
  assert.ok(up.notes.some((n) => n.includes("migrations/x.sql")));

  // Voluntary true with no hits → preserved (author may be requesting review on purpose).
  const noHit = mech();
  const keep = refreshMechanical(
    { diff_sha256: noHit.diffSha256, changed_files: noHit.changedFiles, self_modifying: true },
    noHit,
  );
  assert.equal(keep.receipt.self_modifying, true);
  assert.equal(keep.changed, false);
  assert.ok(keep.notes.some((n) => n.includes("voluntary human-review request")));
});

test("checkMechanical reports staleness and missing self_modifying", () => {
  const m = mech({
    changedFiles: ["fastapi_app/auth/router.py"],
    hits: [{ file: "fastapi_app/auth/router.py", glob: "**/auth/**" }],
  });
  const stale = checkMechanical(
    { diff_sha256: "b".repeat(64), changed_files: [], self_modifying: false },
    m,
  );
  assert.equal(stale.fresh, false);
  assert.equal(stale.problems.length, 3);

  const fresh = checkMechanical(
    { diff_sha256: m.diffSha256, changed_files: m.changedFiles, self_modifying: true },
    m,
  );
  assert.equal(fresh.fresh, true);
});
