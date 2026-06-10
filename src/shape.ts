import { execFileSync } from "node:child_process";
import { ReceiptSchema, type Policy, type Receipt, type ShapeResult } from "./types.js";
import { matchesAny } from "./glob.js";

export interface ShapeOptions {
  /** Base ref for `git diff` (e.g. origin/main). Empty disables git checks. */
  baseRef?: string;
  /** Working directory of the repo under review. */
  cwd?: string;
  /** Skip git-dependent checks (fixture/unit testing). */
  skipGit?: boolean;
}

function gitChangedFiles(baseRef: string, cwd: string): string[] {
  const out = execFileSync(
    "git",
    ["diff", "--name-only", `${baseRef}...HEAD`],
    { cwd, encoding: "utf8" },
  );
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

function gitHeadSha(cwd: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
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
      errors.push(`schema: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    return { result: { pass: false, errors, warnings } };
  }
  const receipt = parsed.data;

  // 1. Every policy-required check must exist as a *required* plan step.
  for (const check of policy.required_checks) {
    const step = receipt.validation_plan.find((s) => s.command.includes(check));
    if (!step) {
      errors.push(`required check missing from validation_plan: "${check}"`);
    } else if (!step.required) {
      errors.push(`required check is marked optional in validation_plan: "${check}"`);
    }
  }

  // 2. Every required plan step must have passing evidence.
  for (const step of receipt.validation_plan) {
    const ev = receipt.execution_evidence.find((e) => e.command === step.command);
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

  // 4. Git integrity: receipt must account for the actual diff.
  if (!opts.skipGit) {
    const cwd = opts.cwd ?? process.cwd();
    try {
      const actualSha = gitHeadSha(cwd);
      if (actualSha !== receipt.head_sha) {
        errors.push(`head_sha mismatch: receipt=${receipt.head_sha} actual=${actualSha}`);
      }
      if (opts.baseRef) {
        const actual = gitChangedFiles(opts.baseRef, cwd);
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
