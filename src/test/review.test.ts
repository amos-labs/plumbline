import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseReviewJson,
  resolveReviewModel,
  resolveReviewTemperature,
  semanticReview,
} from "../review.js";
import { PolicySchema, type Policy, type Receipt } from "../types.js";
import type { ReviewProvider } from "../provider.js";

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function pol(overrides: Record<string, unknown> = {}): Policy {
  return PolicySchema.parse({ version: "1.0", ...overrides });
}

function rcpt(overrides: Partial<Receipt> = {}): Receipt {
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
  const truncated = '{"verdict":"rework","confidence":0.8,"risk_notes":"this got cut off mid-str';
  assert.equal(parseReviewJson(truncated), null);
});

test("parseReviewJson: no JSON at all returns null", () => {
  assert.equal(parseReviewJson("I could not complete the review."), null);
  assert.equal(parseReviewJson(""), null);
});

test("parseReviewJson: braces inside strings don't fool the balancer", () => {
  const tricky = '{"verdict":"rework","confidence":0.5,"risk_notes":"see foo() { return {a:1} }","validation_coverage_notes":"x","mission_alignment_notes":"y"}';
  const r = parseReviewJson(tricky);
  assert.equal(r?.verdict, "rework");
});

// --- temperature omitted-by-default (#3) ---

test("resolveReviewTemperature: undefined by default (omitted) — no temperature sent", () => {
  withEnv({ PLUMBLINE_TEMPERATURE: undefined }, () => {
    assert.equal(resolveReviewTemperature(pol()), undefined);
  });
});

test("resolveReviewTemperature: policy value is used when set", () => {
  withEnv({ PLUMBLINE_TEMPERATURE: undefined }, () => {
    assert.equal(resolveReviewTemperature(pol({ review_temperature: 0 })), 0);
    assert.equal(resolveReviewTemperature(pol({ review_temperature: 0.7 })), 0.7);
  });
});

test("resolveReviewTemperature: PLUMBLINE_TEMPERATURE env overrides policy", () => {
  withEnv({ PLUMBLINE_TEMPERATURE: "0.4" }, () => {
    assert.equal(resolveReviewTemperature(pol({ review_temperature: 0 })), 0.4);
  });
});

test("resolveReviewTemperature: invalid/out-of-range env is ignored (falls through)", () => {
  withEnv({ PLUMBLINE_TEMPERATURE: "nope" }, () => {
    assert.equal(resolveReviewTemperature(pol()), undefined);
  });
  withEnv({ PLUMBLINE_TEMPERATURE: "9" }, () => {
    assert.equal(resolveReviewTemperature(pol({ review_temperature: 0.2 })), 0.2);
  });
});

test("semanticReview: passes NO temperature to the provider by default (Anthropic-safe)", async () => {
  let sawTemp: number | undefined = -1; // sentinel
  const fake: ReviewProvider = {
    id: "anthropic",
    async complete(req) {
      sawTemp = req.temperature;
      return ok;
    },
  };
  await withEnvAsync({ PLUMBLINE_TEMPERATURE: undefined }, async () => {
    await semanticReview("mission", rcpt(), "diff", pol(), fake);
  });
  assert.equal(sawTemp, undefined, "default review sends no temperature");
});

// --- model override precedence (#8) ---

test("resolveReviewModel: PLUMBLINE_MODEL overrides policy.review_model", () => {
  withEnv({ PLUMBLINE_MODEL: "env-model", PROOFGATE_MODEL: undefined }, () => {
    assert.equal(resolveReviewModel(pol({ review_model: "policy-model" })), "env-model");
  });
});

test("resolveReviewModel: PROOFGATE_MODEL (legacy) overrides policy when PLUMBLINE_MODEL unset", () => {
  withEnv({ PLUMBLINE_MODEL: undefined, PROOFGATE_MODEL: "legacy-model" }, () => {
    assert.equal(resolveReviewModel(pol({ review_model: "policy-model" })), "legacy-model");
  });
});

test("resolveReviewModel: falls back to policy.review_model when no env override", () => {
  withEnv({ PLUMBLINE_MODEL: undefined, PROOFGATE_MODEL: undefined }, () => {
    assert.equal(resolveReviewModel(pol({ review_model: "policy-model" })), "policy-model");
  });
});

// async env helper (kept local to avoid touching the sync one above)
async function withEnvAsync(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    await fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}
