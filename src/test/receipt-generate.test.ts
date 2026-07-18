import { test } from "node:test";
import assert from "node:assert/strict";
import { generateReceipt } from "../receipt-generate.js";
import { shapeCheck } from "../shape.js";
import { PolicySchema } from "../types.js";

const SHA = "a".repeat(64);
const policy = (protectedPaths: string[], ci: string[] = ["test"]) =>
  PolicySchema.parse({ version: "1.0", protected_paths: protectedPaths, ci_evidence_checks: ci });

test("generateReceipt: non-protected change → self_modifying false, shape-valid", () => {
  const r = generateReceipt({
    taskId: "feat-x",
    agentId: "mcp-agent",
    intent: "Liz asked to change the homepage hero copy to the new tagline.",
    changedFiles: ["src/pages/home.tsx"],
    diffSha256: SHA,
    protectedPaths: [".plumbline/**", "**/auth/**"],
    ciEvidenceChecks: ["test"],
  });
  assert.equal(r.self_modifying, false);
  // Shape-valid under the same schema/gate (git checks skipped).
  const { result, receipt } = shapeCheck(JSON.stringify(r), policy([".plumbline/**", "**/auth/**"]), {
    skipGit: true,
  });
  assert.ok(result.pass, `shape should pass: ${result.errors.join("; ")}`);
  assert.ok(receipt);
});

test("generateReceipt: protected-path change → self_modifying true (auto-detected)", () => {
  const r = generateReceipt({
    taskId: "feat-auth",
    agentId: "mcp-agent",
    intent: "Change the login authorization check so admins can impersonate users.",
    changedFiles: ["src/auth/login.ts"],
    diffSha256: SHA,
    protectedPaths: [".plumbline/**", "**/auth/**"],
    ciEvidenceChecks: ["test"],
  });
  assert.equal(r.self_modifying, true);
});

test("generateReceipt: validation is CI-covered + deferred (honest — no fabricated local run)", () => {
  const r = generateReceipt({
    taskId: "feat-x",
    agentId: "mcp-agent",
    intent: "A change authored via MCP that the author did not test locally at all.",
    changedFiles: ["src/pages/home.tsx"],
    diffSha256: SHA,
    protectedPaths: [],
    ciEvidenceChecks: ["test", "build"],
  });
  const plan = r.validation_plan as Array<Record<string, unknown>>;
  const ev = r.execution_evidence as Array<Record<string, unknown>>;
  assert.equal(plan[0].ci_covered, true, "step must be ci_covered");
  assert.equal(plan[0].required, true);
  assert.equal(ev[0].status, "skipped", "evidence must be skipped — no local run is claimed");
  assert.match(String(plan[0].command), /repo CI: test, build/);
});

test("generateReceipt: idempotent — same inputs produce byte-identical output", () => {
  const input = {
    taskId: "feat-x",
    agentId: "mcp-agent",
    intent: "Deterministic idempotency check for the generated receipt output bytes.",
    changedFiles: ["src/a.ts", "src/b.ts"],
    diffSha256: SHA,
    baseSha: "abc1234",
    protectedPaths: [],
    ciEvidenceChecks: ["test"],
  };
  assert.equal(JSON.stringify(generateReceipt(input)), JSON.stringify(generateReceipt(input)));
});

test("generateReceipt: short intent is padded to the schema's ≥40 chars", () => {
  const r = generateReceipt({
    taskId: "t",
    agentId: "a",
    intent: "fix typo",
    changedFiles: ["README.md"],
    diffSha256: SHA,
    protectedPaths: [],
    ciEvidenceChecks: [],
  });
  assert.ok(String(r.intent).length >= 40);
});
