---
name: plumbline
description: >-
  Operate inside a Plumbline-gated repository. Use whenever the repo contains a
  .plumbline/ (or legacy .proofgate/) directory, whenever a PR must ship a proof
  receipt, or whenever the user mentions Plumbline, plumb, proof receipts,
  receipt.json, the gate, a gate verdict (APPROVE / REWORK / REVIEW), a failure
  capsule, or diff_sha256. Covers the full loop: propose, receipt --write,
  check, and responding to gate verdicts correctly.
---

# Plumbline — operating a proof-carrying gate

You are working in (or asked about) a repository gated by **Plumbline**: every PR
must carry a **proof receipt** — your declared intent, your validation plan, and
the evidence of what actually ran — hash-bound to the diff. A deterministic shape
check and an LLM semantic review judge the work against the repo's
`.plumbline/MISSION.md` before a human reads the diff. **A PR without a passing
receipt does not merge.**

This skill is your judgment layer. The repo may also have a `.plumbline/AGENTS.md`
(scaffolded by `plumb init`) — read it; it carries repo-specific conventions
(required checks, migration rules, CI names) and it wins on any repo-specific
detail. This skill covers what AGENTS.md cannot: how to write receipts that
deserve to pass, and how to behave when the gate pushes back.

## Detecting a gated repo

If `.plumbline/` exists (or legacy `.proofgate/` — the tool reads both), this
skill's rules apply to every PR you open there. Orient first:

- `.plumbline/MISSION.md` — the constitution your work is judged against. Read it
  before writing code, not after.
- `.plumbline/policy.json` — `required_checks` (commands every validation plan
  must include), `protected_paths` (globs that force `self_modifying: true` and
  human review), `ci_evidence_checks` (CI check-run names the gate corroborates).
- `.plumbline/AGENTS.md` — the repo's own agent guide, if present.
- `.plumbline/receipts/` — prior receipts; the naming convention (issue number,
  branch, ticket id) tells you what to call yours.

The CLI is `plumb` if installed, otherwise `npx github:amos-labs/plumbline`.
`plumb schema` prints the full receipt field reference — trust it over memory.

## The workflow

```bash
plumb propose "<title>" --body "<why>"   # intake: GitHub issue + openspec/changes/<slug>/
                                          # contract, born linked (--lite = plain issue,
                                          # for typo-fix-grade work)
git checkout -b <branch>                  # …do the work, commit it…
plumb receipt --write --task <id>         # stamp mechanical fields: diff_sha256,
                                          # changed_files, self_modifying
# …fill the judgment fields: intent, policy_refs, validation_plan,
#    execution_evidence, result_summary…
plumb check                               # pre-flight: shape + diff_sha256 ONLY
git add .plumbline && git commit && git push   # then open the PR
```

The gate runs in CI and posts a verdict comment on the PR. Then it's turn-based —
see "Verdict semantics" below.

Two things to internalize about this loop:

- **`plumb receipt --write` is idempotent and only touches mechanical fields.**
  Run it after *every* new commit or rebase — it refreshes `diff_sha256`,
  `changed_files`, and `self_modifying` (derived from the policy's
  `protected_paths`) and preserves everything you wrote. Never hand-edit those
  three fields; never hand-compute the hash (the gate uses a 3-dot merge-base
  diff over the committed HEAD with receipt paths excluded — `receipt --write`
  runs the identical computation).
- **`plumb check` is the shape floor, not the verdict.** It verifies the receipt
  is well-formed and the hash matches — fast, offline, free — and prints a scoped
  `shape pre-flight PASS/FAIL` banner. It deliberately does **not** run the LLM:
  a shape-PASS locally can still come back REWORK or REVIEW once the semantic
  review runs in CI. For full local parity run `plumb check --review` (needs
  `ANTHROPIC_API_KEY` or a `PLUMBLINE_PROVIDER`/`PLUMBLINE_API_KEY` setup;
  without a key it degrades to shape-only and says so).

## Receipt-writing quality (the heart of this skill)

The receipt is not paperwork. It is the artifact a human trusts *instead of*
re-reading your diff, and the semantic review compares it against the actual
diff. A receipt that games the form defeats the point and — worse — usually gets
caught, because the review reads both sides.

**`intent` — what AND why, ≥40 chars.** Not "update files" but the problem being
solved and why this change solves it. If the work traces to an issue or a
`propose` contract, say so. The reviewer judges mission alignment from this field;
give it something to judge.

**`validation_plan` — real checks with real commands.** Each entry is
`{ command, reason, required, id?, ci_covered? }`. The `reason` must say why
*this* check covers *this* change — "runs tests" is not a reason; "exercises the
new verdict-selection paths added in src/review.ts" is. Include everything the
policy's `required_checks` demands. Give steps an `id` so evidence matches
robustly (evidence's `step` field beats byte-identical command strings).

**`execution_evidence` — what actually ran and what it actually said.** Each
entry is `{ command, status, output_ref?, skip_reason?, step? }`; `status` is a
strict enum: `passed` | `failed` | `skipped` — nothing else. `output_ref` should
carry the load-bearing line ("218/218 pass", "exit 0 — no type errors"), not a
vague "it worked". Two hard rules:

- **Never claim evidence you didn't produce.** If you didn't run it, it isn't
  `passed`. The gate corroborates `ci_evidence_checks` against the PR's *real*
  CI check-run conclusions, so an optimistic receipt is caught mechanically —
  but don't rely on being caught; rely on being honest.
- **Never claim evidence CI *will* produce.** Steps that only run in CI belong in
  the plan as `"ci_covered": true` (or named exactly as a policy
  `ci_evidence_checks` entry); their evidence may then be `skipped` with a
  `skip_reason` like "CI-covered". Everything you *can* run locally, run locally
  and record truthfully.

**`result_summary` — what a human should know before merging, ≥40 chars.** What
changed, how it was verified, and anything surprising. This plus `intent` is what
the merging human actually reads.

**`policy_refs`** — list the mission/policy docs you actually read. Then actually
read them.

After the receipt is filled: commit everything, run `plumb receipt --write` one
final time (the hash binds the *committed* HEAD), then `plumb check`, then push.
**Re-stamp after every rebase** — a rebase changes the diff, and a stale
`diff_sha256` fails the shape gate. `plumb receipt --check` exits 1 when the
mechanical half is stale; it's small enough for a pre-push hook.

## Verdict semantics — whose turn is it

The gate's verdict encodes exactly one thing: **whose turn it is.** It is derived
mechanically from classified findings, not vibes. Act on it literally.

**APPROVE ✅ — done.** No blocking findings; the PR merges (automatically, if
auto-merge is wired and the work isn't `self_modifying`). Any 💡 **advisory**
notes are non-blocking — address the cheap ones if you're still in context, leave
the rest; either way they never hold up the merge and are not rework.

**REWORK 🔁 — your turn.** The comment lists 🤖 agent-fixable defects. Fix
*exactly* the listed items — no more, no less — then `plumb receipt --write`,
update the evidence for anything you re-ran, and re-push. Re-review is
**convergent**: the gate re-reviews only your fix commits for regressions and
does not re-litigate code it already passed, so don't re-open settled findings
and don't gold-plate beyond the list. A REWORK contains no human items by
construction — it self-clears once the agent set is empty, *even on a protected
path*. After 2 rework rounds a convergence cap engages and anything unresolved
escalates to REVIEW ("gate did not converge — human decides"); if you see that
banner, stop reworking.

**REVIEW ⚠️ — the human's turn, not yours.** By construction it contains zero 🤖
items — there is nothing for you to fix. It lists 🧑 decisions only a human can
make (a protected-surface change, a real trade-off, irreducibly ambiguous
intent). **Stop. Do not churn the PR.** Summarize for the user: what the gate
flagged, what decision is needed, and your recommendation. Then wait. Inventing
code changes to "satisfy" a REVIEW is churn, not progress.

## Footguns (each one is a real incident)

- **Marking CI-run steps as manual evidence → REWORK loops.** A step like
  "CI: Lint & Integration" listed as `required` with `status: "skipped"` and no
  `ci_covered` flag is a hard shape fail; listing it as `passed` when you never
  ran it is dishonest and contradicted by the real check-runs. Mark it
  `"ci_covered": true` and let CI be the source of truth.
- **The protected floor is not negotiable.** Paths in `protected_paths` (the
  gate's own config, workflows, auth, migrations — whatever the repo marks) force
  `self_modifying: true` and a human in the loop. The floor forbids only
  auto-APPROVE — you still fix REWORK items on protected work — but never attempt
  to route around it: not by setting `self_modifying: false` (hard fail), not by
  splitting the protected bit into a "separate" PR to slip it past, not by asking
  the user to relax the policy so your PR merges. `strictness`/`check_severity`
  can never downgrade `schema`, `diff_integrity`, or `protected_paths` — they are
  the point of the tool.
- **Receipts are per-PR.** One file per PR at
  `.plumbline/receipts/<task_id>.json`, never a shared `receipt.json`, never a
  receipt reused across PRs. The hash binding exists precisely so receipts can't
  be recycled; the gate auto-discovers the receipt added in the PR's diff.
- **A rebase invalidates the stamp.** Any change to the committed diff — rebase,
  amend, merge from base, even a follow-up commit — makes `diff_sha256` stale and
  fails shape. The fix is always the same: `plumb receipt --write`, commit,
  re-verify with `plumb check`.

## Ethics — the gate is the point

Plumbline exists so a human can trust agent work without re-reading every diff.
That trust is the product; a receipt that launders weak work destroys it.

- Never water down a receipt — vague intent, padded validation plans, evidence
  that technically parses but says nothing.
- Never game the reviewer — phrasing chosen to slip past the mission check,
  omitting the risky part of the change from `intent`, burying a behavior change
  in a "docs" PR.
- Never persuade a human to bypass the gate — not "just this once", not "the
  gate is being pedantic", not by proposing a `--force` or policy edit whose real
  purpose is to get your PR through.

If you believe the gate is *wrong* — a false finding, a policy that misfires, a
mission conflict — say so explicitly in the PR conversation, with your reasoning,
and let the human decide. Disagreeing openly is fine; routing around is not.

## Quick reference

| Command | What it does |
|---|---|
| `plumb propose "<title>" [--body …] [--lite]` | intake: issue + `openspec/changes/<slug>/` contract, born linked |
| `plumb receipt --write [--task id]` | stamp/refresh mechanical fields; judgment fields untouched |
| `plumb receipt --check` | exit 1 if the stamp is stale (pre-push-hook friendly) |
| `plumb check [--review]` | shape + diff pre-flight; `--review` adds the semantic review for the full verdict |
| `plumb schema` | every receipt field, required/optional, allowed enum values |
| `plumb run` | CI mode: shape + review + PR comment (the gate itself) |
| `plumb archive <slug>` | post-merge: apply spec deltas, archive the change; refuses unless the receipt passes |

Env: `ANTHROPIC_API_KEY` (default review provider), `PLUMBLINE_MODEL`,
`PLUMBLINE_PROVIDER=openai` + `PLUMBLINE_API_BASE` + `PLUMBLINE_API_KEY` for
OpenAI-compatible endpoints, `GITHUB_TOKEN` for `propose`/`run`/`setup-protection`.
Exit code is the gate: `0` only on a pass.
