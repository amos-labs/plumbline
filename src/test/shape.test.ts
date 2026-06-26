import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeCheck, commandMatchesCheck, evidenceSatisfiesStep, computeDiffSha256, isReceiptPath } from "../shape.js";
import { globToRegExp, matchesAny } from "../glob.js";
import { PolicySchema } from "../types.js";

test("isReceiptPath: recognizes legacy + per-PR receipts, nothing else", () => {
  assert.ok(isReceiptPath(".proofgate/receipt.json"));
  assert.ok(isReceiptPath(".proofgate/receipts/mcp-oauth.json"));
  assert.ok(isReceiptPath(".proofgate/receipts/ISSUE-42.json"));
  assert.ok(!isReceiptPath(".proofgate/policy.json"));
  assert.ok(!isReceiptPath(".proofgate/receipts/nested/x.json"));
  assert.ok(!isReceiptPath("app/models/user.rb"));
});

const policy = PolicySchema.parse({
  version: "1.0",
  required_checks: ["bundle exec rspec"],
  protected_paths: [
    "db/migrate/**",
    "app/models/invoice*",
    "app/controllers/**/stripe*",
    ".proofgate/**",
  ],
});

function validReceipt(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    receipt_version: "1.0",
    task_id: "TEST-1",
    agent_id: "test-agent",
    intent: "A perfectly reasonable change with an intent long enough to pass the schema.",
    self_modifying: false,
    policy_refs: [".proofgate/MISSION.md"],
    validation_plan: [
      { command: "bundle exec rspec spec/models/foo_spec.rb", reason: "covers the change", required: true },
      { command: "bundle exec rspec", reason: "full suite", required: true },
    ],
    execution_evidence: [
      { command: "bundle exec rspec spec/models/foo_spec.rb", status: "passed", output_ref: "3 examples, 0 failures" },
      { command: "bundle exec rspec", status: "passed", output_ref: "100 examples, 0 failures" },
    ],
    changed_files: ["app/models/foo.rb", "spec/models/foo_spec.rb"],
    diff_sha256: computeDiffSha256("fake diff"),
    result_summary: "Did the reasonable change and validated it with model specs plus the full suite.",
    ...overrides,
  });
}

test("valid receipt passes (skipGit)", () => {
  const { result } = shapeCheck(validReceipt(), policy, { skipGit: true });
  assert.deepEqual(result.errors, []);
  assert.equal(result.pass, true);
});

test("invalid JSON fails", () => {
  const { result } = shapeCheck("{nope", policy, { skipGit: true });
  assert.equal(result.pass, false);
});

test("missing required check fails", () => {
  const receipt = validReceipt({
    validation_plan: [{ command: "rubocop", reason: "style", required: true }],
    execution_evidence: [{ command: "rubocop", status: "passed" }],
  });
  const { result } = shapeCheck(receipt, policy, { skipGit: true });
  assert.ok(result.errors.some((e) => e.includes('required check missing')));
});

test("a quoted/echoed command does not satisfy a required check", () => {
  const receipt = validReceipt({
    validation_plan: [{ command: 'echo "bundle exec rspec"', reason: "sneaky", required: true }],
    execution_evidence: [{ command: 'echo "bundle exec rspec"', status: "passed" }],
  });
  const { result } = shapeCheck(receipt, policy, { skipGit: true });
  assert.ok(result.errors.some((e) => e.includes('required check missing')));
});

test("evidenceSatisfiesStep: exact + trailing annotation match; args/subsets do NOT", () => {
  // Exact, and trailing-whitespace tolerant.
  assert.ok(evidenceSatisfiesStep("bundle exec rspec spec/foo_spec.rb", "bundle exec rspec spec/foo_spec.rb"));
  assert.ok(evidenceSatisfiesStep("  bundle exec rspec  ", "bundle exec rspec"));
  // Trailing parenthetical / # annotation is allowed.
  assert.ok(evidenceSatisfiesStep("bundle exec rspec spec/foo_spec.rb  (re-ran stashed)", "bundle exec rspec spec/foo_spec.rb"));
  assert.ok(evidenceSatisfiesStep("bundle exec rspec # 3 examples, 0 failures", "bundle exec rspec"));
  // Extra ARGS must NOT satisfy a broader step — that would let a narrower run
  // (or a passing partial) stand in for, or mask, the required broader command.
  assert.ok(!evidenceSatisfiesStep("bundle exec rspec spec/foo_spec.rb", "bundle exec rspec"));
  assert.ok(!evidenceSatisfiesStep("bundle exec rspec spec/foo_spec.rb --format doc", "bundle exec rspec spec/foo_spec.rb"));
  // A different command is never evidence.
  assert.ok(!evidenceSatisfiesStep("bundle exec rspec spec/foo_spec.rb", "bundle exec rspec spec/bar_spec.rb"));
});

test("evidence with a trailing annotation still satisfies a required step", () => {
  const receipt = validReceipt({
    execution_evidence: [
      { command: "bundle exec rspec spec/models/foo_spec.rb (and again with the fix stashed)", status: "passed", output_ref: "3 examples, 0 failures" },
      { command: "bundle exec rspec", status: "passed", output_ref: "100 examples, 0 failures" },
    ],
  });
  const { result } = shapeCheck(receipt, policy, { skipGit: true });
  assert.deepEqual(result.errors, []);
  assert.equal(result.pass, true);
});

test("required step with failed evidence fails", () => {
  const receipt = validReceipt({
    execution_evidence: [
      { command: "bundle exec rspec spec/models/foo_spec.rb", status: "passed" },
      { command: "bundle exec rspec", status: "failed" },
    ],
  });
  const { result } = shapeCheck(receipt, policy, { skipGit: true });
  assert.ok(result.errors.some((e) => e.includes('has status "failed"')));
});

test("protected path without self_modifying fails", () => {
  const receipt = validReceipt({ changed_files: ["db/migrate/20260101_x.rb"] });
  const { result } = shapeCheck(receipt, policy, { skipGit: true });
  assert.ok(result.errors.some((e) => e.includes("self_modifying is false")));
});

test("protected path with self_modifying true passes the protected check", () => {
  const receipt = validReceipt({ changed_files: ["db/migrate/20260101_x.rb"], self_modifying: true });
  const { result } = shapeCheck(receipt, policy, { skipGit: true });
  assert.equal(result.pass, true);
});

test("commandMatchesCheck: boundaries", () => {
  assert.equal(commandMatchesCheck("bundle exec rspec spec/x_spec.rb", "bundle exec rspec"), true);
  assert.equal(commandMatchesCheck("bundle exec rspec", "bundle exec rspec"), true);
  assert.equal(commandMatchesCheck('echo "bundle exec rspec"', "bundle exec rspec"), false);
  assert.equal(commandMatchesCheck("xbundle exec rspec", "bundle exec rspec"), false);
});

test("computeDiffSha256 is stable and hex", () => {
  const h = computeDiffSha256("diff --git a/x b/x\n");
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, computeDiffSha256("diff --git a/x b/x\n"));
  assert.notEqual(h, computeDiffSha256("different"));
});

test("glob: prefix wildcards do not over-match siblings", () => {
  assert.ok(matchesAny("app/models/invoice.rb", policy.protected_paths));
  assert.ok(matchesAny("app/models/invoice_item.rb", policy.protected_paths));
  assert.equal(matchesAny("app/models/course_pool_invoice.rb", policy.protected_paths), null);
});

test("glob: ** spans directories", () => {
  assert.ok(globToRegExp("db/migrate/**").test("db/migrate/2026/x.rb"));
  assert.ok(globToRegExp("app/controllers/**/stripe*").test("app/controllers/webhooks/stripe_events_controller.rb"));
  assert.ok(globToRegExp("app/controllers/**/stripe*").test("app/controllers/stripe_events_controller.rb"));
  assert.equal(globToRegExp("db/migrate/**").test("db/schema.rb"), false);
});
