import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  shouldSkipReview,
  readReviewCache,
  writeReviewCache,
  resolveModel,
  protectedFloor,
} from "../cost.js";
import { PolicySchema, type Policy, type Receipt, type ReviewResult } from "../types.js";
import { semanticReview, PROMPT_VERSION } from "../review.js";
import type { ReviewProvider } from "../provider.js";

function receipt(overrides: Partial<Receipt> = {}): Receipt {
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
    ...overrides,
  } as Receipt;
}

function policy(overrides: Record<string, unknown> = {}): Policy {
  return PolicySchema.parse({ version: "1.0", protected_paths: ["src/**"], ...overrides });
}

// --- skip logic ---

test("shouldSkipReview: default policy never skips", () => {
  const d = shouldSkipReview(receipt(), policy(), "some diff");
  assert.equal(d.skip, false);
});

test("shouldSkipReview: docs_only skips a docs-only change", () => {
  const d = shouldSkipReview(
    receipt({ changed_files: ["README.md", "docs/x.md"] }),
    policy({ skip_review: { docs_only: true } }),
    "diff",
  );
  assert.equal(d.skip, true);
});

test("shouldSkipReview: docs_only does NOT skip when a code file is present", () => {
  const d = shouldSkipReview(
    receipt({ changed_files: ["README.md", "lib/foo.js"] }),
    policy({ skip_review: { docs_only: true } }),
    "diff",
  );
  assert.equal(d.skip, false);
});

test("shouldSkipReview: config_only skips json/yaml changes", () => {
  const d = shouldSkipReview(
    receipt({ changed_files: ["package.json", "tsconfig.json"] }),
    policy({ skip_review: { config_only: true } }),
    "diff",
  );
  assert.equal(d.skip, true);
});

test("shouldSkipReview: below_diff_chars skips a small diff", () => {
  const d = shouldSkipReview(
    receipt({ changed_files: ["lib/foo.js"] }),
    policy({ skip_review: { below_diff_chars: 100 } }),
    "tiny",
  );
  assert.equal(d.skip, true);
});

test("shouldSkipReview: below_diff_chars does NOT skip a large diff", () => {
  const d = shouldSkipReview(
    receipt({ changed_files: ["lib/foo.js"] }),
    policy({ skip_review: { below_diff_chars: 5 } }),
    "this diff is longer than five chars",
  );
  assert.equal(d.skip, false);
});

test("shouldSkipReview: HARD FLOOR — self_modifying is never skipped", () => {
  const d = shouldSkipReview(
    receipt({ self_modifying: true, changed_files: ["README.md"] }),
    policy({ skip_review: { docs_only: true } }),
    "diff",
  );
  assert.equal(d.skip, false);
  assert.match(d.reason, /self_modifying/);
});

test("shouldSkipReview: HARD FLOOR — protected path is never skipped even if docs-only elsewhere", () => {
  const d = shouldSkipReview(
    // a protected file that also looks docs-ish should still trip the floor
    receipt({ changed_files: ["src/shape.ts"], self_modifying: false }),
    policy({ protected_paths: ["src/**"], skip_review: { docs_only: true, config_only: true, below_diff_chars: 100000 } }),
    "diff",
  );
  assert.equal(d.skip, false);
  assert.match(d.reason, /protected/);
});

// --- resolveModel (budget tier) ---

test("resolveModel: uses review_model by default", () => {
  assert.equal(resolveModel(policy({ review_model: "big" })), "big");
});

test("resolveModel: uses cheap_model when budget.use_cheap_model", () => {
  const p = policy({ review_model: "big", budget: { use_cheap_model: true, cheap_model: "cheap" } });
  assert.equal(resolveModel(p), "cheap");
});

test("resolveModel: use_cheap_model without a cheap_model set falls back to review_model", () => {
  const p = policy({ review_model: "big", budget: { use_cheap_model: true } });
  assert.equal(resolveModel(p), "big");
});

// --- budget soft-cap parses and is available (#8) ---

test("policy: budget.max_usd_per_pr soft cap parses (0 default = no cap)", () => {
  assert.equal(policy().budget.max_usd_per_pr, 0);
  assert.equal(policy({ budget: { max_usd_per_pr: 2.5 } }).budget.max_usd_per_pr, 2.5);
});

// --- redundant protected floor (#4) ---

test("protectedFloor: self_modifying receipt always hits the floor", () => {
  const hit = protectedFloor(receipt({ self_modifying: true, changed_files: ["README.md"] }), policy(), []);
  assert.match(String(hit), /self_modifying/);
});

test("protectedFloor: a protected file in the ACTUAL diff hits, even if the receipt hid it", () => {
  // Receipt self-reports only a benign file; the real diff touches a protected path.
  const hit = protectedFloor(
    receipt({ self_modifying: false, changed_files: ["README.md"] }),
    policy({ protected_paths: ["src/**"] }),
    ["src/cli.ts"],
  );
  assert.match(String(hit), /src\/cli\.ts.*src\/\*\*/);
});

test("protectedFloor: a protected file declared in the receipt hits too", () => {
  const hit = protectedFloor(
    receipt({ self_modifying: false, changed_files: ["src/shape.ts"] }),
    policy({ protected_paths: ["src/**"] }),
    [],
  );
  assert.match(String(hit), /src\/shape\.ts/);
});

test("protectedFloor: ordinary change returns null (no floor)", () => {
  const hit = protectedFloor(
    receipt({ self_modifying: false, changed_files: ["README.md"] }),
    policy({ protected_paths: ["src/**"] }),
    ["docs/x.md"],
  );
  assert.equal(hit, null);
});

// --- cache ---

test("cache: write then read returns the verdict for identical diff_sha256/provider/model", () => {
  const dir = mkdtempSync(join(tmpdir(), "pl-cache-"));
  try {
    const rv: ReviewResult = {
      verdict: "approve",
      confidence: 0.95,
      validation_coverage_notes: "a",
      mission_alignment_notes: "b",
      risk_notes: "c",
    };
    const sha = "b".repeat(64);
    writeReviewCache(dir, sha, "anthropic", "m1", PROMPT_VERSION, rv);
    const hit = readReviewCache(dir, sha, "anthropic", "m1", PROMPT_VERSION);
    assert.equal(hit?.verdict, "approve");
    assert.equal(hit?.confidence, 0.95);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cache: miss on different model / prompt version / sha", () => {
  const dir = mkdtempSync(join(tmpdir(), "pl-cache-"));
  try {
    const rv: ReviewResult = {
      verdict: "approve",
      confidence: 0.9,
      validation_coverage_notes: "a",
      mission_alignment_notes: "b",
      risk_notes: "c",
    };
    const sha = "c".repeat(64);
    writeReviewCache(dir, sha, "anthropic", "m1", PROMPT_VERSION, rv);
    assert.equal(readReviewCache(dir, sha, "anthropic", "m2", PROMPT_VERSION), null, "different model misses");
    assert.equal(readReviewCache(dir, sha, "openai", "m1", PROMPT_VERSION), null, "different provider misses");
    assert.equal(readReviewCache(dir, sha, "anthropic", "m1", "v999"), null, "different prompt version misses");
    assert.equal(readReviewCache(dir, "d".repeat(64), "anthropic", "m1", PROMPT_VERSION), null, "different sha misses");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cache: read on empty dir returns null (no throw)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pl-cache-"));
  try {
    assert.equal(readReviewCache(dir, "e".repeat(64), "anthropic", "m1", PROMPT_VERSION), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- semanticReview via injected provider (provider-independent verdict + audit) ---

test("semanticReview: uses injected provider and records audit metadata", async () => {
  const okJson =
    '{"verdict":"approve","confidence":0.9,"validation_coverage_notes":"a","mission_alignment_notes":"b","risk_notes":"c"}';
  let sawTemp: number | undefined;
  const fake: ReviewProvider = {
    id: "openai",
    async complete(req) {
      sawTemp = req.temperature;
      return okJson;
    },
  };
  const r = await semanticReview("mission", receipt(), "diff", policy({ review_model: "m1", review_temperature: 0 }), fake);
  assert.equal(r.verdict, "approve");
  assert.equal(r.audit?.provider, "openai");
  assert.equal(r.audit?.model, "m1");
  assert.equal(r.audit?.prompt_version, PROMPT_VERSION);
  assert.equal(sawTemp, 0, "low temperature pinned for determinism");
});

test("semanticReview: self_modifying can never auto-approve (floor preserved through refactor)", async () => {
  const okJson =
    '{"verdict":"approve","confidence":0.99,"validation_coverage_notes":"a","mission_alignment_notes":"b","risk_notes":"c"}';
  const fake: ReviewProvider = { id: "anthropic", async complete() { return okJson; } };
  const r = await semanticReview("m", receipt({ self_modifying: true }), "diff", policy(), fake);
  assert.equal(r.verdict, "review");
});
