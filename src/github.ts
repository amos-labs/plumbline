import type { GateResult } from "./types.js";

/** Render the gate result as a PR comment (GitHub-flavored markdown). */
export function renderComment(result: GateResult): string {
  const icon =
    result.final === "approve" ? "✅" : result.final === "revise" ? "🔁" : "⚠️";
  const lines: string[] = [];
  lines.push(`## ${icon} proofgate: ${result.final.toUpperCase()}`);
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
      lines.push("### Failure capsule (rework prompt)");
      lines.push("```json");
      lines.push(JSON.stringify(r.failure_capsule, null, 2));
      lines.push("```");
      lines.push(
        "_Agent: treat `next_action_requested` as your rework instruction. Resubmit with an updated receipt._",
      );
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
