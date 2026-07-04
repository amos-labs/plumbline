import type { GateResult } from "./types.js";

/** Render the gate result as a PR comment (GitHub-flavored markdown). */
export function renderComment(result: GateResult): string {
  const icon =
    result.final === "approve" ? "✅" : result.final === "revise" ? "🔁" : "⚠️";
  const lines: string[] = [];
  lines.push(`## ${icon} plumbline: ${result.final.toUpperCase()}`);
  lines.push("");

  // Action banner — make WHO must act unambiguous. `revise` and `escalate`
  // both produce a red required-check, which previously looked identical and
  // left maintainers unsure whether the agent needed to fix something or they
  // just needed to approve. Spell it out.
  const cap = result.review?.failure_capsule;
  const agentActions = cap?.agent_actions ?? [];
  const humanActions = cap?.human_actions ?? [];

  if (result.final === "approve") {
    lines.push("> **✅ Passed — merging automatically. No action needed.**");
  } else if (result.final === "revise") {
    lines.push(
      "> **🔁 Rework needed — the agent fixes the 🤖 items below and re-pushes. No human action required.**",
    );
  } else if (agentActions.length > 0) {
    // Escalate, but there's ALSO agent-doable work — don't pretend otherwise.
    lines.push(
      "> **⚠️ Human review required — and there are agent-fixable items too.** A maintainer decides the 🧑 items; an agent can address the 🤖 items now (in parallel). Override-merge when ready: `gh pr merge <PR> --squash --admin`.",
    );
  } else {
    lines.push(
      "> **⚠️ Human approval required — no agent rework needed, but this is NOT a rubber stamp.** Touches a protected/billing surface. **Read the review findings below (risk + validation notes) before override-merging:** `gh pr merge <PR> --squash --admin`.",
    );
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

      // The whole point: split who-must-act so neither side is buried.
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
      // Fall back to the single next step when the model gave no split.
      if (humanActions.length === 0 && agentActions.length === 0) {
        lines.push("");
        lines.push(`**Next action:** ${r.failure_capsule.next_action_requested}`);
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
 * opening the PR comment. revise→error (agent must fix), escalate→warning
 * (human judgment, distinct from "broken"), approve→notice.
 */
export function renderCiSummary(result: GateResult): CiAnnotation {
  if (result.final === "approve") {
    return {
      level: "notice",
      title: "plumbline: APPROVE",
      message: "Receipt passed shape + semantic review. Merging automatically — no action needed.",
    };
  }

  const cap = result.review?.failure_capsule;
  const parts: string[] = [];

  if (result.final === "revise") {
    parts.push("Rework needed — the agent fixes the items in the PR comment and re-pushes.");
  } else {
    parts.push("Human approval required (protected/billing surface) — NOT a rubber stamp.");
  }
  if (cap?.failing_check) parts.push(`Focus: ${cap.failing_check}.`);

  if (result.review) {
    const riskCount = (result.review.risk_notes.match(/(?:^|\s)\d+[\).]/g) || []).length;
    const findings = riskCount > 0 ? `${riskCount} risk finding${riskCount === 1 ? "" : "s"} + validation notes` : "risk + validation notes";
    parts.push(`Read the ${findings} in the PR comment before merging.`);
  }

  return {
    level: result.final === "revise" ? "error" : "warning",
    title: `plumbline: ${result.final.toUpperCase()}`,
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

  const verdict = existingCurrent.match(/^##\s*\S+\s*plumbline:\s*(\w+)/m)?.[1] ?? "PRIOR";
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
