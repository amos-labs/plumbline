import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { matchesAny } from "./glob.js";
import type { Policy, Receipt, ReviewResult } from "./types.js";

/**
 * Cost + determinism controls for the semantic review (issue #26).
 *
 * The semantic review IS the differentiated value — these controls reduce spend
 * WITHOUT ever silently weakening judgment:
 *  - low-risk diffs (docs/config only, or below a size threshold) can pass on
 *    the shape gate alone — but protected-path / self_modifying changes NEVER
 *    skip;
 *  - identical diffs (by diff_sha256) reuse a cached verdict;
 *  - all of it is OPT-IN via policy; defaults preserve today's behavior (review
 *    always runs).
 */

export interface SkipDecision {
  skip: boolean;
  /** Human-readable reason, surfaced in the gate reasons/CI comment. */
  reason: string;
}

/** File extensions treated as documentation for the docs-only skip. */
const DOC_EXT = /\.(md|markdown|mdx|rst|txt|adoc)$/i;
/** File extensions/basenames treated as configuration for the config-only skip. */
const CONFIG_EXT = /\.(json|ya?ml|toml|ini|cfg|conf|env|lock|editorconfig|gitignore|gitattributes)$/i;
const CONFIG_BASENAME = /(^|\/)(\.gitignore|\.gitattributes|\.editorconfig|\.npmrc|\.nvmrc|LICENSE)$/i;

function isDocFile(f: string): boolean {
  return DOC_EXT.test(f);
}
function isConfigFile(f: string): boolean {
  return CONFIG_EXT.test(f) || CONFIG_BASENAME.test(f);
}

/**
 * Decide whether the semantic LLM review may be skipped for this receipt/diff,
 * relying on the shape gate alone.
 *
 * HARD FLOOR (never skipped, regardless of config):
 *  - receipt.self_modifying === true, OR
 *  - any changed file matches a policy.protected_paths glob.
 *
 * Then, only if the corresponding opt-in is enabled:
 *  - docs-only:   every changed file is documentation.
 *  - config-only: every changed file is config (or docs).
 *  - small-diff:  diff character count is below skip_review_below_diff_chars.
 *
 * Defaults are all disabled → returns { skip:false } → review runs as today.
 */
export function shouldSkipReview(
  receipt: Receipt,
  policy: Policy,
  diff: string,
): SkipDecision {
  const s = policy.skip_review;
  // Nothing enabled → never skip (default behavior).
  if (!s || (!s.docs_only && !s.config_only && (s.below_diff_chars ?? 0) <= 0)) {
    return { skip: false, reason: "" };
  }

  // Hard floor: protected / self-modifying always get a real review.
  if (receipt.self_modifying) {
    return { skip: false, reason: "self_modifying — protected review floor, never skipped" };
  }
  const files = receipt.changed_files ?? [];
  const protectedHit = files.map((f) => matchesAny(f, policy.protected_paths)).find(Boolean);
  if (protectedHit) {
    return { skip: false, reason: `protected path touched (${protectedHit}) — never skipped` };
  }

  if (s.docs_only && files.length > 0 && files.every(isDocFile)) {
    return { skip: true, reason: `docs-only change (${files.length} file(s)) — shape gate only` };
  }

  if (s.config_only && files.length > 0 && files.every((f) => isConfigFile(f) || isDocFile(f))) {
    return { skip: true, reason: `config/docs-only change (${files.length} file(s)) — shape gate only` };
  }

  const threshold = s.below_diff_chars ?? 0;
  if (threshold > 0 && diff.length > 0 && diff.length < threshold) {
    return {
      skip: true,
      reason: `diff is ${diff.length} chars, below skip threshold ${threshold} — shape gate only`,
    };
  }

  return { skip: false, reason: "" };
}

/**
 * Redundant, independent protected-path / self_modifying floor. Returns a
 * human-readable reason when the change MUST get a real review (never skip,
 * never approve on the skip path), else null.
 *
 * This duplicates the floor already inside {@link shouldSkipReview} on purpose:
 * it's a defense-in-depth check the CLI runs a second time, from the ACTUAL
 * changed files (not only the receipt's self-report), so a bug in
 * shouldSkipReview can't leak a protected change onto the auto-approve path.
 * Pure — the caller supplies the actual changed files.
 */
export function protectedFloor(
  receipt: Pick<Receipt, "self_modifying" | "changed_files">,
  policy: Pick<Policy, "protected_paths">,
  actualFiles: string[],
): string | null {
  if (receipt.self_modifying) return "receipt.self_modifying is true";
  // Union of receipt-declared and actual diff files — either touching a
  // protected path forces review.
  const files = new Set([...(receipt.changed_files ?? []), ...actualFiles]);
  for (const f of files) {
    const hit = matchesAny(f, policy.protected_paths);
    if (hit) return `${f} matches protected path ${hit}`;
  }
  return null;
}

/** On-disk cache entry, keyed by diff_sha256. */
interface CacheEntry {
  diff_sha256: string;
  provider: string;
  model: string;
  prompt_version: string;
  review: ReviewResult;
  cached_at: string;
}

function cacheFilePath(cacheDir: string, diffSha256: string): string {
  return join(cacheDir, `${diffSha256}.json`);
}

/**
 * Look up a cached verdict for this diff. A hit requires an EXACT match on
 * diff_sha256 AND on provider/model/prompt_version — a cache made under a
 * different model or prompt is not reused, so switching models never serves a
 * stale judgment. Returns null on miss or any read/parse error (fail-open to a
 * live review).
 */
export function readReviewCache(
  cacheDir: string,
  diffSha256: string,
  provider: string,
  model: string,
  promptVersion: string,
): ReviewResult | null {
  try {
    const p = cacheFilePath(cacheDir, diffSha256);
    if (!existsSync(p)) return null;
    const entry = JSON.parse(readFileSync(p, "utf8")) as CacheEntry;
    if (
      entry.diff_sha256 === diffSha256 &&
      entry.provider === provider &&
      entry.model === model &&
      entry.prompt_version === promptVersion &&
      entry.review
    ) {
      return entry.review;
    }
    return null;
  } catch {
    return null;
  }
}

/** Persist a verdict for reuse on an identical diff. Best-effort (never throws). */
export function writeReviewCache(
  cacheDir: string,
  diffSha256: string,
  provider: string,
  model: string,
  promptVersion: string,
  review: ReviewResult,
): void {
  try {
    const p = cacheFilePath(cacheDir, diffSha256);
    mkdirSync(dirname(p), { recursive: true });
    const entry: CacheEntry = {
      diff_sha256: diffSha256,
      provider,
      model,
      prompt_version: promptVersion,
      review,
      cached_at: new Date().toISOString(),
    };
    writeFileSync(p, JSON.stringify(entry, null, 2));
  } catch {
    /* cache is an optimization; a write failure must never break the gate */
  }
}

/**
 * Resolve the model to use, applying the optional cheaper-model tier. When
 * policy.budget.cheap_model is set AND budget.use_cheap_model is true, that
 * model wins over the normal review_model. Env override (PLUMBLINE_MODEL /
 * PROOFGATE_MODEL) still takes ultimate precedence — handled by the caller.
 */
export function resolveModel(policy: Policy): string {
  const b = policy.budget;
  if (b?.use_cheap_model && b.cheap_model) return b.cheap_model;
  return policy.review_model;
}
