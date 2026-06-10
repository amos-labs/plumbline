import { postPrComment as postGitHubComment } from "./github.js";

/**
 * CI adapter — proofgate core is CI-agnostic; only PR context discovery and
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

const MARKER = "proofgate · proof-carrying gate";

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

  // Update existing proofgate thread if present.
  const list = await fetch(`${base}?api-version=7.1`, { headers });
  if (list.ok) {
    const data = (await list.json()) as { value: AzureThread[] };
    const mine = data.value.find((t) =>
      t.comments?.some((c) => c.content?.includes(MARKER)),
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
): Promise<boolean> {
  if (ctx.provider === "github" && ctx.prNumber !== undefined) {
    const repo = process.env.GITHUB_REPOSITORY;
    const token = process.env.GITHUB_TOKEN;
    if (!repo || !token) return false;
    await postGitHubComment(repo, ctx.prNumber, body, token);
    return true;
  }
  if (ctx.provider === "azure" && ctx.prNumber !== undefined) {
    await postAzureComment(ctx.prNumber, body, approved);
    return true;
  }
  return false;
}
