import { matchesAny } from "./glob.js";

/**
 * `plumb receipt --write/--check` — the mechanical half of a receipt,
 * automated end-to-end. Everything here is derivable bookkeeping (diff hash,
 * file list, protected-path escalation); the judgment fields (intent,
 * validation_plan, execution_evidence, result_summary) are NEVER generated —
 * automating those would defeat proof-carrying work. Automate the bookkeeping,
 * never the judgment.
 *
 * Derivation reuses the gate's own code paths (matchesAny over
 * policy.protected_paths; computeDiffSha256/gitDiffExcludingReceipt/
 * gitChangedFiles in the caller) so the scaffold and the gate can never
 * disagree about a hash or a glob.
 */

export interface ProtectedHit {
  file: string;
  glob: string;
}

/** Which changed files hit protected paths — the mechanical basis for self_modifying. */
export function protectedHits(changedFiles: string[], protectedPaths: string[]): ProtectedHit[] {
  const hits: ProtectedHit[] = [];
  for (const f of changedFiles) {
    const g = matchesAny(f, protectedPaths);
    if (g) hits.push({ file: f, glob: g });
  }
  return hits;
}

export interface MechanicalFields {
  diffSha256: string;
  changedFiles: string[];
  hits: ProtectedHit[];
}

export interface RefreshResult {
  receipt: Record<string, unknown>;
  /** Human-readable notes about what changed / was preserved. */
  notes: string[];
  changed: boolean;
}

/**
 * Refresh ONLY the mechanical fields of an existing receipt, preserving every
 * human-authored (judgment) field byte-for-byte. self_modifying is upgraded to
 * true when the diff touches protected paths; a voluntary `true` with no
 * protected hits is PRESERVED (the author may be escalating on purpose —
 * downgrading silently would remove a human-review request).
 */
export function refreshMechanical(
  receipt: Record<string, unknown>,
  mech: MechanicalFields,
): RefreshResult {
  const out = { ...receipt };
  const notes: string[] = [];
  let changed = false;

  if (out.diff_sha256 !== mech.diffSha256) {
    notes.push(
      `diff_sha256: ${String(out.diff_sha256 ?? "(unset)").slice(0, 12)}… → ${mech.diffSha256.slice(0, 12)}…`,
    );
    out.diff_sha256 = mech.diffSha256;
    changed = true;
  }
  const prevFiles = JSON.stringify(out.changed_files ?? []);
  if (prevFiles !== JSON.stringify(mech.changedFiles)) {
    notes.push(`changed_files: ${mech.changedFiles.length} file(s) from the actual diff`);
    out.changed_files = mech.changedFiles;
    changed = true;
  }

  const derived = mech.hits.length > 0;
  if (derived && out.self_modifying !== true) {
    out.self_modifying = true;
    notes.push(
      `self_modifying: → true (protected paths touched: ${mech.hits
        .map((h) => `${h.file} matches ${h.glob}`)
        .join(", ")})`,
    );
    changed = true;
  } else if (!derived && out.self_modifying === true) {
    notes.push(
      "self_modifying: left true (no protected paths touched — preserved as a voluntary escalation; set false yourself if unintended)",
    );
  }

  return { receipt: out, notes, changed };
}

/** The judgment fields the tool must never fill — printed as the author's checklist. */
export const JUDGMENT_CHECKLIST = [
  "intent — restate the ticket's contract: what this changes and why (≥40 chars)",
  "validation_plan — the commands that prove the change, each with a reason",
  "execution_evidence — the same commands you actually ran, status passed|failed|skipped",
  "result_summary — what shipped, what's proven, scope (≥40 chars)",
] as const;

/** True when a receipt's mechanical fields match the actual diff (for --check). */
export interface StalenessReport {
  fresh: boolean;
  problems: string[];
}

export function checkMechanical(
  receipt: Record<string, unknown>,
  mech: MechanicalFields,
): StalenessReport {
  const problems: string[] = [];
  if (receipt.diff_sha256 !== mech.diffSha256) {
    problems.push(
      `diff_sha256 is stale: receipt=${String(receipt.diff_sha256 ?? "(unset)")} actual=${mech.diffSha256}`,
    );
  }
  const declared = JSON.stringify(receipt.changed_files ?? []);
  if (declared !== JSON.stringify(mech.changedFiles)) {
    problems.push(
      `changed_files is stale: receipt declares ${(receipt.changed_files as unknown[] | undefined)?.length ?? 0} file(s), actual diff has ${mech.changedFiles.length}`,
    );
  }
  if (mech.hits.length > 0 && receipt.self_modifying !== true) {
    problems.push(
      `self_modifying must be true — protected paths touched: ${mech.hits
        .map((h) => `${h.file} (${h.glob})`)
        .join(", ")}`,
    );
  }
  return { fresh: problems.length === 0, problems };
}
