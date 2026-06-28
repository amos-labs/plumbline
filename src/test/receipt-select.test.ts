import { test } from "node:test";
import assert from "node:assert/strict";
import { pickReceipt } from "../receipt-select.js";

const sha = (s: string) => s.padEnd(64, "0");

test("pickReceipt: a single candidate is returned as-is", () => {
  assert.equal(pickReceipt([{ path: ".proofgate/receipts/a.json" }], {}), ".proofgate/receipts/a.json");
});

test("pickReceipt: the receipt bound to THIS diff wins over a stale re-added one", () => {
  // The exact prod bug: a merge re-added an old branch's receipt (stale
  // diff_sha256) alongside the PR's real one. Binding to the current diff
  // deterministically excludes the stale receipt — no branch needed.
  const candidates = [
    { path: ".proofgate/receipts/ai-module-slide-retry.json", taskId: "ai-module-slide-retry", diffSha256: sha("stale") },
    { path: ".proofgate/receipts/finance-tenant.json", taskId: "finance-tenant", diffSha256: sha("real") },
  ];
  assert.equal(
    pickReceipt(candidates, { actualSha: sha("real") }),
    ".proofgate/receipts/finance-tenant.json",
  );
});

test("pickReceipt: task_id contained in the PR branch wins (no sha available)", () => {
  const candidates = [
    { path: ".proofgate/receipts/ai-module-slide-retry.json", taskId: "ai-module-slide-retry" },
    { path: ".proofgate/receipts/finance-tenant.json", taskId: "finance-tenant" },
  ];
  assert.equal(
    pickReceipt(candidates, { branch: "feat/finance-tenant-scoping" }),
    ".proofgate/receipts/finance-tenant.json",
  );
});

test("pickReceipt: branch match takes precedence over sha", () => {
  const candidates = [
    { path: ".proofgate/receipts/finance-tenant.json", taskId: "finance-tenant", diffSha256: sha("x") },
    { path: ".proofgate/receipts/other.json", taskId: "other", diffSha256: sha("real") },
  ];
  // branch points at finance-tenant; sha would point at other — branch wins.
  assert.equal(
    pickReceipt(candidates, { branch: "feat/finance-tenant", actualSha: sha("real") }),
    ".proofgate/receipts/finance-tenant.json",
  );
});

test("pickReceipt: ambiguous (no branch/sha signal) fails LOUDLY, never silent-first", () => {
  const candidates = [
    { path: ".proofgate/receipts/a.json", taskId: "a" },
    { path: ".proofgate/receipts/b.json", taskId: "b" },
  ];
  assert.throws(() => pickReceipt(candidates, {}), /candidate receipts|none uniquely/i);
  // also when both share the same sha — still ambiguous
  assert.throws(
    () => pickReceipt(
      [{ path: "a.json", diffSha256: sha("z") }, { path: "b.json", diffSha256: sha("z") }],
      { actualSha: sha("z") },
    ),
    /none uniquely/i,
  );
});
