# Agents on a Mission

A pattern for running AI agents through a backlog of validated work, autonomously,
without losing the plot between tasks — and without letting an agent ship something
unsound. It is harness-agnostic: bring any executor (a CLI agent loop, a swarm, a
cron job). proofgate is the quality gate that makes the autonomy safe.

## The one idea

> Put the **queue** in your issue tracker, the **progress** in a file, the
> **discipline** in hooks, and the **judgment** in a gate.

Agent memory is the wrong place for any of those. Externalize all four and an agent
can grind for hours across many batches and still be correct, resumable, and
auditable.

## The four pieces

| Piece | Lives in | Why |
|-------|----------|-----|
| **Queue** | Issue tracker (e.g. GitHub Issues) with a human-applied `agent-ready` label. `gh issue list --label agent-ready` IS the queue. | Durable, auditable, triageable from anywhere (incl. a phone). The human label is checkpoint #1 — agents only touch blessed work. |
| **Progress** | A checkpoint file (JSON): current batch, branch, PR, phase, completed issue ids. | Survives restarts/compaction. Resume = read the file, not the agent's memory. |
| **Discipline** | Hooks (e.g. a stop-hook that refuses to end the session while `agent-ready` work remains). | Behavior you can't train reliably becomes environmental enforcement. |
| **Gate** | **proofgate** — proof receipt + deterministic shape check + semantic review vs a MISSION. | Checkpoint #2: nothing merges without proof it advances the mission and weakens no invariant. |

## The loop

```
issue (needs-spec) ──human triage──▶ agent-ready          ← human checkpoint #1 (intake)
   ▼ executor picks one, removes the label, opens a branch
implement (test-first) ─▶ adversarial self/2nd-agent review ─▶ PR with a proof receipt
   ▼ proofgate
   ├─ approve   → auto-merge (squash)
   ├─ revise    → 🤖 agent fixes the capsule's agent_actions, re-pushes
   └─ escalate  → 🧑 human decides human_actions                 ← human checkpoint #2 (output)
   ▼ merge → deploy → verify live → close issue → next batch
```

## Human vs. agent, made explicit

The failure capsule proofgate returns is **split by who must act** — and a single PR
can have both:

- **`agent_actions`** — concrete fixes an agent can do now (code, security, tests).
  Populated even on `escalate`, so an escalated PR still hands the agent its
  actionable list to work in parallel.
- **`human_actions`** — decisions only a human can make (protected/billing override,
  a real trade-off, ambiguous intent).

How aggressively work routes to humans is the **`human_review_level`** policy dial
(`low` / `balanced` / `high`). It tunes the split only — it never lowers the hard
floor: protected paths and `self_modifying` work always require a human, at any level.

## Guardrails (don't skip these)

- **Humans apply `agent-ready`.** Agents never promote their own work into the queue.
- **`self_modifying` never auto-merges.** Migrations, auth, payments, compliance
  records, dependency/CI/gate changes always wait for a human.
- **Mass-outbound and destructive/irreversible ops are `human-only`** — never
  auto-drained.
- **Concurrency 1–2.** More agents racing the main branch causes conflicts and
  coordination failures.
- **Strict issue template.** A missing "Acceptance criteria" section is the #1 cause
  of an agent confidently grinding in the wrong direction. The template's acceptance
  criteria becomes the receipt's `validation_plan`.

## Why it works

The failure mode of long autonomous runs isn't a bad PR slipping through — the gate
catches that. It's an agent doing many batches of *plausible* work toward a
slightly-wrong target because the issues were vague. The strict template + the human
`agent-ready` checkpoint guard the intent; proofgate guards the execution. Together
they let the middle run unattended.

## Bring your own harness

This repo (proofgate) ships the gate. The queue is your issue tracker; the executor
and the stop-hook/checkpoint discipline are whatever runs your agents. Minimum viable
setup: an issue template, three labels (`agent-ready` / `human-only` / `needs-spec`),
a one-line `gh issue list` query your executor polls, and proofgate wired into CI.
