import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  slugFromTitle,
  proposalMd,
  tasksMd,
  issueBody,
  writeBackTaskId,
  predictSelfModifying,
  runPropose,
} from "../propose.js";

const GLOBS = ["**/auth/**", "migrations/**", ".github/workflows/**", ".proofgate/**", "amos.yaml"];

test("slugFromTitle: kebab, bounded, never empty", () => {
  assert.equal(slugFromTitle("Add QuickBooks OAuth to Connections!"), "add-quickbooks-oauth-to-connections");
  assert.equal(slugFromTitle("  ---  "), "change");
  assert.ok(slugFromTitle("x".repeat(200)).length <= 60);
});

test("proposalMd: front-matter + TODO judgment sections, tool never fills them", () => {
  const md = proposalMd({ title: "Rotate auth tokens", body: "Tokens never expire today." });
  assert.match(md, /^---\ntitle: Rotate auth tokens\ntask_id: TODO/m);
  assert.match(md, /Tokens never expire today\./);
  for (const section of ["## Why", "## What Changes", "## Scope / Non-goals"]) {
    assert.ok(md.includes(section), `${section} present`);
  }
  assert.match(md, /## Why\n\nTODO/);
});

test("tasksMd carries the receipt hand-off step", () => {
  assert.match(tasksMd("X"), /proofgate receipt --write/);
});

test("issueBody: contract pointer present unless lite (no slug)", () => {
  assert.match(issueBody({ slug: "rotate-auth-tokens" }), /Contract: `openspec\/changes\/rotate-auth-tokens\/`/);
  assert.ok(!issueBody({}).includes("Contract:"));
  assert.match(issueBody({}), /## Acceptance/);
});

test("writeBackTaskId replaces only the front-matter task_id line", () => {
  const md = proposalMd({ title: "T" });
  const linked = writeBackTaskId(md, 42);
  assert.match(linked, /^task_id: "42"$/m);
  assert.ok(!linked.includes("TODO — issue number"));
});

test("predictSelfModifying: path-ish token hits a protected glob", () => {
  const p = predictSelfModifying("fix bug in fastapi_app/auth/router.py", GLOBS);
  assert.equal(p.selfModifying, true);
  assert.match(p.reasons[0], /\*\*\/auth\/\*\*/);
});

test("predictSelfModifying: bare glob-core word ('migrations') flags informationally", () => {
  const p = predictSelfModifying("add the new billing migrations for tenants", GLOBS);
  assert.equal(p.selfModifying, true);
  assert.match(p.reasons.join(" "), /migrations/);
});

test("predictSelfModifying: unrelated ask stays false", () => {
  const p = predictSelfModifying("update the marketing copy on the pricing page", GLOBS);
  assert.equal(p.selfModifying, false);
});

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "pg-propose-"));
}

test("runPropose: scaffolds folder, gh mocked, writes back issue number", () => {
  const cwd = tmp();
  const logs: string[] = [];
  const res = runPropose({
    title: "Rotate auth tokens",
    body: "Tokens never expire.",
    lite: false,
    cwd,
    protectedPaths: GLOBS,
    gh: () => "https://github.com/amos-labs/x/issues/17\n",
    log: (l) => logs.push(l),
  });
  assert.equal(res.slug, "rotate-auth-tokens");
  assert.equal(res.issueNumber, 17);
  const proposal = readFileSync(join(cwd, "openspec/changes/rotate-auth-tokens/proposal.md"), "utf8");
  assert.match(proposal, /^task_id: "17"$/m); // born linked
  assert.ok(existsSync(join(cwd, "openspec/changes/rotate-auth-tokens/tasks.md")));
  assert.ok(existsSync(join(cwd, "openspec/changes/rotate-auth-tokens/specs")));
  assert.equal(res.prediction.selfModifying, true); // "auth" in the ask
});

test("runPropose --lite: no folder, no contract line, issue still opened", () => {
  const cwd = tmp();
  let body = "";
  const res = runPropose({
    title: "Fix typo on pricing page",
    lite: true,
    cwd,
    protectedPaths: GLOBS,
    gh: (args) => {
      body = args[args.indexOf("--body") + 1];
      assert.ok(!args.includes("--label"), "--lite skips the spec-carrying label");
      return "https://github.com/amos-labs/x/issues/9";
    },
  });
  assert.equal(res.slug, undefined);
  assert.equal(res.issueNumber, 9);
  assert.ok(!existsSync(join(cwd, "openspec")));
  assert.ok(!body.includes("Contract:"));
});

test("runPropose: gh failure degrades to a printed, runnable command", () => {
  const cwd = tmp();
  const logs: string[] = [];
  const res = runPropose({
    title: "Add thing",
    lite: false,
    cwd,
    protectedPaths: [],
    gh: () => {
      throw new Error("gh: command not found");
    },
    log: (l) => logs.push(l),
  });
  assert.equal(res.issueNumber, undefined);
  assert.ok(res.ghCommand?.startsWith("gh issue create --title"));
  assert.ok(existsSync(join(cwd, "openspec/changes/add-thing/proposal.md")), "folder still scaffolded");
  // no issue → task_id stays TODO for a later manual link
  assert.match(readFileSync(join(cwd, "openspec/changes/add-thing/proposal.md"), "utf8"), /task_id: TODO/);
});

test("runPropose: existing folder is never clobbered", () => {
  const cwd = tmp();
  const first = runPropose({
    title: "Same change",
    lite: false,
    cwd,
    protectedPaths: [],
    gh: () => "https://github.com/o/r/issues/1",
  });
  const before = readFileSync(join(cwd, first.folder!, "proposal.md"), "utf8");
  const logs: string[] = [];
  runPropose({
    title: "Same change",
    body: "different body that must NOT overwrite",
    lite: false,
    cwd,
    protectedPaths: [],
    gh: () => "https://github.com/o/r/issues/2",
    log: (l) => logs.push(l),
  });
  const after = readFileSync(join(cwd, first.folder!, "proposal.md"), "utf8");
  assert.ok(logs.some((l) => l.includes("left as-is")));
  // content preserved except the task_id write-back (issue #2 re-links)
  assert.equal(
    before.replace(/^task_id: .*$/m, ""),
    after.replace(/^task_id: .*$/m, ""),
  );
});
