import { githubFetch, type CheckRun } from "./github.js";

/** A check identifies a PR head. Only a successful checkout witness identifies the tested tree. */
export async function testProvenance(repo: string, pr: number, head: string, check: CheckRun, token: string) {
  if (check.app?.slug !== "github-actions" || !check.id || !check.details_url) return;
  const base = `https://github.com/${repo}/actions/runs/`;
  if (!check.details_url.startsWith(base)) return;
  const match = /^(\d+)\/job\/(\d+)$/.exec(check.details_url.slice(base.length));
  if (!match || match[2] !== String(check.id)) return;
  async function get<T>(path: string): Promise<T> {
    const res = await githubFetch(`https://api.github.com/repos/${repo}/${path}`,
      {headers: {authorization: `Bearer ${token}`, accept: "application/vnd.github+json"}}, "test provenance");
    if (!res.ok) throw new Error(`test provenance: HTTP ${res.status}`);
    return await res.json() as T;
  }
  const job = await get<{id: number; name: string; run_id: number; run_attempt: number;
    conclusion: string; steps: { name: string; conclusion: string }[]}>(`actions/jobs/${check.id}`);
  if (job.id !== check.id || job.name !== check.name || String(job.run_id) !== match[1]) return;
  const run = await get<{path: string; head_sha: string; event: string; head_repository: {full_name: string}}>(
    `actions/runs/${job.run_id}/attempts/${job.run_attempt}`);
  if (run.head_sha !== head || run.event !== "pull_request" || run.head_repository?.full_name !== repo) return;
  const source = { workflow: run.path, run_id: job.run_id, attempt: job.run_attempt, job_id: job.id, job: job.name };
  const prefix = `Verified PR ${pr} checkout `;
  const markers = job.steps.filter(s => s.conclusion === "success" && s.name.startsWith(prefix));
  const tested = markers.length === 1 && markers[0].name.slice(prefix.length);
  if (job.conclusion !== "success" || !tested || !/^[0-9a-f]{40}$/.test(tested)) return source;
  const commit = await get<{tree: {sha: string}; parents: {sha: string}[]}>(`git/commits/${tested}`);
  if (commit.parents.length !== 2 || commit.parents[1].sha !== head) return source;
  return { ...source, tested_commit: tested, tested_tree: commit.tree.sha };
}
