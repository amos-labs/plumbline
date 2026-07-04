/**
 * Config-dir resolution for the proofgate → Plumbline rename.
 *
 * `.plumbline/` is the canonical directory; `.proofgate/` (the tool's old
 * name) remains fully supported so existing repos keep working untouched.
 * Reads and writes both go through {@link baseDir}: an existing `.plumbline`
 * wins, else an existing `.proofgate`, else fresh repos get `.plumbline`.
 *
 * The receipt schema itself (field names, receipt_version) is unchanged by
 * the rename — the standard is sovereign; only the tool renamed.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Canonical config dir — the plumb line of Amos 7:7-8, the tool's namesake. */
export const CANONICAL_DIR = ".plumbline";
/** Legacy config dir from the proofgate era. Still fully supported. */
export const LEGACY_DIR = ".proofgate";

/**
 * Resolve the repo's config dir: `.plumbline` when present, else `.proofgate`
 * when present (back-compat), else `.plumbline` (fresh repos get the
 * canonical name). Deterministic per working tree, so the local CLI and the
 * CI gate always agree.
 */
export function baseDir(cwd: string): string {
  if (existsSync(join(cwd, CANONICAL_DIR))) return CANONICAL_DIR;
  if (existsSync(join(cwd, LEGACY_DIR))) return LEGACY_DIR;
  return CANONICAL_DIR;
}

/**
 * Dual-dir fallback for an explicit-or-default path: if `path` doesn't exist
 * but its twin under the other config dir does, return the twin. Keeps
 * defaults like `.plumbline/policy.json` working in legacy `.proofgate/`
 * repos (and vice versa) without the caller caring which era the repo is from.
 */
export function resolveDualPath(cwd: string, path: string): string {
  if (existsSync(join(cwd, path))) return path;
  let twin: string | undefined;
  if (path.startsWith(`${CANONICAL_DIR}/`)) {
    twin = LEGACY_DIR + path.slice(CANONICAL_DIR.length);
  } else if (path.startsWith(`${LEGACY_DIR}/`)) {
    twin = CANONICAL_DIR + path.slice(LEGACY_DIR.length);
  }
  if (twin && existsSync(join(cwd, twin))) return twin;
  return path;
}
