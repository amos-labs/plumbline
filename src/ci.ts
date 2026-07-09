import { appendFileSync } from "fs";
import { postPrComment as postGitHubComment, type CiAnnotation } from "./github.js";

/** Escape a workflow-command annotation message (no raw newlines/%). */
function escapeAnnotation(s: string): string {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/**
 * Emit a GitHub Actions annotation (stdout workflow command). Surfaces the
 * verdict inline in the PR Checks UI / Files view — so a maintainer sees that
 * there's feedback to read without opening the buried PR comment.
 */
function emitGitHubAnnotation(a?: CiAnnotation): void {
  if (!a) return;
  console.log(`::${a.level} title=${escapeAnnotation(a.title)}::${escapeAnnotation(a.message)}`);
}

/** Append the full gate comment to the GitHub Actions job summary page. */
function writeGitHubStepSummary(markdown: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try {
    appendFileSync(file, `${markdown}\n`);
  } catch {
    /* best-effort — never fail the gate on a summary write */
  }
}

/**
 * CI adapter — plumbline core is CI-agnostic; only PR context discovery and
 * comment posting differ per provider. Supported: GitHub Actions, Azure
 * DevOps Pipelines. Anything else falls back to stdout.
 */

export type CiProvider = "github" | "azure" | "none";

export interface CiContext {
  provider: CiProvider;
  /** Base ref for git diff, e.g. "origin/main". */
  baseRef?: string;
  prNumber?: number;
}

export function detectCi(): CiContext {
  if (process.env.GITHUB_ACTIONS === "true") {
    const prNumber = Number(
      process.env.PLUMBLINE_PR_NUMBER ||
      // Legacy alias (proofgate→Plumbline rename), retained for back-compat.
      process.env.PROOFGATE_PR_NUMBER ||
        (process.env.GITHUB_REF?.match(/refs\/pull\/(\d+)\//)?.[1] ?? NaN),
    );
    return {
      provider: "github",
      baseRef: process.env.GITHUB_BASE_REF
        ? `origin/${process.env.GITHUB_BASE_REF}`
        : undefined,
      prNumber: Number.isFinite(prNumber) ? prNumber : undefined,
    };
  }

  if (process.env.TF_BUILD === "True") {
    const target = process.env.SYSTEM_PULLREQUEST_TARGETBRANCH; // refs/heads/main
    const prId = Number(process.env.SYSTEM_PULLREQUEST_PULLREQUESTID ?? NaN);
    return {
      provider: "azure",
      baseRef: target ? `origin/${target.replace(/^refs\/heads\//, "")}` : undefined,
      prNumber: Number.isFinite(prId) ? prId : undefined,
    };
  }

  return { provider: "none" };
}

const MARKER = "plumbline · proof-carrying gate";
/** Pre-rename marker — still matched so old PR threads get updated, not stacked. */
const LEGACY_MARKER = "proofgate · proof-carrying gate";

interface AzureThread {
  id: number;
  comments: Array<{ id: number; content?: string }>;
}

/**
 * Post (or update) the gate result as an Azure DevOps PR thread.
 * Requires SYSTEM_ACCESSTOKEN mapped into the step env:
 *   env: { SYSTEM_ACCESSTOKEN: $(System.AccessToken) }
 * and "Contribute to pull requests" permission for the build service identity.
 */
export async function postAzureComment(
  prId: number,
  body: string,
  approved: boolean,
): Promise<void> {
  const collection = process.env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI; // https://dev.azure.com/org/
  const project = process.env.SYSTEM_TEAMPROJECT;
  const repoId = process.env.BUILD_REPOSITORY_ID || process.env.BUILD_REPOSITORY_NAME;
  const token = process.env.SYSTEM_ACCESSTOKEN;
  if (!collection || !project || !repoId || !token) {
    throw new Error(
      "Azure DevOps context incomplete: need SYSTEM_TEAMFOUNDATIONCOLLECTIONURI, SYSTEM_TEAMPROJECT, BUILD_REPOSITORY_ID, SYSTEM_ACCESSTOKEN",
    );
  }

  const base = `${collection}${encodeURIComponent(project)}/_apis/git/repositories/${repoId}/pullRequests/${prId}/threads`;
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  // 1 = active (needs attention), 2 = fixed/resolved.
  const status = approved ? 2 : 1;

  // Update existing plumbline (or legacy) thread if present.
  const list = await fetch(`${base}?api-version=7.1`, { headers });
  if (list.ok) {
    const data = (await list.json()) as { value: AzureThread[] };
    const mine = data.value.find((t) =>
      t.comments?.some((c) => c.content?.includes(MARKER) || c.content?.includes(LEGACY_MARKER)),
    );
    if (mine) {
      const commentId = mine.comments[0].id;
      await fetch(`${base}/${mine.id}/comments/${commentId}?api-version=7.1`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ content: body }),
      });
      await fetch(`${base}/${mine.id}?api-version=7.1`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ status }),
      });
      return;
    }
  }

  const res = await fetch(`${base}?api-version=7.1`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      comments: [{ parentCommentId: 0, content: body, commentType: 1 }],
      status,
    }),
  });
  if (!res.ok) {
    throw new Error(`failed to post Azure DevOps thread: ${res.status} ${await res.text()}`);
  }
}

/** Provider-dispatching comment post. Returns false if no PR context. */
export async function reportToCi(
  ctx: CiContext,
  body: string,
  approved: boolean,
  summary?: CiAnnotation,
): Promise<boolean> {
  if (ctx.provider === "github") {
    // Surface the verdict in the GitHub UI regardless of PR-comment success:
    // the annotation (Checks tab) and job summary need no token and make the
    // feedback visible without opening the comment.
    emitGitHubAnnotation(summary);
    writeGitHubStepSummary(body);

    const repo = process.env.GITHUB_REPOSITORY;
    const token = process.env.GITHUB_TOKEN;
    if (!repo || !token || ctx.prNumber === undefined) return false;
    await postGitHubComment(repo, ctx.prNumber, body, token);
    return true;
  }
  if (ctx.provider === "azure" && ctx.prNumber !== undefined) {
    await postAzureComment(ctx.prNumber, body, approved);
    return true;
  }
  return false;
}
