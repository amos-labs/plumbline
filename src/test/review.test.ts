import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReviewJson } from "../review.js";

const ok = '{"verdict":"approve","confidence":0.9,"validation_coverage_notes":"a","mission_alignment_notes":"b","risk_notes":"c"}';

test("parseReviewJson: plain JSON", () => {
  const r = parseReviewJson(ok);
  assert.equal(r?.verdict, "approve");
});

test("parseReviewJson: strips ```json code fences", () => {
  const r = parseReviewJson("```json\n" + ok + "\n```");
  assert.equal(r?.verdict, "approve");
});

test("parseReviewJson: salvages JSON wrapped in prose", () => {
  const r = parseReviewJson("Here is my review:\n" + ok + "\nHope that helps!");
  assert.equal(r?.verdict, "approve");
});

test("parseReviewJson: truncated JSON returns null (not a throw)", () => {
  const truncated = '{"verdict":"revise","confidence":0.8,"risk_notes":"this got cut off mid-str';
  assert.equal(parseReviewJson(truncated), null);
});

test("parseReviewJson: no JSON at all returns null", () => {
  assert.equal(parseReviewJson("I could not complete the review."), null);
  assert.equal(parseReviewJson(""), null);
});

test("parseReviewJson: braces inside strings don't fool the balancer", () => {
  const tricky = '{"verdict":"revise","confidence":0.5,"risk_notes":"see foo() { return {a:1} }","validation_coverage_notes":"x","mission_alignment_notes":"y"}';
  const r = parseReviewJson(tricky);
  assert.equal(r?.verdict, "revise");
});
