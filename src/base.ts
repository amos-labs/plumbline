import { execFileSync } from "node:child_process";

/** A thin git runner: returns trimmed stdout, or null on any failure. */
export type GitTry = (args: string[]) => string | null;

export function gitTry(cwd: string): GitTry {
  return (args: string[]): string | null => {
    try {
      return execFileSync("git", args, { cwd, encoding: "utf8" }).trim() || null;
    } catch {
      return null;
    }
  };
}

/**
 * The remote to resolve the base branch from: a github.com-hosted remote if one
 * exists (the CI host), else `origin`, else the first remote. Some repos keep
 * `origin` pointed at a dead/non-CI remote (e.g. an old Azure mirror) while
 * pushing to a separate `github` remote that CI actually gates — resolving the
 * base off `origin` there is unreliable. CI is authoritative regardless; this
 * just makes the LOCAL pre-flight match in multi-remote repos. Pure over `tryGit`.
 */
export function preferredRemote(tryGit: GitTry): string {
  const remotes = (tryGit(["remote"]) ?? "").split("\n").map((r) => r.trim()).filter(Boolean);
  if (remotes.length === 0) return "origin";
  for (const r of remotes) {
    const url = tryGit(["remote", "get-url", r]) ?? "";
    if (/github\.com/i.test(url)) return r;
  }
  return remotes.includes("origin") ? "origin" : remotes[0];
}

/**
 * Resolve the base ref when `--base` isn't given. CI passes `--base` explicitly
 * (the PR's base), so this is the LOCAL default — auto-detecting the preferred
 * remote's default branch so `main`-vs-`master` (and a dead `origin`) never trip
 * an author. Order: `<remote>/HEAD` symbolic-ref → `<remote>/main` →
 * `<remote>/master` → `<remote>/main`. `--base <ref>` always overrides.
 */
export function detectBaseRef(cwd: string): string {
  const tryGit = gitTry(cwd);
  const remote = preferredRemote(tryGit);
  const head = tryGit(["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`]);
  if (head) return head; // e.g. "github/master" (already a <remote>/ ref)
  for (const b of [`${remote}/main`, `${remote}/master`]) {
    if (tryGit(["rev-parse", "--verify", "--quiet", b]) !== null) return b;
  }
  return `${remote}/main`;
}
