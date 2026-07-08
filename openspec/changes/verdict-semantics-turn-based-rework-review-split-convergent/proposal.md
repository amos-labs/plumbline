---
title: "Verdict semantics: turn-based REWORK/REVIEW split + convergent re-review"
task_id: "41"
status: proposed
---

# Verdict semantics: turn-based REWORK/REVIEW split + convergent re-review

Make the gate verdict encode whose turn it is — exclusively — split findings into
blocking vs advisory, and make re-reviews convergent (delta-only, with a round cap)
so agents stop looping through growing nitpick lists.

## Why

Observed live on amos-managed-platform PRs #63–65:

1. **REVIEW verdicts carried BOTH 🧑 human items and 🤖 agent items.** The verdict
   said "the human's turn" while simultaneously handing the agent homework, so
   whose turn it actually was became ambiguous — the agent and the maintainer both
   waited on each other.
2. **Re-reviews did not converge.** Each round reviewed the whole PR afresh,
   resampled opinions, and raised NEW findings on already-reviewed, unchanged code
   (including "consider adding…" nice-to-haves). Agents looped through a growing
   nitpick list (PR #63 accumulated 8 items over 2 rounds) with no termination
   guarantee.

The root cause is that the verdict was taken from the model and the agent-fixable
set was appended to a REVIEW as a side list, and that every re-run was a fresh
full review. The fix is to derive the verdict mechanically from a two-axis
classification of findings, and to constrain re-reviews to a delta contract with a
hard round cap.

## What Changes

- **Turn-based verdict (Change 1).** The verdict is derived from the findings, not
  taken from the model:
  - ANY blocking, agent-actionable finding ⇒ **rework** — even when a protected
    path / self_modifying surface is touched. The protected floor only forbids
    auto-APPROVE; it must NOT skip the agent-iteration phase.
  - **review** is emitted only when the blocking-agent set is EMPTY (a blocking
    human finding exists, or the protected floor holds) ⇒ a REVIEW comment
    contains ZERO 🤖 items by construction.
  - **approve** only when there are no blocking findings and no protected floor.
- **Blocking vs advisory (Change 2).** The review returns each issue as a finding
  tagged `class: blocking | advisory` and `actor: agent | human`. Only blocking
  findings ever affect the verdict; advisory notes ("consider…", style,
  nice-to-haves) are recorded in the capsule and rendered in a separate,
  non-blocking section. Prompt, response schema, parsing, and rendering are all
  updated; the legacy `agent_actions`/`human_actions` split is still parsed
  (treated as blocking) for backward compatibility.
- **Convergent (delta) re-review + round cap (Change 3).** On a re-review the
  prompt receives the prior failure capsule + the fix commits, and is constrained
  to (a) verify the previously named blocking items are addressed and (b) review
  ONLY the new/changed hunks for regressions — it must not raise new findings on
  unchanged code it already reviewed. Round count is recovered from the durable
  gate comment's attempt history. A **convergence cap** engages after 2 rework
  rounds: only regressions-in-fixes may block; anything else is escalated to a
  human decision under an explicit "gate did not converge — human decides" banner.

## Scope / Non-goals

- In scope: verdict-selection logic, review prompt + response schema + parsing +
  rendering, delta-prompt construction, round-count derivation, the convergence cap.
- Backward compatibility: the proof-receipt schema is unchanged. The
  `FailureCapsule` gains optional `findings`, `advisory`, and `did_not_converge`
  fields; existing consumers that read `agent_actions`/`human_actions` keep working
  (those lists are now derived from the blocking findings).
- Non-goals: auto-filing advisory findings as follow-up issues (the issue lists it
  as optional — deferred); changing the shape gate, the protected-path floor
  definition, or the on-chain/settlement paths; changing the CI transport.
