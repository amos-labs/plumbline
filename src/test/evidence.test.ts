import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateCiEvidence, type CheckRun } from "../github.js";

const run = (name: string, status: string, conclusion: string | null): CheckRun => ({
  name,
  status,
  conclusion,
});

test("evaluateCiEvidence: empty required set always passes", () => {
  const r = evaluateCiEvidence([run("test", "completed", "success")], []);
  assert.equal(r.pass, true);
  assert.equal(r.errors.length, 0);
});

test("evaluateCiEvidence: required check that succeeded passes", () => {
  const r = evaluateCiEvidence([run("test", "completed", "success")], ["test"]);
  assert.equal(r.pass, true);
  assert.deepEqual(r.notes, ["test: success"]);
});

test("evaluateCiEvidence: required check that failed is rejected", () => {
  const r = evaluateCiEvidence([run("test", "completed", "failure")], ["test"]);
  assert.equal(r.pass, false);
  assert.match(r.errors[0], /did not pass.*conclusion=failure/);
});

test("evaluateCiEvidence: missing required check is rejected (didn't run)", () => {
  const r = evaluateCiEvidence([run("lint", "completed", "success")], ["test"]);
  assert.equal(r.pass, false);
  assert.match(r.errors[0], /did not run/);
});

test("evaluateCiEvidence: in-progress (not completed) check is rejected", () => {
  const r = evaluateCiEvidence([run("test", "in_progress", null)], ["test"]);
  assert.equal(r.pass, false);
  assert.match(r.errors[0], /status=in_progress/);
});

test("evaluateCiEvidence: a later re-run success counts (failed then succeeded)", () => {
  const r = evaluateCiEvidence(
    [run("test", "completed", "failure"), run("test", "completed", "success")],
    ["test"],
  );
  assert.equal(r.pass, true);
});

test("evaluateCiEvidence: all-of multiple required checks", () => {
  const runs = [run("test", "completed", "success"), run("lint", "completed", "failure")];
  const r = evaluateCiEvidence(runs, ["test", "lint"]);
  assert.equal(r.pass, false);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /lint/);
  assert.deepEqual(r.notes, ["test: success"]);
});
