# Tasks — Verdict semantics: turn-based REWORK/REVIEW split + convergent re-review

- [x] Add a two-axis finding model (`class: blocking|advisory`, `actor: agent|human`) to the review schema and `FailureCapsule` (backward-compatible).
- [x] Derive the verdict mechanically from the findings (`selectVerdict`): any blocking+agent ⇒ rework (even on a protected path); blocking+human or protected floor with empty agent set ⇒ review; else approve.
- [x] Partition findings so advisory notes render in their own non-blocking section and never affect the verdict.
- [x] Update the review prompt + response schema + parsing to emit/consume findings; keep parsing the legacy `agent_actions`/`human_actions` split.
- [x] Build a delta-review contract on re-review (prior capsule + fix commits; verify prior items + review only changed hunks).
- [x] Recover round count and prior capsule from the durable gate comment; wire into the CLI run path.
- [x] Enforce the convergence cap after 2 rework rounds (regressions-only block; else escalate to review with a "did not converge" banner).
- [x] Tests: verdict selection (agent-blocking ⇒ rework even on protected path; empty-agent-set ⇒ review), advisory partitioning, delta-prompt construction, round cap.
- [x] `npx tsc --noEmit`, `npm test`, `npm run bundle` (committed dist/index.js rebuilt to satisfy dist-check).
- [x] receipt: `plumb receipt --write`, fill judgment fields, `plumb check`.
