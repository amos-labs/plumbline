import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

/**
 * Stack presets — the second layer of batteries-included `init`. The
 * language-agnostic core (gate workflow + poll-wait + .plumbline/ + conventions)
 * always ships; a detected (or `--stack`-forced) preset layers stack-specific
 * CI that encodes what we learned setting the same thing up by hand across every
 * repo: a migration-version-collision guard, rust-cache on the test jobs, and
 * parallelized (no `needs:` chain) CI. Presets are a STARTING POINT — everything
 * is a plain file the repo can edit or delete.
 */

/** Known stack presets. Extend by adding a detector + a `templates/stack/<id>/`. */
export type StackId = "rust-sqlx";

export const KNOWN_STACKS: StackId[] = ["rust-sqlx"];

export function isStackId(s: string): s is StackId {
  return (KNOWN_STACKS as string[]).includes(s);
}

/**
 * Detect the repo's stack preset. `rust-sqlx` = a Cargo project that uses sqlx
 * with a `migrations/` directory — the shape of every AMOS repo, and the one
 * the migration-version-collision guard is built for. Returns `undefined` when
 * nothing matches (core-only init). Pure over the filesystem.
 */
export function detectStack(cwd: string): StackId | undefined {
  const cargo = join(cwd, "Cargo.toml");
  if (!existsSync(cargo)) return undefined;
  const hasMigrations = existsSync(join(cwd, "migrations"));
  if (!hasMigrations) return undefined;
  // sqlx shows up either as a dependency in Cargo.toml (workspace root or crate)
  // or via a Cargo.lock entry — check both so workspaces with sqlx in a member
  // crate still detect.
  let usesSqlx = false;
  try {
    if (/(^|\n)\s*sqlx\b/.test(readFileSync(cargo, "utf8"))) usesSqlx = true;
  } catch {
    /* unreadable — fall through to lockfile */
  }
  if (!usesSqlx) {
    const lock = join(cwd, "Cargo.lock");
    try {
      if (existsSync(lock) && /name = "sqlx"/.test(readFileSync(lock, "utf8"))) usesSqlx = true;
    } catch {
      /* ignore */
    }
  }
  return usesSqlx ? "rust-sqlx" : undefined;
}

/** True if the repo has a Dockerfile at the root (drives cargo-chef layering hints). */
export function hasDockerfile(cwd: string): boolean {
  return existsSync(join(cwd, "Dockerfile"));
}

// ── Migration-version-collision guard (pure logic) ────────────────────────
//
// The failure this prevents: two parallel branches each add a migration, both
// pass CI in isolation, both merge — and now `main` has two migrations that
// sqlx orders ambiguously (or a lower-versioned migration lands AFTER a higher
// one already applied in prod). sqlx keys migrations by the leading numeric
// version in the filename. The guard rejects a PR whose NEW migration's version
// is <= the max version already on the base branch: a new migration must always
// sort strictly after everything already merged.

/** sqlx migration filenames lead with a numeric version, e.g.
 *  `20260527000057_seed.sql` or `0001_init.sql`. Extract it as a bigint-safe
 *  string→number; returns null for a file that isn't a versioned migration. */
export function migrationVersion(filename: string): number | null {
  const base = filename.replace(/^.*\//, "");
  const m = base.match(/^(\d+)_/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}

/** The max migration version among a set of migration filenames (0 if none). */
export function maxMigrationVersion(files: string[]): number {
  let max = 0;
  for (const f of files) {
    const v = migrationVersion(f);
    if (v !== null && v > max) max = v;
  }
  return max;
}

export interface CollisionResult {
  ok: boolean;
  errors: string[];
  /** The new migration versions checked (for reporting). */
  added: number[];
  baseMax: number;
}

/**
 * Pure decision: does the PR's set of NEW migration versions clear the base
 * branch's max? Every newly-added migration version must be strictly greater
 * than `baseMax`. Kept pure (no git/network) so it's directly unit-testable —
 * the CI job just feeds it the two file lists.
 */
export function checkMigrationCollision(addedFiles: string[], baseFiles: string[]): CollisionResult {
  const baseMax = maxMigrationVersion(baseFiles);
  const errors: string[] = [];
  const added: number[] = [];
  for (const f of addedFiles) {
    const v = migrationVersion(f);
    if (v === null) continue; // not a versioned migration (README, .keep, etc.)
    added.push(v);
    if (v <= baseMax) {
      errors.push(
        `migration "${f.replace(/^.*\//, "")}" has version ${v} <= base branch max ${baseMax}. ` +
          `A new migration must sort strictly AFTER everything already merged — ` +
          `rename it with a fresh full-timestamp version (e.g. \`date -u +%Y%m%d%H%M%S\`) so parallel branches never collide.`,
      );
    }
  }
  return { ok: errors.length === 0, errors, added, baseMax };
}

/** List migration filenames (basenames) in a directory; [] if it doesn't exist. */
export function listMigrations(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => /^\d+_.*\.(sql|up\.sql)$/.test(f) || /^\d+_/.test(f));
  } catch {
    return [];
  }
}

/**
 * Run the migration-collision guard against a working tree + base ref. Used by
 * the `plumb migration-guard` command that the scaffolded CI job invokes.
 * Reads the base branch's migrations via `git ls-tree` (no checkout) and the
 * PR's added migrations via `git diff --name-only --diff-filter=A`.
 */
export function runMigrationGuard(
  cwd: string,
  baseRef: string,
  migrationsDir = "migrations",
): CollisionResult {
  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });

  // Base branch migration files (names only) — from the ref's tree, not the
  // working copy, so a not-yet-merged base is read correctly.
  let baseFiles: string[] = [];
  try {
    baseFiles = git(["ls-tree", "-r", "--name-only", baseRef, "--", migrationsDir])
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    baseFiles = [];
  }

  // Files ADDED (A) in this PR under migrations/.
  let added: string[] = [];
  try {
    added = git(["diff", "--name-only", "--diff-filter=A", `${baseRef}...HEAD`, "--", migrationsDir])
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    added = [];
  }

  return checkMigrationCollision(added, baseFiles);
}
