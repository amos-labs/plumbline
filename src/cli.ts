#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { PolicySchema, type GateResult, type Policy, type Verdict } from "./types.js";
import { shapeCheck } from "./shape.js";
import { semanticReview } from "./review.js";
import { renderComment } from "./github.js";
import { detectCi, reportToCi } from "./ci.js";

function loadPolicy(path: string): Policy {
  if (!existsSync(path)) {
    console.error(`proofgate: policy file not found at ${path} — using defaults`);
    return PolicySchema.parse({ version: "1.0" });
  }
  return PolicySchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

function getDiff(baseRef: string, cwd: string): string {
  return execFileSync("git", ["diff", `${baseRef}...HEAD`], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

const DEFAULT_RECEIPT = ".proofgate/receipt.json";

/**
 * Locate the receipt for THIS PR. Per-PR receipts live at
 * `.proofgate/receipts/<task_id>.json` — one file per PR, so concurrent
 * PRs never collide on a shared receipt (the single biggest blocker to
 * running many agent PRs at once). We find the one added/modified in this
 * PR's diff. Falls back to the legacy single-file path when none is found
 * or git isn't available, so existing repos keep working unchanged. An
 * explicit non-default --receipt always wins.
 */
function resolveReceiptPath(
  explicit: string,
  baseRef: string | undefined,
  cwd: string,
  skipGit: boolean,
): string {
  if (explicit !== DEFAULT_RECEIPT) return explicit;
  if (skipGit || !baseRef) return DEFAULT_RECEIPT;
  let changed: string[] = [];
  try {
    changed = execFileSync(
      "git",
      ["diff", "--name-only", "--diff-filter=AMR", `${baseRef}...HEAD`],
      { cwd, encoding: "utf8" },
    )
      .split("\n")
      .map((l) => l.trim())
      .filter((f) => /^\.proofgate\/receipts\/[^/]+\.json$/.test(f));
  } catch {
    return DEFAULT_RECEIPT;
  }
  if (changed.length === 1) return changed[0];
  if (changed.length > 1) {
    console.error(
      `proofgate: this PR adds ${changed.length} receipts (${changed.join(", ")}); ` +
        `expected exactly one under .proofgate/receipts/. Using the first.`,
    );
    return changed[0];
  }
  return DEFAULT_RECEIPT;
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) {
    return process.argv[i + 1];
  }
  return fallback;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<number> {
  const cmd = process.argv[2];
  const ci = detectCi();
  const cwd = arg("cwd", process.cwd())!;
  const policyPath = arg("policy", ".proofgate/policy.json")!;
  const baseRef = arg("base", ci.baseRef ?? "origin/main")!;
  const skipGit = flag("no-git");
  const receiptPath = resolveReceiptPath(
    arg("receipt", DEFAULT_RECEIPT)!,
    skipGit ? undefined : baseRef,
    cwd,
    skipGit,
  );

  if (!cmd || !["shape", "review", "run"].includes(cmd)) {
    console.log(`proofgate — proof-carrying gate for AI agent work

usage:
  proofgate shape   [--receipt path] [--policy path] [--base ref] [--no-git]
  proofgate review  [--receipt path] [--policy path] [--base ref] [--mission path]
  proofgate run     [--receipt path] [--policy path] [--base ref]   (shape + review + PR comment in CI)

receipt: auto-discovered from the PR diff at .proofgate/receipts/<task_id>.json
         (one file per PR — no conflicts); falls back to .proofgate/receipt.json.
         Pass --receipt to override.
policy default:  .proofgate/policy.json
env: ANTHROPIC_API_KEY (review), GITHUB_TOKEN + GITHUB_REPOSITORY + PR number (comment), PROOFGATE_MODEL (override)`);
    return cmd ? 2 : 0;
  }

  const policy = loadPolicy(policyPath);

  if (!existsSync(receiptPath)) {
    console.error(
      `proofgate: no receipt found at ${receiptPath}.\n` +
        `Agent work must ship with a proof receipt. See templates/receipt.example.json.`,
    );
    return 1;
  }
  const rawReceipt = readFileSync(receiptPath, "utf8");

  // --- Shape gate (always runs) ---
  const { result: shape, receipt } = shapeCheck(rawReceipt, policy, {
    baseRef: skipGit ? undefined : baseRef,
    cwd,
    skipGit,
  });

  for (const e of shape.errors) console.error(`shape ❌ ${e}`);
  for (const w of shape.warnings) console.error(`shape ⚠️  ${w}`);
  console.error(`shape gate: ${shape.pass ? "PASS" : "FAIL"}`);

  const gate: GateResult = {
    shape,
    final: shape.pass ? "approve" : "revise",
    reasons: [],
  };

  if (cmd === "shape") return shape.pass ? 0 : 1;

  // --- Semantic review ---
  if (!shape.pass || !receipt) {
    gate.final = "revise";
    gate.reasons.push("semantic review skipped: shape gate failed — fix shape errors first");
  } else {
    const missionPath = arg("mission", policy.mission_file)!;
    if (!existsSync(missionPath)) {
      console.error(`proofgate: mission file not found at ${missionPath}`);
      return 1;
    }
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error("proofgate: ANTHROPIC_API_KEY is required for semantic review");
      return 1;
    }
    const mission = readFileSync(missionPath, "utf8");
    const diff = skipGit ? "" : getDiff(baseRef, cwd);

    const review = await semanticReview(mission, receipt, diff, policy, apiKey);
    gate.review = review;
    gate.final = review.verdict as Verdict;

    console.error(`semantic review: ${review.verdict} (confidence ${review.confidence})`);
    console.error(`  coverage: ${review.validation_coverage_notes}`);
    console.error(`  mission:  ${review.mission_alignment_notes}`);
    console.error(`  risk:     ${review.risk_notes}`);
  }

  // --- CI reporting ---
  if (cmd === "run") {
    if (ci.prNumber !== undefined && process.env.PROOFGATE_PR_NUMBER) {
      ci.prNumber = Number(process.env.PROOFGATE_PR_NUMBER);
    }
    const posted = await reportToCi(ci, renderComment(gate), gate.final === "approve").catch(
      (e) => {
        console.error(`proofgate: failed to post CI comment: ${e?.message ?? e}`);
        return false;
      },
    );
    if (posted) {
      console.error(`posted gate result to PR #${ci.prNumber} (${ci.provider})`);
    } else {
      console.error("proofgate: no PR context detected — printing comment:\n");
      console.log(renderComment(gate));
    }
  } else {
    console.log(JSON.stringify(gate, null, 2));
  }

  // Exit code drives required-check status: only approve passes.
  return gate.final === "approve" ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`proofgate: ${err?.message ?? err}`);
    process.exit(1);
  },
);
