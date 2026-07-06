import type { Policy } from "./types.js";

/**
 * Editable strictness — WHICH findings gate at WHICH level.
 *
 * Every shape/CI finding carries a check name from CHECK_NAMES. The policy can
 * tune each check via `check_severity` ("error" | "warn" | "off") or pick a
 * `strictness` preset. Resolution order (later wins):
 *
 *     error (base)  →  strictness preset  →  check_severity[check]
 *
 * HARD FLOOR — never downgradable, by design (they ARE the tool):
 *   - `diff_integrity`   the diff_sha256 binding: without it a receipt proves nothing
 *   - `protected_paths`  the self_modifying human-review routing: the human-review guarantee
 *   - `schema`           structural validity: an unparseable receipt can't be evaluated
 * A policy that tries to downgrade one gets a warning and stays "error".
 */

export type Severity = "error" | "warn" | "off";

export const CHECK_NAMES = [
  "schema",
  "receipt_size",
  "required_checks",
  "evidence_coverage",
  "protected_paths",
  "diff_integrity",
  "undeclared_files",
  "ci_evidence",
] as const;

export type CheckName = (typeof CHECK_NAMES)[number];

/** Checks that can never be downgraded below "error". */
export const PROTECTED_CHECKS: readonly CheckName[] = [
  "schema",
  "diff_integrity",
  "protected_paths",
];

/**
 * Presets — documented relaxations, chosen so each tier stays honest:
 *   strict   (default) today's behavior: everything is an error.
 *   standard relaxes the two most bureaucratic checks — an out-of-date file
 *            list (`undeclared_files`) and an oversized receipt
 *            (`receipt_size`) — while evidence and required checks still gate.
 *   lenient  additionally lets evidence bookkeeping warn instead of block:
 *            `required_checks`, `evidence_coverage`, `ci_evidence`. The gate
 *            then only HARD-fails on the un-downgradable floor (schema, diff
 *            integrity, protected paths) — useful while a team is adopting.
 */
export const STRICTNESS_PRESETS: Record<string, Partial<Record<CheckName, Severity>>> = {
  strict: {},
  standard: {
    undeclared_files: "warn",
    receipt_size: "warn",
  },
  lenient: {
    undeclared_files: "warn",
    receipt_size: "warn",
    required_checks: "warn",
    evidence_coverage: "warn",
    ci_evidence: "warn",
  },
};

/** Resolve the effective severity for one check under a policy. */
export function resolveSeverity(check: CheckName, policy: Policy): Severity {
  let sev: Severity = "error";
  const preset = STRICTNESS_PRESETS[policy.strictness] ?? {};
  if (preset[check]) sev = preset[check]!;
  const explicit = policy.check_severity[check] as Severity | undefined;
  if (explicit) sev = explicit;
  if (PROTECTED_CHECKS.includes(check) && sev !== "error") return "error";
  return sev;
}

/**
 * Policy-config lint, run once per gate: refused protected downgrades and
 * unknown check names each produce a warning so a typo'd or overreaching
 * `check_severity` is visible instead of silently ignored.
 */
export function validateSeverityConfig(policy: Policy): string[] {
  const warnings: string[] = [];
  for (const [name, sev] of Object.entries(policy.check_severity)) {
    if (!(CHECK_NAMES as readonly string[]).includes(name)) {
      warnings.push(
        `check_severity: unknown check "${name}" — known checks: ${CHECK_NAMES.join(", ")}`,
      );
      continue;
    }
    if (PROTECTED_CHECKS.includes(name as CheckName) && sev !== "error") {
      warnings.push(
        `check_severity: "${name}" cannot be downgraded (diff integrity / self_modifying human-review routing / ` +
          `schema validity are the point of the tool) — staying "error"`,
      );
    }
  }
  for (const [name, sev] of Object.entries(STRICTNESS_PRESETS[policy.strictness] ?? {})) {
    // Presets never contain protected checks; this guards future edits.
    if (PROTECTED_CHECKS.includes(name as CheckName) && sev !== "error") {
      warnings.push(`strictness preset "${policy.strictness}" tried to downgrade protected "${name}" — ignored`);
    }
  }
  return warnings;
}

/** A finding tagged with the check that produced it, pre-severity. */
export interface Finding {
  check: CheckName;
  message: string;
}

/**
 * Split findings into errors/warnings per the policy's severities. "off"
 * findings are suppressed to a single per-check count note (a skipped check
 * is still visible — just not enforced).
 */
export function applySeverities(
  findings: Finding[],
  policy: Policy,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const suppressed = new Map<CheckName, number>();
  for (const f of findings) {
    const sev = resolveSeverity(f.check, policy);
    if (sev === "error") errors.push(f.message);
    else if (sev === "warn") warnings.push(`[${f.check}: warn] ${f.message}`);
    else suppressed.set(f.check, (suppressed.get(f.check) ?? 0) + 1);
  }
  for (const [check, n] of suppressed) {
    warnings.push(`severity(off): suppressed ${n} finding(s) from check "${check}" — not enforced by policy`);
  }
  return { errors, warnings };
}
