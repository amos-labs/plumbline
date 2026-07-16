import { createHash } from "node:crypto";
import type { GateResult } from "./types.js";
import { verdictPresentation, type CheckConclusion } from "./verdict.js";

/** Render the gate result as a PR comment (GitHub-flavored markdown). */
export function renderComment(result: GateResult): string {
  // Title + action banner both come from the single verdict-presentation table
  // (#54), so REWORK and REVIEW can never collapse into one identical red
  // "failure" comment again — the H2 itself screams which state it is and who
  // must act. A human glancing at the comment head knows instantly whether the
  // agent must fix (REWORK) or they must approve (REVIEW).
  const pres = verdictPresentation(result.final);
  const lines: string[] = [];
  lines.push(`## ${pres.commentTitle}`);
  lines.push("");

  const cap = result.review?.failure_capsule;
  const agentActions = cap?.agent_actions ?? [];
  const humanActions = cap?.human_actions ?? [];
  // #56: optional-but-good findings — surfaced here AND auto-filed as tracked
  // follow-up issues. `follow_ups` is the post-#56 field; fall back to the
  // legacy `advisory` field for capsules produced before the rename.
  const followUps = cap?.follow_ups ?? cap?.advisory ?? [];
  const didNotConverge = cap?.did_not_converge === true;

  if (result.final === "review" && didNotConverge) {
    // Convergence cap fired (#41, Change 3): the loop is over, a human decides.
    // Still a REVIEW (human's turn), but with a distinct "did not converge" note.
    lines.push(
      "> **🧑‍⚖️ Gate did not converge — human decides.** After 2 rework rounds the gate stops iterating the agent. A maintainer reviews the remaining 🧑 items and override-merges if sound: `gh pr merge <PR> --squash --admin`.",
    );
  } else {
    lines.push(`> ${pres.commentBanner}`);
  }
  lines.push("");

  // Findings-at-a-glance: a non-approve verdict always carries substantive
  // review notes. The action banner can read as "just approve" and bury them,
  // so surface a one-line pointer + risk count right under the banner.
  if (result.final !== "approve" && result.review) {
    const riskCount = (result.review.risk_notes.match(/(?:^|\s)\d+[\).]/g) || []).length;
    const riskLabel = riskCount > 0 ? `${riskCount} risk finding${riskCount === 1 ? "" : "s"}` : "risk notes";
    lines.push(
      `> 📋 **Review findings below — don't merge without reading them:** ${riskLabel}, plus validation-coverage and mission-alignment notes.`,
    );
    lines.push("");
  }

  lines.push(`**Shape gate:** ${result.shape.pass ? "pass" : "FAIL"}`);
  for (const e of result.shape.errors) lines.push(`- ❌ ${e}`);
  for (const w of result.shape.warnings) lines.push(`- ⚠️ ${w}`);
  lines.push("");

  if (result.review) {
    const r = result.review;
    lines.push(`**Semantic review:** ${r.verdict} (confidence ${r.confidence})`);
    lines.push("");
    lines.push(`- **Validation coverage:** ${r.validation_coverage_notes}`);
    lines.push(`- **Mission alignment:** ${r.mission_alignment_notes}`);
    lines.push(`- **Risk:** ${r.risk_notes}`);
    if (r.failure_capsule) {
      lines.push("");
      lines.push(`### What's needed — ${r.failure_capsule.failing_check}`);
      lines.push(`_${r.failure_capsule.suspected_cause}_`);

      // Turn-based (#41): a rework carries only 🤖 items, a review only 🧑 —
      // the verdict already encodes whose turn it is, so neither list bleeds
      // into the other. Render whichever blocking items are present.
      if (humanActions.length > 0) {
        lines.push("");
        lines.push("#### 🧑 Human must decide");
        for (const a of humanActions) lines.push(`- [ ] ${a}`);
      }
      if (agentActions.length > 0) {
        lines.push("");
        lines.push("#### 🤖 Agent can do now");
        for (const a of agentActions) lines.push(`- [ ] ${a}`);
        lines.push("");
        lines.push("_Agent: do the 🤖 items and re-push with an updated receipt._");
      }
      // Fall back to the single next step when there are no blocking items.
      if (humanActions.length === 0 && agentActions.length === 0) {
        lines.push("");
        lines.push(`**Next action:** ${r.failure_capsule.next_action_requested}`);
      }

      // Optional-but-good findings (#56): non-blocking, and NOT lost — the gate
      // auto-files a tracked follow-up issue for each. Shown here so the author
      // sees them; they never read as required work for THIS PR.
      if (followUps.length > 0) {
        lines.push("");
        lines.push("#### 💡 Optional follow-ups — non-blocking (auto-filed as tracked issues)");
        for (const a of followUps) lines.push(`- ${a}`);
      }

      lines.push("");
      lines.push("<details><summary>Full capsule (JSON)</summary>");
      lines.push("");
      lines.push("```json");
      lines.push(JSON.stringify(r.failure_capsule, null, 2));
      lines.push("```");
      lines.push("</details>");
    }
  }

  if (result.reasons.length > 0) {
    lines.push("");
    for (const reason of result.reasons) lines.push(`> ${reason}`);
  }

  lines.push("");
  lines.push("<sub>plumbline · proof-carrying gate for agent work</sub>");
  return lines.join("\n");
}

export interface CiAnnotation {
  /** GitHub workflow-command level. error=red, warning=amber, notice=blue. */
  level: "error" | "warning" | "notice";
  title: string;
  message: string;
}

/**
 * A compact one-liner for the GitHub Actions Checks UI (annotation), so the
 * verdict AND the fact that there's substantive feedback are visible without
 * opening the PR comment. The level + title come from the verdict-presentation
 * table (#54): rework→error (agent must fix), review→warning (human judgment,
 * distinct from "broken"), approve→notice — the SAME source the check-run and
 * PR comment use, so the three surfaces can never disagree about the state.
 */
export function renderCiSummary(result: GateResult): CiAnnotation {
  const pres = verdictPresentation(result.final);
  if (result.final === "approve") {
    return {
      level: pres.annotationLevel,
      title: pres.checkName,
      message: "Receipt passed shape + semantic review. Merging automatically — no action needed.",
    };
  }

  const cap = result.review?.failure_capsule;
  const parts: string[] = [];

  if (result.final === "rework") {
    parts.push("REWORK — do NOT merge. The agent fixes the items in the PR comment and re-pushes.");
  } else if (cap?.did_not_converge) {
    parts.push("REVIEW — gate did not converge after 2 rework rounds; a human decides the remaining items.");
  } else {
    parts.push("REVIEW — human approval required (protected/billing surface). NOT a rubber stamp; NOT a broken build.");
  }
  if (cap?.failing_check) parts.push(`Focus: ${cap.failing_check}.`);

  if (result.review) {
    const riskCount = (result.review.risk_notes.match(/(?:^|\s)\d+[\).]/g) || []).length;
    const findings = riskCount > 0 ? `${riskCount} risk finding${riskCount === 1 ? "" : "s"} + validation notes` : "risk + validation notes";
    parts.push(`Read the ${findings} in the PR comment before merging.`);
  }

  return {
    level: pres.annotationLevel,
    title: pres.checkName,
    message: parts.join(" "),
  };
}

// ── Evidence integrity: corroborate against the REAL CI run (#6) ──────────
//
// execution_evidence[].status in the receipt is self-reported — the gate
// shouldn't take "rspec passed" on faith. For policy `ci_evidence_checks`,
// we read the actual GitHub check-run conclusions for the PR HEAD commit and
// require success. The receipt declares the plan; CI proves it. (So an agent
// need not self-report status for these — and can't fake a passing suite.)

export interface CheckRun {
  name: string;
  /** queued | in_progress | completed */
  status: string;
  /** success | failure | neutral | cancelled | skipped | timed_out | action_required | null */
  conclusion: string | null;
}

const GH_HEADERS = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
});

/** The PR's head commit SHA (the real commit CI ran on — not the merge ref). */
export async function getPrHeadSha(repo: string, prNumber: number, token: string): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
    headers: GH_HEADERS(token),
  });
  if (!res.ok) throw new Error(`get PR #${prNumber}: ${res.status} ${await res.text()}`);
  const pr = (await res.json()) as { head?: { sha?: string } };
  if (!pr.head?.sha) throw new Error(`PR #${prNumber} has no head.sha`);
  return pr.head.sha;
}

/** All check-runs reported for a commit. */
export async function getCheckRunsForSha(repo: string, sha: string, token: string): Promise<CheckRun[]> {
  const res = await fetch(
    `https://api.github.com/repos/${repo}/commits/${sha}/check-runs?per_page=100`,
    { headers: GH_HEADERS(token) },
  );
  if (!res.ok) throw new Error(`get check-runs for ${sha}: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { check_runs?: CheckRun[] };
  return (data.check_runs ?? []).map((c) => ({
    name: c.name,
    status: c.status,
    conclusion: c.conclusion ?? null,
  }));
}

/**
 * Poll-wait self-detection (mirrors templates/workflow.yml). Given a check-run
 * and THIS workflow run's id, decide whether the check-run is the gate's OWN
 * run — which the poll-wait must skip (waiting on itself would deadlock until
 * timeout). Robust: keys on the run id embedded in the check-run's
 * details_url/html_url (survives a job rename, and won't match an unrelated
 * repo check that merely contains "plumbline" in its name). Falls back to a
 * bare name match ONLY when there is no url to key on.
 *
 * Kept in sync with the inline script in the scaffolded workflow so the logic
 * is unit-testable here.
 */
export function isOwnGateRun(
  run: { name?: string; details_url?: string | null; html_url?: string | null },
  runId: string,
): boolean {
  const url = run.details_url || run.html_url || "";
  if (url) {
    return url.includes(`/runs/${runId}/`) || url.endsWith(`/runs/${runId}`);
  }
  const n = (run.name || "").toLowerCase();
  return n === "plumbline" || n === "gate";
}

/**
 * Pure decision (no network): every required check-run name must have at least
 * one run that CONCLUDED `success` for the commit. A re-run that later succeeds
 * counts. Missing or not-passed → error. Kept pure so it's unit-testable.
 */
export function evaluateCiEvidence(
  checkRuns: CheckRun[],
  required: string[],
): { pass: boolean; errors: string[]; notes: string[] } {
  const errors: string[] = [];
  const notes: string[] = [];
  for (const name of required) {
    const runs = checkRuns.filter((c) => c.name === name);
    if (runs.length === 0) {
      errors.push(
        `ci-evidence: required check "${name}" did not run for the head commit ` +
          `(the gate verifies the real CI run, not the receipt's self-report)`,
      );
    } else if (runs.some((c) => c.conclusion === "success")) {
      notes.push(`${name}: success`);
    } else {
      const w = runs.find((c) => c.status === "completed") ?? runs[0];
      errors.push(
        `ci-evidence: required check "${name}" did not pass — status=${w.status} conclusion=${w.conclusion ?? "none"}`,
      );
    }
  }
  return { pass: errors.length === 0, errors, notes };
}

/** Fetch the PR head's check-runs and evaluate them against the required set. */
export async function verifyCiEvidence(
  repo: string,
  prNumber: number,
  token: string,
  required: string[],
): Promise<{ pass: boolean; errors: string[]; notes: string[] }> {
  if (required.length === 0) return { pass: true, errors: [], notes: [] };
  const sha = await getPrHeadSha(repo, prNumber, token);
  const runs = await getCheckRunsForSha(repo, sha, token);
  return evaluateCiEvidence(runs, required);
}

// ── Attempt history: reruns keep context instead of overwriting it ─────────
//
// The gate comment is updated in place on every run (no comment-stacking),
// which used to ERASE the prior capsule — so a multi-round fix lost the
// context of what attempt #1 failed on. Now the previous "current" section is
// archived into a collapsed details block, newest first, capped — the fixing
// agent (fresh session or not) sees the whole trajectory in one comment.

const HISTORY_MARKER = "<!-- plumbline:attempt-history -->";
const ATTEMPT_DELIM = "<!-- plumbline:attempt -->";

/** Cap on archived attempts and on each archived attempt's size. */
export const HISTORY_CAP = 5;
const ATTEMPT_MAX_CHARS = 4000;

/** Truncate, then re-balance any `<details>` cut open by the truncation. */
function truncateBalanced(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = `${s.slice(0, max)}\n… (truncated)`;
  const opens = (out.match(/<details/g) ?? []).length;
  const closes = (out.match(/<\/details>/g) ?? []).length;
  for (let i = closes; i < opens; i++) out += "\n</details>";
  return out;
}

/**
 * Merge the fresh gate comment with the existing one: the new result on top,
 * the existing result archived into the attempt-history details (prior
 * history carried forward, newest first, capped at HISTORY_CAP). Pure —
 * unit-testable without network.
 */
export function appendAttemptHistory(
  newBody: string,
  existingBody: string,
  now: Date = new Date(),
): string {
  const idx = existingBody.indexOf(HISTORY_MARKER);
  const existingCurrent = (idx >= 0 ? existingBody.slice(0, idx) : existingBody).trim();
  const historyPart = idx >= 0 ? existingBody.slice(idx) : "";

  // Prior archived attempts, each introduced by ATTEMPT_DELIM. The final
  // block carries the outer wrapper's closing </details> — strip exactly one.
  const priorBlocks = historyPart
    .split(ATTEMPT_DELIM)
    .slice(1)
    .map((b, i, arr) => (i === arr.length - 1 ? b.replace(/\s*<\/details>\s*$/, "") : b).trim())
    .filter(Boolean);

  // Recover the prior verdict from its H2 title for the archived-attempt label.
  // Case-insensitive + tolerant of the "Plumbline: VERDICT — …" title shape
  // (#54 made the titles verdict-distinct, e.g. "✅ Plumbline: PASS — …").
  const verdict = existingCurrent.match(/^##.*?plumbline:\s*(\w+)/im)?.[1]?.toUpperCase() ?? "PRIOR";
  const when = `${now.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const archived = `<details><summary>${verdict} — superseded ${when}</summary>\n\n${truncateBalanced(existingCurrent, ATTEMPT_MAX_CHARS)}\n\n</details>`;

  const blocks = [archived, ...priorBlocks].slice(0, HISTORY_CAP);
  return (
    `${newBody}\n\n${HISTORY_MARKER}\n` +
    `<details><summary>📜 Attempt history (${blocks.length})</summary>\n\n` +
    blocks.map((b) => `${ATTEMPT_DELIM}\n${b}`).join("\n\n") +
    `\n</details>`
  );
}

// ── Re-review context: round count + prior capsule (#41, Change 3) ─────────
//
// The gate comment is the durable record of prior rounds. A re-review reads it
// to (a) count how many rounds this PR has been through and (b) recover the
// prior failure capsule, so the review can be convergent (verify prior items,
// review only new hunks) instead of starting over each push.

/**
 * Count the rounds this PR has already been through, from its existing gate
 * comment. Each archived attempt is one prior round; +1 for the current
 * (top) result that is about to be superseded. A PR with no prior comment is
 * round 1. Pure — unit-testable without network.
 */
export function countRounds(existingBody: string | undefined): number {
  if (!existingBody) return 1;
  const idx = existingBody.indexOf(HISTORY_MARKER);
  if (idx < 0) return 2; // a current result exists but no archived history yet
  const priorBlocks = existingBody
    .slice(idx)
    .split(ATTEMPT_DELIM)
    .slice(1)
    .filter((b) => b.trim());
  // archived attempts + the current (soon-to-be-archived) result + this run
  return priorBlocks.length + 2;
}

/**
 * Recover the prior failure capsule from the current (top) section of the
 * existing gate comment — it is rendered inside a `<summary>Full capsule
 * (JSON)</summary>` details block. Returns undefined if absent/unparseable.
 * Pure — unit-testable without network.
 */
export function extractPriorCapsule(
  existingBody: string | undefined,
): import("./types.js").FailureCapsule | undefined {
  if (!existingBody) return undefined;
  const hIdx = existingBody.indexOf(HISTORY_MARKER);
  const current = hIdx >= 0 ? existingBody.slice(0, hIdx) : existingBody;
  const m = current.match(/Full capsule \(JSON\)<\/summary>\s*```json\s*([\s\S]*?)```/);
  if (!m) return undefined;
  try {
    return JSON.parse(m[1].trim()) as import("./types.js").FailureCapsule;
  } catch {
    return undefined;
  }
}

/**
 * Fetch the existing plumbline gate comment body for a PR (for re-review
 * context), or undefined if there is none / on any error. Best-effort: the gate
 * must never fail because it couldn't read prior context.
 */
export async function fetchExistingGateComment(
  repo: string,
  prNumber: number,
  token: string,
): Promise<string | undefined> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/issues/${prNumber}/comments?per_page=100`,
      { headers: GH_HEADERS(token) },
    );
    if (!res.ok) return undefined;
    const comments = (await res.json()) as Array<{ body: string }>;
    return comments.find(
      (c) =>
        c.body.includes("plumbline · proof-carrying gate") ||
        // Legacy footer from the pre-rename (proofgate→Plumbline) version —
        // still matched so re-runs update the existing thread instead of stacking.
        c.body.includes("proofgate · proof-carrying gate"),
    )?.body;
  } catch {
    return undefined;
  }
}

/**
 * Publish the gate verdict as a distinct GitHub CHECK-RUN on the PR head commit
 * (#54). This is the enforceable half of "unmistakable states":
 *
 *   - REWORK → a check-run named "Plumbline: REWORK — blocked, do not merge"
 *     with conclusion `failure`.
 *   - REVIEW → a check-run named "Plumbline: REVIEW — awaiting human approval"
 *     with conclusion `action_required` (the UI reads this as "needs a human",
 *     visibly distinct from a red failure).
 *   - PASS   → "Plumbline: PASS" with conclusion `success`.
 *
 * Because the NAME and CONCLUSION differ per verdict, a maintainer scanning the
 * Checks list can never confuse a REWORK for a REVIEW (or for a broken build).
 * Requires a token with `checks: write` and the checks API (available to the
 * default GITHUB_TOKEN in Actions). Best-effort: a failure to publish the
 * check-run is logged, never fatal — the workflow-job status + PR comment still
 * carry the verdict.
 *
 * NOTE: the workflow JOB's own required check still gates on the CLI exit code
 * (approve=0, rework/review=1) — this ADDS a legible, per-verdict check-run on
 * top; it does not replace the job status.
 */
export async function publishCheckRun(
  repo: string, // "owner/name"
  headSha: string,
  name: string,
  conclusion: CheckConclusion,
  title: string,
  summary: string,
  token: string,
): Promise<boolean> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/check-runs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name,
        head_sha: headSha,
        status: "completed",
        conclusion,
        // GitHub caps the check-run output summary; the full detail lives in the
        // PR comment. Keep this short and pointed.
        output: { title, summary: summary.slice(0, 60000) },
      }),
    });
    if (!res.ok) {
      // 403 here is the common "token lacks checks:write" case — surface it
      // clearly so a consumer can add the permission, but never fail the gate.
      console.error(`plumbline: could not publish verdict check-run (${res.status} ${await res.text().catch(() => "")})`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`plumbline: could not publish verdict check-run: ${(e as Error).message}`);
    return false;
  }
}

// ── Optional-but-good findings → tracked follow-up issues (#56) ────────────
//
// The key #56 move: a genuinely-good-but-out-of-scope suggestion must not
// evaporate as a skipped advisory. Instead the gate FILES it as a follow-up
// issue so a human/agent can pick it up. Idempotent: each finding gets a stable
// fingerprint embedded in the issue body; before filing, we search for an open
// issue carrying that fingerprint and skip if one exists — so re-running the
// gate on the same PR never spams duplicates.

const FOLLOWUP_LABEL = "plumbline-followup";
const FOLLOWUP_MARKER = "<!-- plumbline:followup:";

/** A short stable fingerprint for a finding — the dedup key. */
export function followUpFingerprint(prNumber: number, description: string): string {
  const h = createHash("sha256").update(`${prNumber}\n${description.trim()}`, "utf8").digest("hex");
  return h.slice(0, 16);
}

/** Search open issues for an existing follow-up carrying this fingerprint. */
async function followUpExists(repo: string, fingerprint: string, token: string): Promise<boolean> {
  try {
    // Full-text search over open issues in the repo for the marker+fingerprint.
    const q = encodeURIComponent(`repo:${repo} is:issue is:open in:body ${FOLLOWUP_MARKER}${fingerprint}`);
    const res = await fetch(`https://api.github.com/search/issues?q=${q}`, { headers: GH_HEADERS(token) });
    if (!res.ok) return false; // search unavailable → don't block filing (worst case: a dup, still tracked)
    const data = (await res.json()) as { total_count?: number };
    return (data.total_count ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * File a single optional-but-good finding as a follow-up issue (#56), unless one
 * already exists for it. Returns the created issue number, or null if it was
 * deduped or filing failed. Best-effort: never throws — a follow-up that can't
 * be filed is logged, and the finding still appears in the PR comment, so it is
 * not silently lost even on failure.
 */
export async function createFollowUpIssue(
  repo: string, // "owner/name"
  prNumber: number,
  description: string,
  token: string,
): Promise<number | null> {
  const fingerprint = followUpFingerprint(prNumber, description);
  if (await followUpExists(repo, fingerprint, token)) return null;

  const title = `[plumbline follow-up] ${description.slice(0, 120)}${description.length > 120 ? "…" : ""}`;
  const body =
    `${FOLLOWUP_MARKER}${fingerprint} -->\n\n` +
    `Filed by the Plumbline gate from PR #${prNumber} as an **optional-but-good** review finding ` +
    `(not blocking that PR, but worth doing so it isn't lost):\n\n` +
    `> ${description}\n\n` +
    `_Auto-filed so the suggestion is tracked instead of skipped. Close if not worth pursuing._`;

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: { ...GH_HEADERS(token), "content-type": "application/json" },
      body: JSON.stringify({ title, body, labels: [FOLLOWUP_LABEL] }),
    });
    if (!res.ok) {
      // A missing label is a common 422; retry once without labels so the
      // suggestion is still captured even if the repo lacks the label.
      if (res.status === 422) {
        const retry = await fetch(`https://api.github.com/repos/${repo}/issues`, {
          method: "POST",
          headers: { ...GH_HEADERS(token), "content-type": "application/json" },
          body: JSON.stringify({ title, body }),
        });
        if (retry.ok) return ((await retry.json()) as { number?: number }).number ?? null;
      }
      console.error(`plumbline: could not file follow-up issue (${res.status})`);
      return null;
    }
    return ((await res.json()) as { number?: number }).number ?? null;
  } catch (e) {
    console.error(`plumbline: could not file follow-up issue: ${(e as Error).message}`);
    return null;
  }
}

/**
 * File every optional-but-good follow-up for a PR (#56), deduped. Returns the
 * numbers of issues actually created (excludes deduped/failed). Best-effort.
 */
export async function fileFollowUps(
  repo: string,
  prNumber: number,
  descriptions: string[],
  token: string,
): Promise<number[]> {
  const created: number[] = [];
  for (const d of descriptions) {
    const n = await createFollowUpIssue(repo, prNumber, d, token);
    if (n !== null) created.push(n);
  }
  return created;
}

/** Post (or update) the gate comment on a PR. Requires GITHUB_TOKEN. */
export async function postPrComment(
  repo: string, // "owner/name"
  prNumber: number,
  body: string,
  token: string,
): Promise<void> {
  const api = `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json",
  };

  // Find an existing plumbline (or legacy proofgate) comment to update instead of stacking.
  const list = await fetch(`${api}?per_page=100`, { headers });
  if (list.ok) {
    const comments = (await list.json()) as Array<{ id: number; body: string }>;
    const mine = comments.find(
      (c) =>
        c.body.includes("plumbline · proof-carrying gate") ||
        // Legacy footer from the pre-rename (proofgate→Plumbline) version.
        c.body.includes("proofgate · proof-carrying gate"),
    );
    if (mine) {
      // Rerun: keep the prior attempt's context instead of erasing it.
      const merged = appendAttemptHistory(body, mine.body);
      const upd = await fetch(
        `https://api.github.com/repos/${repo}/issues/comments/${mine.id}`,
        { method: "PATCH", headers, body: JSON.stringify({ body: merged }) },
      );
      if (upd.ok) return;
    }
  }

  const res = await fetch(api, { method: "POST", headers, body: JSON.stringify({ body }) });
  if (!res.ok) {
    throw new Error(`failed to post PR comment: ${res.status} ${await res.text()}`);
  }
}
