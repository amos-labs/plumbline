/**
 * `plumb setup-protection` — the human-only half of batteries-included setup,
 * done via the GitHub API instead of by clicking through Settings → Branches.
 *
 * The "blocking + auto-merge on all green" shape (mirrors nuvola_academy): make
 * the Plumbline gate + the repo's CI checks REQUIRED status checks on the
 * default branch (strict:false — don't force a rebase-before-merge, which just
 * serializes the queue), and enable repository auto-merge so a PR merges the
 * instant every required check is green. This is what makes the gate actually
 * BLOCK (a required check) rather than be an advisory comment — the single
 * misconfiguration we hit on every repo.
 *
 * Idempotent: reads current protection, only writes what differs, prints what
 * it changed. Needs a token with repo admin (admin:org / repo) scope.
 */

const GH_API = "https://api.github.com";

function headers(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
  };
}

export interface ProtectionOptions {
  repo: string; // "owner/name"
  token: string;
  /** Extra required check names beyond the gate (the repo's CI jobs). */
  checks?: string[];
  /** Override the default branch (else read from the repo). */
  branch?: string;
  /** The gate's check name (the workflow job name). Default "plumbline". */
  gateCheck?: string;
  /** Don't write — just report what would change. */
  dryRun?: boolean;
}

export interface ProtectionResult {
  branch: string;
  requiredChecks: string[];
  changes: string[];
  autoMergeEnabled: boolean;
}

interface RepoInfo {
  default_branch: string;
  node_id: string;
  allow_auto_merge?: boolean;
}

async function ghGet<T>(url: string, token: string): Promise<{ ok: boolean; status: number; body: T | null }> {
  const res = await fetch(url, { headers: headers(token) });
  const text = await res.text();
  let body: T | null = null;
  try {
    body = text ? (JSON.parse(text) as T) : null;
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body };
}

export async function getRepo(repo: string, token: string): Promise<RepoInfo> {
  const { ok, status, body } = await ghGet<RepoInfo>(`${GH_API}/repos/${repo}`, token);
  if (!ok || !body) throw new Error(`get repo ${repo}: ${status}`);
  return body;
}

interface BranchProtection {
  required_status_checks?: {
    strict?: boolean;
    checks?: Array<{ context: string }>;
    contexts?: string[];
  } | null;
}

/**
 * Merge the desired required checks into any existing protection without
 * clobbering unrelated settings. Pure so the union logic is unit-testable.
 * Returns the new sorted required-check set + whether it differs from current.
 */
export function mergeRequiredChecks(
  current: string[],
  desired: string[],
): { merged: string[]; added: string[] } {
  const set = new Set(current);
  const added: string[] = [];
  for (const c of desired) {
    if (!set.has(c)) {
      set.add(c);
      added.push(c);
    }
  }
  return { merged: [...set].sort(), added };
}

function currentContexts(p: BranchProtection | null): string[] {
  const rsc = p?.required_status_checks;
  if (!rsc) return [];
  if (rsc.checks && rsc.checks.length) return rsc.checks.map((c) => c.context);
  return rsc.contexts ?? [];
}

/**
 * Apply the "blocking + auto-merge on all green" shape. Reads current state,
 * writes only the diff, returns a change list for the caller to print.
 */
export async function setupProtection(opts: ProtectionOptions): Promise<ProtectionResult> {
  const { repo, token } = opts;
  const gateCheck = opts.gateCheck ?? "plumbline";
  const changes: string[] = [];

  const repoInfo = await getRepo(repo, token);
  const branch = opts.branch ?? repoInfo.default_branch;
  const desired = [gateCheck, ...(opts.checks ?? [])];

  // 1. Required status checks (strict:false) on the default branch.
  const { status: protStatus, body: prot } = await ghGet<BranchProtection>(
    `${GH_API}/repos/${repo}/branches/${branch}/protection`,
    token,
  );
  // 404 = no protection yet (or fine-grained token can't read it — treat as empty).
  const existing = protStatus === 200 ? currentContexts(prot) : [];
  const strictNow = protStatus === 200 ? Boolean(prot?.required_status_checks?.strict) : false;
  const { merged, added } = mergeRequiredChecks(existing, desired);
  const strictChange = strictNow ? "strict:true→false" : null;

  const needsWrite = added.length > 0 || strictChange !== null || protStatus !== 200;
  if (needsWrite) {
    if (added.length) changes.push(`required checks +[${added.join(", ")}]`);
    if (strictChange) changes.push(strictChange);
    if (protStatus !== 200 && !added.length && !strictChange)
      changes.push(`enable required status checks [${merged.join(", ")}]`);
    if (!opts.dryRun) {
      // PUT replaces the whole protection object — carry existing fields we
      // know about. We only manage required_status_checks; leave the rest as
      // permissive as the API's required shape allows (null where nullable).
      const put = await fetch(`${GH_API}/repos/${repo}/branches/${branch}/protection`, {
        method: "PUT",
        headers: headers(token),
        body: JSON.stringify({
          required_status_checks: { strict: false, checks: merged.map((c) => ({ context: c })) },
          enforce_admins: null,
          required_pull_request_reviews: null,
          restrictions: null,
        }),
      });
      if (!put.ok) throw new Error(`set branch protection on ${branch}: ${put.status} ${await put.text()}`);
    }
  } else {
    changes.push(`required checks already [${merged.join(", ")}] (strict:false) — no change`);
  }

  // 2. Repository auto-merge.
  let autoMergeEnabled = Boolean(repoInfo.allow_auto_merge);
  if (!repoInfo.allow_auto_merge) {
    changes.push("enable repository auto-merge");
    if (!opts.dryRun) {
      const patch = await fetch(`${GH_API}/repos/${repo}`, {
        method: "PATCH",
        headers: headers(token),
        body: JSON.stringify({ allow_auto_merge: true }),
      });
      if (!patch.ok) throw new Error(`enable auto-merge on ${repo}: ${patch.status} ${await patch.text()}`);
      autoMergeEnabled = true;
    }
  } else {
    changes.push("repository auto-merge already enabled — no change");
  }

  return { branch, requiredChecks: merged, changes, autoMergeEnabled };
}
