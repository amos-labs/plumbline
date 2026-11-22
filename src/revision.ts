import { githubFetch } from "./github.js";
import type { GateResult } from "./types.js";

export function canSignOff(gate: GateResult, verified: boolean, phase: string): boolean {
  const review = gate.review;
  return (phase === "verify" || phase === "full") && verified && gate.shape.pass &&
    gate.final === "review" && review?.verdict === "review" && !!review.audit?.provider &&
    !review.audit.cached && !review.failure_capsule?.agent_actions?.length &&
    !review.failure_capsule?.findings?.some(f => f.class === "blocking" && f.actor === "agent");
}

interface Comment {
  id: number;
  body: string;
  created_at: string;
  updated_at: string;
  user: { login: string; type: string };
}

export async function revisionApproval(repo: string, pr: number, sha: string, token: string) {
  if (!/^[0-9a-f]{40}$/.test(sha)) return;
  async function get<T>(path: string): Promise<T> {
    const response = await githubFetch(`https://api.github.com/repos/${repo}/${path}`,
      { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } }, "revision approval");
    if (!response.ok) throw new Error(`GitHub returned ${response.status} reading approval`);
    return await response.json() as T;
  }
  // The issue comments endpoint returns oldest first. Never decide on a partial list.
  const candidates: Comment[] = [];
  for (let page = 1; ; page++) {
    const comments = await get<Comment[]>(`issues/${pr}/comments?per_page=100&page=${page}`);
    candidates.push(...comments.filter(c => c.user?.type === "User" && c.created_at === c.updated_at &&
      [`/plumbline approve ${sha}`, `/plumbline revoke ${sha}`].includes(c.body.trim())));
    if (comments.length < 100) break;
  }
  for (const comment of candidates.reverse()) {
    const role = await get<{permission: string; role_name: string}>(`collaborators/${encodeURIComponent(comment.user.login)}/permission`);
    if (role.permission !== "admin" && role.role_name !== "maintain") continue;
    if (comment.body.trim() === `/plumbline approve ${sha}`) {
      return { actor: comment.user.login, comment_id: comment.id, sha };
    }
    break;
  }
}
