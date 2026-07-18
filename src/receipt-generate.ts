import { matchesAny } from "./glob.js";
import type { Policy } from "./types.js";

/**
 * `plumb receipt generate` — auto-synthesize a conformant, HONEST proof receipt
 * for an MCP-authored (or otherwise machine-authored) code change (v0.7.0).
 *
 * The problem it solves: a non-coder opens a PR via an MCP `propose_code_change`
 * verb. The author never ran tests locally and can't hand-write a receipt, so
 * every such PR dead-ends in REWORK for "no receipt". `receipt generate` makes
 * these changes proof-carrying BY CONSTRUCTION:
 *
 *  - validation_plan references the REPO'S CI checks as `ci_covered: true`
 *    ("repo CI: tests/build/lint"). It does NOT fabricate a local test run —
 *    the receipt truthfully says validation is DEFERRED TO CI, which is exactly
 *    what happened for an MCP change whose author didn't run tests. The gate's
 *    ci-evidence step then corroborates against the real CI run in `run` mode.
 *  - self_modifying is AUTO-DETECTED from the repo's configured protected_paths
 *    vs the changed files — the same globs the gate uses, so scaffold and gate
 *    can never disagree.
 *  - diff_sha256 / changed_files / base_sha are filled by the caller from the
 *    real diff (the canonical base..HEAD, receipts excluded).
 *
 * Result: a green-CI + non-protected change → PASS (auto-merge eligible); a
 * protected-surface change → REVIEW. The judgment prose (intent, result_summary)
 * comes from the caller's --intent/--summary — the human's ask, not invented.
 *
 * This module is PURE (no git / no fs) so it is fully unit-testable; the CLI
 * wires the git-derived mechanical fields in.
 */

export interface GenerateInput {
  taskId: string;
  agentId: string;
  /** The human's ask — becomes `intent` (padded to the schema's ≥40 chars). */
  intent: string;
  /** Optional result summary; falls back to a truthful CI-deferred sentence. */
  summary?: string;
  /** Changed files from the real diff (receipt paths already excluded). */
  changedFiles: string[];
  /** diff_sha256 from the canonical base..HEAD diff (receipts excluded). */
  diffSha256: string;
  /** Pinned merge-base commit, when git resolved one. */
  baseSha?: string;
  /** The repo's protected-path globs (policy.protected_paths). */
  protectedPaths: string[];
  /**
   * The repo's CI evidence checks (policy.ci_evidence_checks). Named in the
   * validation_plan's reason so the receipt says exactly which CI corroborates
   * it. When empty, the plan still references "repo CI" generically.
   */
  ciEvidenceChecks: readonly string[];
}

const MIN_PROSE = 40;

/** Pad a short prose field up to the schema's minimum without lying about it. */
function ensureMinLength(s: string, min: number, suffix: string): string {
  const t = s.trim();
  if (t.length >= min) return t;
  return `${t}${t.endsWith(".") ? "" : "."} ${suffix}`.trim();
}

/**
 * Build a conformant receipt object for a machine-authored change. Deterministic
 * and idempotent: same inputs → byte-identical output, so re-running `generate`
 * on an unchanged diff rewrites the same file.
 */
export function generateReceipt(input: GenerateInput): Record<string, unknown> {
  const hits = input.changedFiles.filter((f) => matchesAny(f, input.protectedPaths));
  const selfModifying = hits.length > 0;

  const ciLabel =
    input.ciEvidenceChecks.length > 0
      ? `repo CI: ${input.ciEvidenceChecks.join(", ")}`
      : "repo CI: tests/build/lint";

  const intent = ensureMinLength(
    input.intent,
    MIN_PROSE,
    "Authored via an MCP code-change verb; validation is deferred to the repo's CI.",
  );

  const summaryBase =
    input.summary?.trim() ||
    `Applied the requested change across ${input.changedFiles.length} file(s). ` +
      "The author did not run tests locally — validation is deferred to the repo's CI, " +
      "which the gate corroborates against the real run.";
  const resultSummary = ensureMinLength(
    summaryBase,
    MIN_PROSE,
    "Validation is deferred to the repo's CI.",
  );

  return {
    receipt_version: "1.0",
    task_id: input.taskId,
    agent_id: input.agentId,
    intent,
    self_modifying: selfModifying,
    policy_refs: [".plumbline/MISSION.md"],
    validation_plan: [
      {
        command: ciLabel,
        reason:
          "Machine-authored change: tests were not run locally. The repo's CI " +
          "(tests/build/lint) is the source of truth; the gate's ci-evidence step " +
          "corroborates it against the real run before merge.",
        required: true,
        // ci_covered: the gate reads the PR's real CI conclusions rather than
        // demanding a self-reported local run. This is the honest shape for an
        // MCP change — it does not claim a test run that never happened.
        ci_covered: true,
      },
    ],
    execution_evidence: [
      {
        command: ciLabel,
        // "skipped" (not "passed"): the author truthfully did NOT run this
        // locally. The ci_covered flag lets shape accept a skipped required
        // step; ci-evidence proves the real CI run in `run` mode.
        status: "skipped",
        skip_reason:
          "Machine-authored change; validation deferred to the repo's CI (corroborated by the ci-evidence gate).",
      },
    ],
    changed_files: input.changedFiles,
    ...(input.baseSha ? { base_sha: input.baseSha } : {}),
    diff_sha256: input.diffSha256,
    result_summary: resultSummary,
    /** Provenance: this receipt was synthesized, not hand-authored. */
    _generated_by: "plumb receipt generate",
  };
}
