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
 *
 * NON-DESTRUCTIVE: a branch-protection PUT replaces the ENTIRE protection
 * object, so any field omitted from the body is WIPED. Earlier versions sent
 * `required_pull_request_reviews:null` and `restrictions:null` unconditionally,
 * which silently removed required-reviewer rules and push restrictions on any
 * repo that had them. We now GET the current protection first and PRESERVE
 * those two settings (carry them back verbatim), only ever ADDING the required
 * status checks + auto-merge. If preserving them isn't possible (e.g. the token
 * can't read protection), we refuse to write unless `--force` is passed.
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
  /**
   * Proceed with a PUT even when the current protection couldn't be read (so
   * existing required-reviewers / push-restrictions can't be preserved). Off by
   * default — we'd rather error than silently clobber. Only ADD, never remove.
   */
  force?: boolean;
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
  /**
   * Existing PR-review requirements (required reviewers, code-owner review,
   * dismiss-stale, required approving count). The GET returns a rich object;
   * the PUT accepts a similar (nullable) object. We carry whatever is here back
   * into the PUT so we never remove a repo's required-reviewer rule.
   */
  required_pull_request_reviews?: Record<string, unknown> | null;
  /** Existing push restrictions (users/teams/apps allowed to push). */
  restrictions?: Record<string, unknown> | null;
  /** Admin enforcement toggle — preserved so we don't flip it off. */
  enforce_admins?: { enabled?: boolean } | boolean | null;
}

/**
 * The GET response nests some fields under `{ enabled: bool }` (enforce_admins)
 * or as read-only expansions (restrictions has `users_url` etc. the PUT
 * rejects). Normalize what we read into the shape the PUT accepts so carrying
 * it back verbatim doesn't 422.
 */
function normalizeForPut(prot: BranchProtection | null): {
  requiredPrReviews: unknown;
  restrictions: unknown;
  enforceAdmins: boolean | null;
} {
  // required_pull_request_reviews: GET and PUT shapes are compatible enough to
  // round-trip the meaningful fields. Carry the object through as-is (null when
  // absent — which is the "no review requirement" the PUT expects).
  const rpr = prot?.required_pull_request_reviews;
  const requiredPrReviews =
    rpr && typeof rpr === "object"
      ? {
          dismiss_stale_reviews: (rpr as Record<string, unknown>).dismiss_stale_reviews ?? false,
          require_code_owner_reviews:
            (rpr as Record<string, unknown>).require_code_owner_reviews ?? false,
          required_approving_review_count:
            (rpr as Record<string, unknown>).required_approving_review_count ?? 0,
          // Preserve the actual reviewer restrictions if present.
          ...((rpr as Record<string, unknown>).require_last_push_approval !== undefined
            ? { require_last_push_approval: (rpr as Record<string, unknown>).require_last_push_approval }
            : {}),
        }
      : null;

  // restrictions: the GET expands users/teams/apps into full objects; the PUT
  // wants arrays of logins/slugs. Down-project to the login/slug arrays. When
  // absent, null = "no restriction" (unchanged from having none).
  const rst = prot?.restrictions;
  const restrictions =
    rst && typeof rst === "object"
      ? {
          users: Array.isArray((rst as Record<string, unknown>).users)
            ? ((rst as Record<string, unknown>).users as Array<{ login?: string } | string>).map(
                (u) => (typeof u === "string" ? u : u.login ?? ""),
              )
            : [],
          teams: Array.isArray((rst as Record<string, unknown>).teams)
            ? ((rst as Record<string, unknown>).teams as Array<{ slug?: string } | string>).map(
                (t) => (typeof t === "string" ? t : t.slug ?? ""),
              )
            : [],
          apps: Array.isArray((rst as Record<string, unknown>).apps)
            ? ((rst as Record<string, unknown>).apps as Array<{ slug?: string } | string>).map(
                (a) => (typeof a === "string" ? a : a.slug ?? ""),
              )
            : [],
        }
      : null;

  const ea = prot?.enforce_admins;
  const enforceAdmins =
    ea && typeof ea === "object" ? Boolean((ea as { enabled?: boolean }).enabled) : ea === true ? true : null;

  return { requiredPrReviews, restrictions, enforceAdmins };
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
  // 200 = protection exists and we read it (we can preserve existing settings).
  // 404 = no protection yet — nothing to preserve, safe to create from scratch.
  // anything else (401/403) = protection MAY exist but we couldn't read it, so
  // a PUT would clobber whatever's there. Refuse unless --force.
  const couldRead = protStatus === 200 || protStatus === 404;
  const existing = protStatus === 200 ? currentContexts(prot) : [];
  const strictNow = protStatus === 200 ? Boolean(prot?.required_status_checks?.strict) : false;
  const { merged, added } = mergeRequiredChecks(existing, desired);
  const strictChange = strictNow ? "strict:true→false" : null;

  // Fields we must PRESERVE — carry existing ones back into the PUT so we never
  // wipe a repo's required-reviewers / push-restrictions.
  const preserved = normalizeForPut(protStatus === 200 ? prot : null);
  const hasReviewers =
    preserved.requiredPrReviews !== null &&
    Number(
      (preserved.requiredPrReviews as { required_approving_review_count?: number } | null)
        ?.required_approving_review_count ?? 0,
    ) > 0;
  if (hasReviewers) changes.push("preserving existing required_pull_request_reviews");
  if (preserved.restrictions !== null) changes.push("preserving existing push restrictions");

  const needsWrite = added.length > 0 || strictChange !== null || protStatus === 404;
  if (needsWrite) {
    if (!couldRead && !opts.force) {
      throw new Error(
        `set branch protection on ${branch}: current protection returned ${protStatus} — could not read ` +
          `existing settings, so a write could WIPE required reviewers / push restrictions. ` +
          `Re-run with a token that can read branch protection, or pass --force to write anyway ` +
          `(force only ADDS the required checks; it still won't send review/restriction nulls unless nothing was readable).`,
      );
    }
    if (added.length) changes.push(`required checks +[${added.join(", ")}]`);
    if (strictChange) changes.push(strictChange);
    if (protStatus === 404 && !added.length && !strictChange)
      changes.push(`enable required status checks [${merged.join(", ")}]`);
    if (!opts.dryRun) {
      // PUT replaces the whole protection object. We only MANAGE
      // required_status_checks; everything else is carried back verbatim from
      // the GET so nothing is silently removed. When there was no protection
      // (404) these are legitimately null (nothing to preserve).
      const put = await fetch(`${GH_API}/repos/${repo}/branches/${branch}/protection`, {
        method: "PUT",
        headers: headers(token),
        body: JSON.stringify({
          required_status_checks: { strict: false, checks: merged.map((c) => ({ context: c })) },
          enforce_admins: preserved.enforceAdmins,
          required_pull_request_reviews: preserved.requiredPrReviews,
          restrictions: preserved.restrictions,
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
