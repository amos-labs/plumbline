import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ReceiptSchema } from "../types.js";
import { formatZodIssue } from "../shape.js";
import { newReceipt, schemaHelpBlock, formatSchemaReference } from "../scaffold.js";
import { preferredRemote, type GitTry } from "../base.js";

const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));

// #1 — a bad enum value produces a self-correcting error that NAMES the allowed
// set (the exact trap: someone used execution_evidence[].status "deferred-to-ci").
test("enum error names the allowed set + the received value", () => {
  const r: Record<string, unknown> = newReceipt({ taskId: "t", agentId: "a", diffSha256: "0".repeat(64), changedFiles: ["app.rb"] });
  r.execution_evidence = [{ command: "x", status: "deferred-to-ci" }];
  const parsed = ReceiptSchema.safeParse(r);
  assert.equal(parsed.success, false);
  const issue = (parsed as { success: false; error: { issues: any[] } }).error.issues.find((i) => i.path.join(".").includes("status"));
  const msg = formatZodIssue(issue);
  assert.match(msg, /passed \| failed \| skipped/);
  assert.match(msg, /deferred-to-ci/);
});

// #2 — a scaffolded receipt carries a _help block AND still validates (the gate
// ignores unknown keys, so _help is stripped on parse — safe to leave in).
test("scaffolded receipt includes _help and parses (unknown key stripped)", () => {
  const r = newReceipt({ taskId: "t", agentId: "a", diffSha256: "0".repeat(64), changedFiles: ["app.rb"] }) as Record<string, unknown>;
  assert.ok(r._help, "_help present");
  const help = r._help as Record<string, string>;
  assert.match(help["execution_evidence[].status"], /passed \| failed \| skipped/);
  const parsed = ReceiptSchema.safeParse(r);
  assert.equal(parsed.success, true);
  assert.equal("_help" in (parsed as { data: object }).data, false, "_help stripped from parsed receipt");
});

// schemaHelpBlock + reference cover the status enum (single source of truth).
test("schema reference lists the status enum", () => {
  assert.match(formatSchemaReference(), /passed \| failed \| skipped/);
  assert.match(schemaHelpBlock()["execution_evidence[].status"], /passed \| failed \| skipped/);
});

// #4 — `proofgate schema` prints the enums from the built CLI (discoverable
// without failing the gate, no repo/policy/git needed).
test("`proofgate schema` prints the receipt field reference + enums", () => {
  const out = execFileSync("node", [CLI, "schema"], { encoding: "utf8" });
  assert.match(out, /receipt schema/i);
  assert.match(out, /passed \| failed \| skipped/);
  assert.match(out, /diff_sha256/);
});

// remote preference — picks a github.com remote over a dead/non-CI `origin`.
test("preferredRemote picks the github.com remote over origin", () => {
  const stub: GitTry = (args) => {
    if (args[0] === "remote" && args.length === 1) return "origin\ngithub";
    if (args[0] === "remote" && args[1] === "get-url" && args[2] === "origin") return "https://dev.azure.com/org/proj/_git/repo";
    if (args[0] === "remote" && args[1] === "get-url" && args[2] === "github") return "git@github.com:org/repo.git";
    return null;
  };
  assert.equal(preferredRemote(stub), "github");
});

test("preferredRemote falls back to origin when no github remote", () => {
  const stub: GitTry = (args) => {
    if (args[0] === "remote" && args.length === 1) return "origin\nbackup";
    if (args[0] === "remote" && args[1] === "get-url") return "https://gitlab.com/org/repo.git";
    return null;
  };
  assert.equal(preferredRemote(stub), "origin");
  assert.equal(preferredRemote(() => null), "origin"); // no remotes
});
