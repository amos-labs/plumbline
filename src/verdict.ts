import type { GateOutcome } from "./types.js";

/**
 * Single source of truth for how a gate verdict is PRESENTED across every
 * surface (issue #54).
 *
 * The incident: REWORK ("do NOT merge — the agent must fix + re-push") and
 * REVIEW ("clean — awaiting an explicit human sign-off") both surfaced as the
 * SAME red "Plumbline Gate → failure" required check and a near-identical PR
 * comment. A maintainer could not tell them apart and merged a REWORK by
 * accident (amos-platform#211 — a security fix whose receipt was shape-FAIL).
 *
 * Fix: every surface reads the verdict's presentation from THIS one map, so the
 * three states can never collapse into one indistinguishable red X again:
 *
 *   - `checkName`   — a per-verdict GitHub check-run NAME, so the Checks list
 *                     literally spells out which state it is.
 *   - `conclusion`  — a per-verdict GitHub check-run CONCLUSION. REWORK is a
 *                     hard `failure` (do-not-merge); REVIEW is `action_required`
 *                     (needs a human), which renders differently in the UI from
 *                     a plain failure; PASS is `success`.
 *   - `commentTitle`— the PR-comment H2, screaming the verdict + next action.
 *   - `annotation`  — the one-line Checks-tab annotation (level + title).
 *   - `mergeable`   — whether an ORDINARY merge should proceed (only PASS).
 *
 * REALITY CHECK (honest by design): a repo admin can ALWAYS override a failing
 * required check, so no code here can make a REWORK literally un-mergeable. The
 * enforceable defense is UNMISTAKABLE CLARITY — distinct name, distinct
 * conclusion, distinct comment — so a human never mistakes a REWORK for a
 * REVIEW (or for a plain broken-CI failure). Turning REVIEW into an explicit
 * "approve" action (rather than "merge past red") is the follow-on in
 * amos-platform#208; v1 here is the unmistakable distinct states.
 */

/** GitHub check-run conclusions we emit. `action_required` reads distinctly from `failure` in the PR UI. */
export type CheckConclusion = "success" | "failure" | "action_required";

export interface VerdictPresentation {
  /** The outcome this presentation is for. */
  verdict: GateOutcome;
  /** Distinct GitHub check-run name — the Checks list names the exact state. */
  checkName: string;
  /** Distinct GitHub check-run conclusion. */
  conclusion: CheckConclusion;
  /** Emoji + short label used in the check-run title. */
  label: string;
  /** PR-comment H2 — screams the verdict and who must act. */
  commentTitle: string;
  /** One-line banner directly under the comment title (WHO acts + next step). */
  commentBanner: string;
  /** GitHub Actions annotation level for the Checks-tab one-liner. */
  annotationLevel: "error" | "warning" | "notice";
  /** Whether an ORDINARY (non-admin) merge should proceed. Only PASS. */
  mergeable: boolean;
}

/**
 * The canonical verdict → presentation table. Everything user-facing derives
 * from here. Note the deliberately DIFFERENT check names and conclusions:
 *
 *   verdict   checkName                            conclusion         merge?
 *   approve   Plumbline: PASS                      success            yes
 *   rework    Plumbline: REWORK — blocked          failure            NO (agent)
 *   review    Plumbline: REVIEW — needs approval   action_required    NO (human)
 */
const TABLE: Record<GateOutcome, VerdictPresentation> = {
  approve: {
    verdict: "approve",
    checkName: "Plumbline: PASS",
    conclusion: "success",
    label: "✅ PASS",
    commentTitle: "✅ Plumbline: PASS — merging automatically",
    commentBanner:
      "**✅ Passed shape + semantic review. Merging automatically — no action needed.**",
    annotationLevel: "notice",
    mergeable: true,
  },
  rework: {
    verdict: "rework",
    checkName: "Plumbline: REWORK — blocked, do not merge",
    conclusion: "failure",
    label: "🔁 REWORK",
    commentTitle: "🔁 Plumbline: REWORK — BLOCKED, do NOT merge",
    commentBanner:
      "**🔁 REWORK — do NOT merge. The agent must fix the 🤖 items below and re-push.** " +
      "This is the agent's turn, not a human sign-off — merging now ships un-reworked code.",
    annotationLevel: "error",
    mergeable: false,
  },
  review: {
    verdict: "review",
    checkName: "Plumbline: REVIEW — awaiting human approval",
    // action_required (not failure): the UI renders it as "needs a human to act"
    // rather than "broken", which is exactly the REVIEW semantic — and makes it
    // visually distinct from a REWORK failure at a glance.
    conclusion: "action_required",
    label: "⚠️ REVIEW",
    commentTitle: "⚠️ Plumbline: REVIEW — awaiting explicit human approval",
    commentBanner:
      "**⚠️ REVIEW — Human approval required. This is the human's turn: no agent rework needed, but this is NOT a rubber stamp.** " +
      "A maintainer must read the findings and, if sound, approve/override-merge. Merging must be a deliberate act — do not confuse this with a REWORK (agent-fix) failure.",
    annotationLevel: "warning",
    mergeable: false,
  },
  // INDETERMINATE (infra_error, v0.6.1): the gate could NOT evaluate because a
  // GitHub infrastructure call failed transiently (503/timeout/etc.) and
  // survived every retry. This is NEITHER a rework NOR an approval — there is
  // no code verdict at all. It BLOCKS auto-merge (exit non-zero: we could not
  // verify), but the wording must never read as "agent's turn to fix code"
  // (REWORK) or as green PASS. It is trivially re-runnable: a fresh gate run
  // once GitHub recovers produces a real verdict. Uses `action_required` so the
  // UI reads it as "a human needs to act" (re-run) rather than a red "broken"
  // failure — and the distinct 🔌 icon + wording keeps it unmistakable.
  indeterminate: {
    verdict: "indeterminate",
    checkName: "Plumbline: INDETERMINATE — could not evaluate (GitHub infra error)",
    conclusion: "action_required",
    label: "🔌 INDETERMINATE",
    commentTitle: "🔌 Plumbline: INDETERMINATE — could not evaluate (GitHub infrastructure error)",
    commentBanner:
      "**⚠️ Gate could not evaluate — GitHub infrastructure error (e.g. 503/timeout), NOT a code verdict.** " +
      "This is **neither a REWORK nor an approval**: the gate never assessed the code — a GitHub API call " +
      "failed transiently and survived all retries. Do NOT change the code in response to this, and do NOT " +
      "merge on it. **Re-run the gate when GitHub recovers** and it will produce a real verdict.",
    annotationLevel: "warning",
    mergeable: false,
  },
};

/** Resolve the presentation for a gate outcome. The one lookup every surface uses. */
export function verdictPresentation(verdict: GateOutcome): VerdictPresentation {
  return TABLE[verdict];
}
