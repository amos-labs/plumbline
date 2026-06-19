import type { GateResult } from "./types.js";

/** Render the gate result as a PR comment (GitHub-flavored markdown). */
export function renderComment(result: GateResult): string {
  const icon =
    result.final === "approve" ? "✅" : result.final === "revise" ? "🔁" : "⚠️";
  const lines: string[] = [];
  lines.push(`## ${icon} proofgate: ${result.final.toUpperCase()}`);
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
      "> **⚠️ Human approval required — nothing for the agent to fix.** Touches a protected/billing surface, so a maintainer must consciously override-merge: `gh pr merge <PR> --squash --admin`.",
    );
  }
  lines.push("");

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
  lines.push("<sub>proofgate · proof-carrying gate for agent work</sub>");
  return lines.join("\n");
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

  // Find an existing proofgate comment to update instead of stacking.
  const list = await fetch(`${api}?per_page=100`, { headers });
  if (list.ok) {
    const comments = (await list.json()) as Array<{ id: number; body: string }>;
    const mine = comments.find((c) => c.body.includes("proofgate · proof-carrying gate"));
    if (mine) {
      const upd = await fetch(
        `https://api.github.com/repos/${repo}/issues/comments/${mine.id}`,
        { method: "PATCH", headers, body: JSON.stringify({ body }) },
      );
      if (upd.ok) return;
    }
  }

  const res = await fetch(api, { method: "POST", headers, body: JSON.stringify({ body }) });
  if (!res.ok) {
    throw new Error(`failed to post PR comment: ${res.status} ${await res.text()}`);
  }
}
