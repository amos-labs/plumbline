import assert from "node:assert/strict";
import { test } from "node:test";
import { canSignOff, revisionApproval } from "../revision.js";
import { summarize } from "../outcomes.js";
import type { GateResult } from "../types.js";

const head = "a".repeat(40);
const gate: GateResult = { final: "review", shape: {pass: true, errors: [], warnings: []}, reasons: [],
  review: { verdict: "review", confidence: 1, validation_coverage_notes: "", mission_alignment_notes: "", risk_notes: "",
    audit: {provider: "anthropic"} } };

test("only a live human REVIEW with independently green tests is eligible", () => {
  assert.ok(canSignOff(gate, true, "full"));
  assert.ok(!canSignOff(gate, false, "full"));
  assert.ok(!canSignOff(gate, true, "quality"));
  for (const final of ["indeterminate", "approve", "rework"] as const) assert.ok(!canSignOff({...gate, final}, true, "verify"));
  assert.ok(!canSignOff({...gate, review: undefined}, true, "verify"));
  assert.ok(!canSignOff({...gate, review: {...gate.review!, audit: {provider: "a", cached: true}}}, true, "verify"));
});

test("only an unedited, exact-revision decision from a current maintainer counts", async t => {
  const make = (body: string, who: string) => ({id: 4, body, user: { login: who, type: "User" }, updated_at: "1", created_at: "1"});
  const command = "/plumbline approve " + head;
  const comments = [make(command, "maint"), make("/plumbline revoke " + head, "reader")];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.includes("/comments?")) return Response.json(comments);
    return Response.json({permission: "write", role_name: url.includes("/maint/") ? "maintain" : "write"});
  });
  const read = () => revisionApproval("org/repo", 7, head, "token");
  assert.equal((await read())?.actor, "maint");
  comments.push(make("/plumbline revoke " + head, "maint"));
  assert.equal(await read(), undefined);
  comments.push({...make(command, "maint"), updated_at: "2"}, make(command + "0", "maint"),
    {...make(command, "maint"), user: { login: "maint", type: "Bot" }});
  assert.equal(await read(), undefined);
});

test("outcomes count labeled fixes, measured time, and only matched reviewer inputs", () => {
  const identity = { repository: "org/repo", pr: 7, head };
  const gate = {schema: "plumbline.gate-result.v1", ...identity, phase: "full", source: "shadow", policy_sha256: "p",
    audit: { provider: "openai", model: "qwen", input_sha256: "prompt" }, review_ms: 100,
    reviewer_verdict: "review", findings: [{ id: "f", description: "fix" }] };
  const proof = {schema: "plumbline.test-proof.v1", ...identity, merged_commit: head, job_id: 2, test_seconds: 120};
  const result = summarize([gate, {...gate, audit: {...gate.audit, model: "incumbent"}}, proof, proof,
    {schema: "plumbline.outcome.v1", ...identity, outcome: "fixed", finding: "f", evidence: "fix commit"}]);
  assert.equal(result.matched_inputs.length, 1);
  assert.equal(result.reused_test_minutes, 2);
  assert.equal(result.models["openai/qwen"].fixed, 1);
  assert.equal(result.confirmed_regression_revisions, 0);
  assert.equal(summarize([gate, {...gate, audit: {...gate.audit, model: "other", input_sha256: "different"}}]).matched_inputs.length, 0);
});

test("a check without a matching test witness records only the workflow identity", async t => {
  const { testProvenance } = await import("../test-provenance.js");
  const tested = "b".repeat(40);
  const job = {id: 2, run_id: 1, run_attempt: 3, name: "test", conclusion: "success",
    steps: [{name: "Verified PR 7 checkout " + tested, conclusion: "success"}]};
  const objects: Record<string, unknown> = { "/actions/jobs/2": job,
    "/actions/runs/1/attempts/3": { path: "ci.yml", head_sha: head, event: "pull_request", head_repository: {full_name: "o/r"} },
    ["/git/commits/" + tested]: {tree: {sha: "tree"}, parents: [{sha: "base"}, {sha: head}]} };
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(objects[url.split("/repos/o/r")[1]]));
  const check = {id: 2, app: {slug: "github-actions"}, status: "completed", conclusion: "success",
    name: "test", details_url: "https://github.com/o/r/actions/runs/1/job/2"};
  const query = () => testProvenance("o/r", 7, head, check, "token");
  assert.deepEqual(await query(), { workflow: "ci.yml", run_id: 1, attempt: 3, job_id: 2, job: "test",
    tested_commit: tested, tested_tree: "tree" });
  job.steps[0].conclusion = "skipped";
  assert.ok(!Object.hasOwn((await query())!, "tested_commit"));
});
