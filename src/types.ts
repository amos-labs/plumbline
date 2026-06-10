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
});

export const ExecutionEvidenceSchema = z.object({
  command: z.string().min(1),
  status: z.enum(["passed", "failed", "skipped"]),
  output_ref: z.string().optional(),
  skip_reason: z.string().optional(),
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
      "sha256 of `git diff <base>...HEAD -- . ':(exclude).proofgate/receipt.json'` — " +
        "binds the receipt to the diff content. Computable BEFORE committing the " +
        "receipt (a commit can never contain its own SHA, which is why head_sha " +
        "could not work), and stable across GitHub's synthetic merge-ref checkout.",
    ),
  result_summary: z.string().min(40),
});

export type Receipt = z.infer<typeof ReceiptSchema>;

/** Machine-readable gate policy: the deterministic half of the constitution. */
export const PolicySchema = z.object({
  version: z.literal("1.0"),
  mission_file: z.string().default(".proofgate/MISSION.md"),
  /** Commands that MUST appear (as required steps) in every validation plan. */
  required_checks: z.array(z.string()).default([]),
  /**
   * Glob patterns for protected surfaces. Changes matching these require
   * self_modifying: true and always escalate to a human — no auto-approve.
   */
  protected_paths: z.array(z.string()).default([]),
  /** Semantic review verdicts below this confidence are downgraded to escalate. */
  min_review_confidence: z.number().min(0).max(1).default(0.8),
  /** Anthropic model used for semantic review. */
  review_model: z.string().default("claude-sonnet-4-6"),
  /** Max receipt size in bytes (anti garbage-dump). */
  max_receipt_bytes: z.number().default(262144),
});

export type Policy = z.infer<typeof PolicySchema>;

/** Structured rework prompt — what the agent gets instead of a log dump. */
export interface FailureCapsule {
  failing_check: string;
  suspected_cause: string;
  next_action_requested: string;
  changed_files_implicated: string[];
  relevant_excerpt?: string;
  severity: "fixable" | "fatal" | "escalation";
}

export type Verdict = "approve" | "revise" | "escalate";

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
