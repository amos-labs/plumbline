import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { ZodIssue } from "zod";
import { ReceiptSchema, type Policy, type Receipt, type ShapeResult } from "./types.js";
import { matchesAny } from "./glob.js";

/**
 * Turn a zod issue into a self-correcting message: for any constrained field
 * (enum, literal, min-length, min-items, regex) the message NAMES the allowed
 * set + what was received, so a failed `proofgate check` tells the agent exactly
 * what to write — no learning a constraint by failing the gate. (The concrete
 * trap that motivated this: `execution_evidence[].status` only accepts
 * passed|failed|skipped, but an author used "deferred-to-ci".)
 */
export function formatZodIssue(issue: ZodIssue): string {
  const path = issue.path.join(".") || "(root)";
  switch (issue.code) {
    case "invalid_enum_value":
      return `${path} must be one of: ${issue.options.join(" | ")} (got ${JSON.stringify(issue.received)})`;
    case "invalid_literal":
      return `${path} must be ${JSON.stringify(issue.expected)} (got ${JSON.stringify(issue.received)})`;
    case "too_small": {
      const unit = issue.type === "string" ? "character(s)" : issue.type === "array" ? "item(s)" : "";
      return `${path} must have at least ${issue.minimum} ${unit}`.trimEnd();
    }
    case "invalid_type":
      return `${path} must be a ${issue.expected} (got ${issue.received})`;
    default:
      // invalid_string (regex), etc. — zod's own message already carries the rule
      // (e.g. diff_sha256's "64-char lowercase hex SHA-256").
      return `${path}: ${issue.message}`;
  }
}

/**
 * Canonical receipt binding: sha256 over the diff EXCLUDING the receipt
 * file(s). The exclusion is what makes this computable before the receipt
 * is committed — a commit can never contain its own SHA, so the old
 * head_sha binding was unsatisfiable for an in-repo receipt.
 *
 * Both the legacy single-file path and the per-PR receipts directory are
 * excluded. The directory form (`.proofgate/receipts/<task_id>.json`, one
 * file per PR) is what lets many PRs be open at once without ever
 * conflicting on a shared receipt file.
 */
export const RECEIPT_DIFF_SPEC = [
  "--",
  ".",
  ":(exclude).proofgate/receipt.json",
  ":(exclude).proofgate/receipts/*.json",
] as const;

/** True for any path that is itself a proof receipt (not real changed work). */
export function isReceiptPath(file: string): boolean {
  return file === ".proofgate/receipt.json" || /^\.proofgate\/receipts\/[^/]+\.json$/.test(file);
}

export function computeDiffSha256(diff: string): string {
  return createHash("sha256").update(diff, "utf8").digest("hex");
}

/**
 * A validation-plan command satisfies a required check only at token
 * boundaries — `bundle exec rspec spec/foo_spec.rb` matches the check
 * "bundle exec rspec"; `echo "bundle exec rspec"` does not. Plain
 * substring matching let quoted/commented commands satisfy the policy.
 */
export function commandMatchesCheck(command: string, check: string): boolean {
  const escaped = check.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)${escaped}(\\s|$)`).test(command);
}

/**
 * Evidence satisfies a plan step when its command IS the step's command,
 * allowing only a trailing PARENTHETICAL or `#` annotation: the step
 * "bundle exec rspec spec/foo_spec.rb" is satisfied by evidence
 * "bundle exec rspec spec/foo_spec.rb  (re-ran with the fix stashed)" or
 * "... # 3 examples". This kills the most common false-negative (a note in
 * the command field) WITHOUT letting extra arguments through — otherwise a
 * narrower run ("bundle exec rspec spec/foo") would wrongly satisfy a broader
 * required step ("bundle exec rspec") and could even mask a failed full-suite
 * evidence entry.
 */
export function evidenceSatisfiesStep(evidenceCommand: string, stepCommand: string): boolean {
  const ev = evidenceCommand.trim();
  const step = stepCommand.trim();
  if (ev === step) return true;
  if (!ev.startsWith(step)) return false;
  return /^\s*[(#]/.test(ev.slice(step.length));
}

export interface ShapeOptions {
  /** Base ref for `git diff` (e.g. origin/main). Empty disables git checks. */
  baseRef?: string;
  /** Working directory of the repo under review. */
  cwd?: string;
  /** Skip git-dependent checks (fixture/unit testing). */
  skipGit?: boolean;
}

export function gitChangedFiles(baseRef: string, cwd: string): string[] {
  const out = execFileSync(
    "git",
    ["diff", "--name-only", `${baseRef}...HEAD`],
    { cwd, encoding: "utf8" },
  );
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

export function gitDiffExcludingReceipt(baseRef: string, cwd: string): string {
  return execFileSync(
    "git",
    ["diff", `${baseRef}...HEAD`, ...RECEIPT_DIFF_SPEC],
    { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
}

/**
 * Deterministic shape gate. No LLM involved. Everything here is a hard
 * mechanical fact: schema validity, evidence coverage, protected paths,
 * SHA integrity. The relay-side equivalent in AMOS is the receipt shape gate.
 */
export function shapeCheck(
  rawReceipt: string,
  policy: Policy,
  opts: ShapeOptions = {},
): { result: ShapeResult; receipt?: Receipt } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (Buffer.byteLength(rawReceipt, "utf8") > policy.max_receipt_bytes) {
    return {
      result: {
        pass: false,
        errors: [`receipt exceeds max size of ${policy.max_receipt_bytes} bytes`],
        warnings,
      },
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawReceipt);
  } catch (e) {
    return {
      result: { pass: false, errors: [`receipt is not valid JSON: ${String(e)}`], warnings },
    };
  }

  const parsed = ReceiptSchema.safeParse(parsedJson);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(`schema: ${formatZodIssue(issue)}`);
    }
    return { result: { pass: false, errors, warnings } };
  }
  const receipt = parsed.data;

  // 1. Every policy-required check must exist as a *required* plan step.
  // Token-boundary matching: quoted/echoed commands don't count.
  for (const check of policy.required_checks) {
    const step = receipt.validation_plan.find((s) => commandMatchesCheck(s.command, check));
    if (!step) {
      errors.push(`required check missing from validation_plan: "${check}"`);
    } else if (!step.required) {
      errors.push(`required check is marked optional in validation_plan: "${check}"`);
    }
  }

  // 2. Every required plan step must have passing evidence.
  for (const step of receipt.validation_plan) {
    const ev = receipt.execution_evidence.find((e) => evidenceSatisfiesStep(e.command, step.command));
    if (!ev) {
      if (step.required) errors.push(`no execution evidence for required step: "${step.command}"`);
      else warnings.push(`no execution evidence for optional step: "${step.command}"`);
      continue;
    }
    if (step.required && ev.status !== "passed") {
      errors.push(
        `required step "${step.command}" has status "${ev.status}"${ev.skip_reason ? ` (skip_reason: ${ev.skip_reason})` : ""}`,
      );
    }
  }

  // 3. Protected paths require self_modifying: true.
  const protectedHits: string[] = [];
  for (const f of receipt.changed_files) {
    const hit = matchesAny(f, policy.protected_paths);
    if (hit) protectedHits.push(`${f} (matches ${hit})`);
  }
  if (protectedHits.length > 0 && !receipt.self_modifying) {
    errors.push(
      `changed files touch protected paths but self_modifying is false: ${protectedHits.join(", ")}`,
    );
  }
  if (receipt.self_modifying && protectedHits.length === 0) {
    warnings.push("self_modifying is true but no changed files match protected paths");
  }

  // 4. Git integrity: receipt must account for the actual diff. The
  // binding is a content hash of the diff (receipt file excluded), so
  // it survives both the receipt's own commit and GitHub's synthetic
  // merge-ref checkout — neither of which a head SHA could.
  if (!opts.skipGit) {
    const cwd = opts.cwd ?? process.cwd();
    try {
      if (!opts.baseRef) {
        warnings.push("no base ref provided — diff integrity (diff_sha256) not verified");
      }
      if (opts.baseRef) {
        const actualHash = computeDiffSha256(gitDiffExcludingReceipt(opts.baseRef, cwd));
        if (actualHash !== receipt.diff_sha256) {
          errors.push(
            `diff_sha256 mismatch: receipt=${receipt.diff_sha256} actual=${actualHash} ` +
              `(compute with: git diff ${opts.baseRef}...HEAD -- . ':(exclude).proofgate/receipt.json' ':(exclude).proofgate/receipts/*.json' | sha256)`,
          );
        }
        // The receipt file(s) themselves are never "changed work" — exclude
        // them so an agent never has to declare its own receipt (circular)
        // and so a receipt under .proofgate/ doesn't trip the protected-path
        // rule and force self_modifying on otherwise-ordinary PRs.
        const actual = gitChangedFiles(opts.baseRef, cwd).filter((f) => !isReceiptPath(f));
        const declared = new Set(receipt.changed_files);
        const undeclared = actual.filter((f) => !declared.has(f));
        if (undeclared.length > 0) {
          errors.push(`files changed but not declared in receipt: ${undeclared.join(", ")}`);
        }
        const phantom = receipt.changed_files.filter((f) => !actual.includes(f));
        if (phantom.length > 0) {
          warnings.push(`receipt declares files with no diff vs ${opts.baseRef}: ${phantom.join(", ")}`);
        }
        // Re-run protected check against the *actual* diff, not just declared files.
        for (const f of actual) {
          const hit = matchesAny(f, policy.protected_paths);
          if (hit && !receipt.self_modifying) {
            errors.push(`actual diff touches protected path ${f} (matches ${hit}) but self_modifying is false`);
          }
        }
      }
    } catch (e) {
      errors.push(`git check failed: ${String(e)}`);
    }
  }

  return { result: { pass: errors.length === 0, errors, warnings }, receipt };
}
