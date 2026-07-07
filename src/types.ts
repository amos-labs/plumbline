import { z } from "zod";

/**
 * Proof receipt schema — adapted from the AMOS proof-carrying loop
 * (amos-relay/src/proof_receipt.rs), stripped of marketplace concerns.
 *
 * A receipt binds: what the agent intended, what rules applied, how the
 * change was validated, what evidence exists, and whether the change
 * touches protected (self-modifying) surfaces.
 */

export const ValidationStepSchema = z.object({
  command: z.string().min(1),
  reason: z.string().min(1),
  required: z.boolean(),
  /**
   * Optional stable identifier for the step. When present, execution_evidence
   * is matched to this step by `id` (via each evidence entry's `step`) instead
   * of by byte-matching the `command` string — so a trivial whitespace/wording
   * diff between plan and evidence no longer reads as "no execution evidence".
   */
  id: z.string().min(1).optional(),
  /**
   * Mark a step as corroborated by the `ci-evidence` gate rather than by
   * self-reported manual evidence. A step whose `command` maps to one of the
   * policy's `ci_evidence_checks` is auto-recognized as CI-covered even without
   * this flag — set it explicitly to be unambiguous. CI-covered required steps
   * may be `skipped` (or have no manual evidence) in the sandbox: the gate
   * reads the PR's real CI run in `run` mode, so demanding manual evidence here
   * would just be redundant bookkeeping. See AGENTS.md "receipt authoring".
   */
  ci_covered: z.boolean().optional(),
});

export const ExecutionEvidenceSchema = z.object({
  command: z.string().min(1),
  status: z.enum(["passed", "failed", "skipped"]),
  output_ref: z.string().optional(),
  skip_reason: z.string().optional(),
  /** Optional id of the validation_plan step this evidence is for (matches ValidationStep.id). */
  step: z.string().min(1).optional(),
});

export const ReceiptSchema = z.object({
  receipt_version: z.literal("1.0"),
  task_id: z.string().min(1).describe("Ticket/issue/bounty identifier"),
  agent_id: z.string().min(1).describe("Which agent (or human) did the work"),
  intent: z.string().min(40).describe("What this change is for, in plain language"),
  self_modifying: z
    .boolean()
    .describe("True if the change touches protected paths defined in policy"),
  policy_refs: z
    .array(z.string())
    .min(1)
    .describe("Which mission/policy documents the agent read (paths)"),
  validation_plan: z.array(ValidationStepSchema).min(1),
  execution_evidence: z.array(ExecutionEvidenceSchema).min(1),
  changed_files: z.array(z.string()).min(1),
  diff_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "diff_sha256 must be a 64-char lowercase hex SHA-256")
    .describe(
      "sha256 of `git diff <base>...HEAD -- . ':(exclude).plumbline/receipt.json' " +
        "':(exclude).plumbline/receipts/*.json' ':(exclude).proofgate/receipt.json' " +
        "':(exclude).proofgate/receipts/*.json'` — binds the receipt to the diff " +
        "content. The receipt file(s) are excluded so it's computable BEFORE " +
        "committing the receipt (a commit can never contain its own SHA), and so " +
        "the per-PR receipt at .plumbline/receipts/<task_id>.json (or legacy .proofgate/) doesn't affect it.",
    ),
  result_summary: z.string().min(40),
});

export type Receipt = z.infer<typeof ReceiptSchema>;

/** Machine-readable gate policy: the deterministic half of the constitution. */
export const PolicySchema = z.object({
  version: z.literal("1.0"),
  mission_file: z.string().default(".plumbline/MISSION.md"),
  /** Commands that MUST appear (as required steps) in every validation plan. */
  required_checks: z.array(z.string()).default([]),
  /**
   * GitHub check-run names that must actually CONCLUDE `success` for the PR
   * head commit. The gate (in CI `run` mode) reads the real check-runs — not
   * the receipt's self-reported `execution_evidence` — so a receipt can't
   * claim a passing suite the CI didn't actually pass. The agent need not
   * self-report status for these; CI is the source of truth. Empty = disabled
   * (self-report only). E.g. ["test"] to bind the repo's `test` CI job.
   */
  ci_evidence_checks: z.array(z.string()).default([]),
  /**
   * Glob patterns for protected surfaces. Changes matching these require
   * self_modifying: true and always route to human review — no auto-approve.
   */
  protected_paths: z.array(z.string()).default([]),
  /** Semantic review verdicts below this confidence are downgraded to review. */
  min_review_confidence: z.number().min(0).max(1).default(0.8),
  /**
   * How readily the semantic gate routes judgment calls to a HUMAN vs. lets an
   * AGENT handle them — the user's "how much goes to human review" dial:
   *   "low"      — send to human review only what genuinely needs a human; prefer agent_actions.
   *   "balanced" — send real trade-offs/ambiguity to human review (default).
   *   "high"     — when in doubt, send it to a human.
   * This tunes the human_actions/agent_actions split ONLY. It never lowers the
   * hard floor: protected_paths + self_modifying always require a human review,
   * regardless of this setting.
   */
  human_review_level: z.enum(["low", "balanced", "high"]).default("balanced"),
  /** Anthropic model used for semantic review. */
  review_model: z.string().default("claude-sonnet-4-6"),
  /** Max receipt size in bytes (anti garbage-dump). */
  max_receipt_bytes: z.number().default(262144),
  /**
   * Strictness preset — how much of the shape gate hard-fails vs warns:
   *   "strict"   (default) every finding is an error — today's behavior.
   *   "standard" `undeclared_files` + `receipt_size` warn instead of block.
   *   "lenient"  additionally `required_checks`, `evidence_coverage`,
   *              `ci_evidence` warn — only the un-downgradable floor blocks.
   * Per-check overrides live in `check_severity`. The floor (schema,
   * diff_integrity, protected_paths) can NEVER be relaxed by either knob.
   */
  strictness: z.enum(["strict", "standard", "lenient"]).default("strict"),
  /**
   * Per-check severity overrides: { "<check>": "error" | "warn" | "off" }.
   * Wins over the preset. Check names: schema, receipt_size, required_checks,
   * evidence_coverage, protected_paths, diff_integrity, undeclared_files,
   * ci_evidence. warn = shown in the PR comment, doesn't fail the gate;
   * off = suppressed with a note. Protected checks refuse downgrades.
   */
  check_severity: z.record(z.enum(["error", "warn", "off"])).default({}),
});

export type Policy = z.infer<typeof PolicySchema>;

/** Structured rework prompt — what the agent gets instead of a log dump. */
export interface FailureCapsule {
  failing_check: string;
  suspected_cause: string;
  next_action_requested: string;
  /**
   * Concrete fixes an AGENT can do right now — code, security, tests, docs.
   * Populated independently of verdict: a PR sent to human review can still
   * carry a list of agent-actionable items to tackle in parallel while a human
   * decides the human_actions. `[]` when there's genuinely nothing for an agent to do.
   */
  agent_actions?: string[];
  /**
   * Decisions only a HUMAN can make — protected/billing override, ambiguous
   * intent, an invariant trade-off, anything unverifiable from the evidence.
   * `[]` when nothing actually requires a human.
   */
  human_actions?: string[];
  changed_files_implicated: string[];
  relevant_excerpt?: string;
  severity: "fixable" | "fatal" | "review";
}

export type Verdict = "approve" | "rework" | "review";

export interface ShapeResult {
  pass: boolean;
  errors: string[];
  warnings: string[];
}

export interface ReviewResult {
  verdict: Verdict;
  confidence: number;
  validation_coverage_notes: string;
  mission_alignment_notes: string;
  risk_notes: string;
  failure_capsule?: FailureCapsule;
}

export interface GateResult {
  shape: ShapeResult;
  review?: ReviewResult;
  final: Verdict;
  reasons: string[];
}
