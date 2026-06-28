#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PolicySchema, type GateResult, type Policy, type Verdict } from "./types.js";
import {
  shapeCheck,
  computeDiffSha256,
  gitDiffExcludingReceipt,
  gitChangedFiles,
  isReceiptPath,
} from "./shape.js";
import { semanticReview } from "./review.js";
import { renderComment, renderCiSummary, verifyCiEvidence } from "./github.js";
import { detectCi, reportToCi } from "./ci.js";
import { pickReceipt, type ReceiptCandidate } from "./receipt-select.js";

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
    // More than one per-PR receipt in the diff — usually a merge re-added an
    // old branch's receipt next to this PR's real one. DON'T grab the first
    // (that's how the gate evaluated the wrong receipt and failed a correct
    // PR). Disambiguate by task_id↔branch / diff_sha256 binding, or fail loudly.
    const candidates: ReceiptCandidate[] = changed.map((p) => {
      try {
        const j = JSON.parse(readFileSync(join(cwd, p), "utf8")) as {
          task_id?: unknown;
          diff_sha256?: unknown;
        };
        return {
          path: p,
          taskId: typeof j.task_id === "string" ? j.task_id : undefined,
          diffSha256: typeof j.diff_sha256 === "string" ? j.diff_sha256 : undefined,
        };
      } catch {
        return { path: p };
      }
    });
    let actualSha: string | undefined;
    try {
      actualSha = computeDiffSha256(gitDiffExcludingReceipt(baseRef, cwd));
    } catch {
      // git unavailable for the binding hash — fall back to branch/explicit-fail.
    }
    const branch = process.env.GITHUB_HEAD_REF || undefined;
    return pickReceipt(candidates, { branch, actualSha });
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

  if (!cmd || !["shape", "review", "run", "stamp", "check"].includes(cmd)) {
    console.log(`proofgate — proof-carrying gate for AI agent work

usage:
  proofgate stamp   [--receipt path] [--base ref]   (fill diff_sha256 + changed_files from the real diff)
  proofgate check   [--receipt path] [--policy path] [--base ref]   (local pre-flight: shape + diff_sha256, prints the capsule)
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

  // --- stamp: fill the mechanical fields from the real diff, then exit (#5) ---
  // diff_sha256 + changed_files are the most error-prone fields (they change on
  // every edit/rebase). Generate them with the exact computation the gate uses,
  // so the author never hand-maintains them or fails the gate on a stale hash.
  if (cmd === "stamp") {
    if (skipGit || !baseRef) {
      console.error("proofgate stamp: needs git + a --base ref to compute the diff");
      return 1;
    }
    let receiptObj: Record<string, unknown>;
    try {
      receiptObj = JSON.parse(rawReceipt);
    } catch (e) {
      console.error(`proofgate stamp: receipt is not valid JSON: ${String(e)}`);
      return 1;
    }
    let diffSha: string;
    let changed: string[];
    try {
      diffSha = computeDiffSha256(gitDiffExcludingReceipt(baseRef, cwd));
      changed = gitChangedFiles(baseRef, cwd).filter((f) => !isReceiptPath(f));
    } catch (e) {
      console.error(`proofgate stamp: git failed: ${String(e)}`);
      return 1;
    }
    const prevSha = receiptObj.diff_sha256;
    receiptObj.diff_sha256 = diffSha;
    receiptObj.changed_files = changed;
    writeFileSync(receiptPath, `${JSON.stringify(receiptObj, null, 2)}\n`);
    console.error(`stamped ${receiptPath} (base ${baseRef}):`);
    console.error(
      `  diff_sha256:   ${diffSha}${prevSha && prevSha !== diffSha ? `  (was ${String(prevSha)})` : ""}`,
    );
    console.error(`  changed_files (${changed.length}): ${changed.join(", ") || "(none)"}`);
    return 0;
  }

  // --- check: local pre-flight — shape + diff_sha256, render the would-be capsule (#4) ---
  // Same shape + diff integrity the action runs in CI, but in the working tree —
  // so a shape/sha error is caught before pushing (no red CI round-trip, no
  // wasted Actions minutes). Semantic review still runs server-side in CI.
  if (cmd === "check") {
    const { result: shape } = shapeCheck(rawReceipt, policy, {
      baseRef: skipGit ? undefined : baseRef,
      cwd,
      skipGit,
    });
    const gate: GateResult = {
      shape,
      final: shape.pass ? "approve" : "revise",
      reasons: [],
    };
    // Print the same capsule CI would post, so the author sees exactly what the
    // gate will say.
    console.log(renderComment(gate));
    for (const e of shape.errors) console.error(`shape ❌ ${e}`);
    for (const w of shape.warnings) console.error(`shape ⚠️  ${w}`);
    console.error(
      shape.pass
        ? "✓ pre-flight PASS — shape + diff_sha256 OK. Safe to push (semantic review still runs in CI)."
        : "✗ pre-flight FAIL — fix the above before pushing. Tip: `proofgate stamp` fixes diff_sha256/changed_files.",
    );
    return shape.pass ? 0 : 1;
  }

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

  // --- CI evidence integrity (run mode): corroborate against the real CI run (#6) ---
  // Don't trust the receipt's self-reported execution_evidence for these — read
  // the actual check-run conclusions for the PR head and require success. The
  // agent need not self-report status for these; CI is the source of truth.
  if (cmd === "run" && policy.ci_evidence_checks.length > 0) {
    const repo = process.env.GITHUB_REPOSITORY;
    const token = process.env.GITHUB_TOKEN;
    if (ci.provider === "github" && repo && token && ci.prNumber !== undefined) {
      try {
        const ev = await verifyCiEvidence(repo, ci.prNumber, token, policy.ci_evidence_checks);
        for (const n of ev.notes) console.error(`ci-evidence ✓ ${n}`);
        for (const e of ev.errors) {
          console.error(`ci-evidence ❌ ${e}`);
          shape.errors.push(e);
        }
        console.error(`ci-evidence gate: ${ev.pass ? "PASS" : "FAIL"}`);
        if (!ev.pass) {
          shape.pass = false;
          gate.final = "revise";
        } else {
          gate.reasons.push(
            `CI evidence corroborated against the real run (${ev.notes.join(", ")}) — not self-reported.`,
          );
        }
      } catch (e) {
        const msg = `ci-evidence: could not verify CI checks: ${String(e)}`;
        console.error(`ci-evidence ❌ ${msg}`);
        shape.errors.push(msg);
        shape.pass = false;
        gate.final = "revise";
      }
    } else {
      console.error("ci-evidence: configured but no GitHub PR context/token — skipped");
      gate.reasons.push("CI evidence configured but no GitHub PR context — not verified.");
    }
  }

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
    const posted = await reportToCi(
      ci,
      renderComment(gate),
      gate.final === "approve",
      renderCiSummary(gate),
    ).catch((e) => {
      console.error(`proofgate: failed to post CI comment: ${e?.message ?? e}`);
      return false;
    });
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
