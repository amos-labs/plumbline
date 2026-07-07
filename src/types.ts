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
  /** Default model used for semantic review (provider-specific model id). */
  review_model: z.string().default("claude-sonnet-4-6"),
  /**
   * Which LLM provider backs the semantic review. "anthropic" (default) or
   * "openai" (any OpenAI-compatible Chat Completions endpoint). The prompt and
   * the approve/rework/review verdict schema are provider-independent — this
   * only swaps the transport. Env var PLUMBLINE_PROVIDER overrides this.
   * "no lock-in on intelligence": adopters can use their own vendor or a
   * self-hosted model.
   */
  review_provider: z.enum(["anthropic", "openai"]).default("anthropic"),
  /**
   * Optional base URL for the review provider. Required for "openai" (e.g.
   * https://api.openai.com/v1 or a self-hosted endpoint); an optional endpoint
   * override for "anthropic" (proxy/gateway). Env var PLUMBLINE_API_BASE
   * overrides this.
   */
  review_api_base: z.string().optional(),
  /**
   * Cost control (issue #26) — skip the LLM review for low-risk diffs, passing
   * on the shape gate alone. ALL OPT-IN; defaults keep review running. The
   * hard floor is never skippable: self_modifying / protected_paths changes
   * always get a real semantic review regardless of these flags.
   */
  skip_review: z
    .object({
      /** Skip when every changed file is documentation (.md/.rst/.txt/…). */
      docs_only: z.boolean().default(false),
      /** Skip when every changed file is config (.json/.yaml/.toml/…) or docs. */
      config_only: z.boolean().default(false),
      /** Skip when the diff is smaller than this many characters. 0 = disabled. */
      below_diff_chars: z.number().int().min(0).default(0),
    })
    .default({}),
  /**
   * Budget / model-tier control (issue #26). All opt-in.
   *   use_cheap_model — when true and cheap_model set, use the cheaper model.
   *   cheap_model     — a lower-cost model id for routine reviews.
   *   max_usd_per_pr  — optional soft spend cap per PR (0 = no cap). Informational
   *                     ceiling recorded for audit; the gate warns if exceeded.
   */
  budget: z
    .object({
      use_cheap_model: z.boolean().default(false),
      cheap_model: z.string().optional(),
      max_usd_per_pr: z.number().min(0).default(0),
    })
    .default({}),
  /**
   * Verdict cache (issue #26). When enabled, an identical diff (by diff_sha256,
   * scoped to provider+model+prompt version) reuses the prior verdict instead
   * of re-calling the LLM. Opt-in; disabled by default.
   */
  review_cache: z
    .object({
      enabled: z.boolean().default(false),
      /** Directory for cache files (relative to repo root). */
      dir: z.string().default(".plumbline/cache/review"),
    })
    .default({}),
  /**
   * Sampling temperature for the review call. OPTIONAL and OMITTED by default:
   * some Anthropic models reject an explicit `temperature`, so the gate sends
   * none unless you set this — the backend then uses its own (low) default.
   * Set it (e.g. 0) to pin determinism where the model supports it. Recorded in
   * the review audit output. Env override: PLUMBLINE_TEMPERATURE.
   */
  review_temperature: z.number().min(0).max(2).optional(),
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
  /**
   * Determinism/audit metadata (issue #26) — recorded so a verdict is
   * reproducible and explainable: which provider/model produced it, at what
   * temperature, under which prompt version, and whether it was served from
   * cache. Optional so older/hand-built ReviewResults stay valid.
   */
  audit?: {
    provider?: string;
    model?: string;
    prompt_version?: string;
    temperature?: number;
    /** True when this verdict was reused from the diff_sha256 cache. */
    cached?: boolean;
  };
}

export interface GateResult {
  shape: ShapeResult;
  review?: ReviewResult;
  final: Verdict;
  reasons: string[];
}
