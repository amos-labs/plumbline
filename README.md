# Plumbline

*“Behold, I will set a plumb line in the midst of my people” — Amos 7:8. The prophet’s own symbol: the line work is measured against.*

**A proof-carrying gate for AI agent work.** Agent PRs ship with a structured receipt; a deterministic shape check and an LLM semantic review judge the work against your repository's mission before a human ever reads the diff. Failed reviews produce a structured *failure capsule* the agent can use as its rework prompt.

Extracted from the [AMOS](https://github.com/amos-labs) proof-carrying autonomous loop. Apache 2.0.

**Plumbline gates Plumbline.** This repo runs its own gate on every PR — self-modifying changes to the gate itself escalate to human review. The loop is proven on the tool that implements it.

**Compatible with [OpenSpec](https://github.com/Fission-AI/OpenSpec). Dependent on nothing.** The intake and archive ends of the loop follow OpenSpec's format and lifecycle conventions (MIT — see `THIRD-PARTY.md`), so existing `openspec/` folders just work — and every stage is adoptable on its own.

## Three ways in — adopt what you want

Every stage stands alone; none requires the previous one.

1. **Gate-only (5 minutes).** `plumb init`, make `plumbline` a required check, agents ship receipts via `plumb receipt --write`. You get the proof half: every PR hash-bound to a receipt, judged against your mission.
2. **The full loop.** `propose → work → receipt --write → check → gate → archive` — intake contracts, proof, and living specs, one tool end to end.
3. **Bring your OpenSpec.** Already spec-driven? Your `openspec/changes/` folders are the contract: `plumb receipt --write` binds the diff to them and `plumb archive` applies your deltas to `openspec/specs/` — no workflow change.

## Quick start (agent-installable)

One command scaffolds the workflow, policy, mission, an example receipt, and an
**`AGENTS.md`** that tells an AI agent exactly how to satisfy the gate:

```bash
npx github:amos-labs/plumbline init   # scaffold .github/workflows + .plumbline/ + AGENTS.md
```

Then the full lifecycle — **propose → work → prove → gate → archive** — starts at intake:

```bash
npx github:amos-labs/plumbline propose "Rotate auth session tokens" --body "Tokens never expire today."
# → opens the GitHub issue AND scaffolds openspec/changes/rotate-auth-session-tokens/
#   (proposal.md + specs/ + tasks.md), born linked: the issue number is written into the
#   proposal's task_id front-matter, the issue body carries the contract path. Prints an
#   informational self_modifying prediction from the policy's protected paths.
#   --lite = plain issue, no contract folder (typo-fix-grade work).
# …fill the contract's Why / What Changes / Scope (judgment — yours), get it approved, do the work…
```

Then the per-PR loop (no human needed after one-time setup):

```bash
npx github:amos-labs/plumbline receipt --write   # one idempotent step: scaffold .plumbline/receipts/<branch>.json
                                                 # (or refresh it) with ALL mechanical fields computed —
                                                 # diff_sha256, changed_files, and self_modifying derived from
                                                 # the policy's protected paths. Judgment fields never touched.
# …fill intent / validation_plan / execution_evidence / result_summary (the judgment half — yours to assert)…
npx github:amos-labs/plumbline check             # local pre-flight — same shape+diff checks as CI; must PASS before push
```

After more commits or a rebase, just run `receipt --write` again — it refreshes the
mechanical fields and preserves everything you wrote. `receipt --check` (exit 1 when
stale) is small enough for a pre-push hook. One receipt file per PR at
`.plumbline/receipts/<task>.json` — never a shared `receipt.json`. (Legacy `.proofgate/` repos work unchanged — the tool reads both.)
The split is deliberate: **automate the bookkeeping, never the judgment** — the tool
computes what's derivable (hashes, file lists, protected-path escalation) and refuses
to write what only the author can assert. (`new` and `stamp` remain as the underlying
single-purpose commands.)

And once the PR is merged, close the loop — recorded truth:

```bash
npx github:amos-labs/plumbline archive rotate-auth-session-tokens
# → applies the change's ADDED/MODIFIED/REMOVED spec deltas to openspec/specs/ (the living
#   source of truth a fresh agent reads to know how the system behaves), then moves the
#   change to openspec/changes/archive/<date>-rotate-auth-session-tokens/ with full context.
#   Refuses unless the change's receipt passes the gate — proof precedes truth (--force overrides, loudly).
```

`init` prints the two human-only steps (make `plumbline` a required check; add the
`ANTHROPIC_API_KEY` secret) — also spelled out in `.plumbline/AGENTS.md`. See that
file for the full agent guide.

## The problem

AI agents multiply your velocity until the codebase quietly diverges from your intent — every PR looks fine, the project drifts. Reviewing everything yourself caps velocity at your reading speed. Trusting the agent loses the project over time. Plumbline is the missing middle: **legibility as the control surface.** Work carries proof; humans review exceptions.

## How it works

```text
agent does work
  -> emits .plumbline/receipt.json   (intent, validation plan, evidence, changed files, self_modifying flag)
  -> shape gate                       deterministic: schema, evidence coverage, protected paths, SHA/diff integrity
  -> semantic review                  one LLM call vs your MISSION.md: coverage, alignment, risk
  -> verdict
       approve   -> CI check green, merges automatically
       revise    -> capsule's 🤖 agent_actions; agent reworks and resubmits (no human needed)
       escalate  -> capsule's 🧑 human_actions; a human decides (always for self-modifying)
```

Two-tier validation, on purpose: the shape gate never pretends to understand meaning, and the reviewer never re-does deterministic checks.

**The capsule splits who must act.** Every failure capsule separates `agent_actions`
(concrete fixes an agent can do now) from `human_actions` (decisions only a human can
make) — and a PR can carry **both**. An `escalate` still lists `agent_actions` so the
agent-fixable parts proceed in parallel while a human decides the rest; it no longer
pretends "there's nothing for the agent to do." How aggressively work routes to humans
is the `human_review_level` dial (`low` / `balanced` / `high`) in `policy.json` — it
tunes the split only and never lowers the hard floor (protected paths + `self_modifying`
always need a human).

## Quick start

1. **Write your constitution.** Copy `templates/MISSION.md` to `.plumbline/MISSION.md` and fill it in. This is the highest-leverage hour you'll spend: state what the project is for, the invariants no change may weaken, and which surfaces are protected.

2. **Add the policy.** Copy `templates/policy.json` to `.plumbline/policy.json`. Set `required_checks` (commands every validation plan must include, e.g. your test suite) and `protected_paths` (globs that force `self_modifying: true` and human review).

3. **Add the CI hook.**
   - **GitHub:** copy `templates/workflow.yml` to `.github/workflows/plumbline.yml`, add `ANTHROPIC_API_KEY` to repo secrets, make the check required in branch protection.
   - **Azure DevOps:** copy `templates/azure-pipelines.yml`, add `ANTHROPIC_API_KEY` as a secret variable, grant the build service "Contribute to pull requests", and add the pipeline as a required build validation policy. The gate posts/updates a PR thread (active on revise/escalate, resolved on approve).

4. **Teach your agent the contract.** Add to your `CLAUDE.md` / agent instructions: every PR must include a receipt conforming to `templates/receipt.example.json`, with real evidence from commands actually run.

   **Use one receipt file per PR: `.plumbline/receipts/<task_id>.json`** (e.g. `.plumbline/receipts/ISSUE-142.json`). Because each PR writes a *different* filename, many PRs can be open at once without ever conflicting on the receipt — essential for autonomous / parallel agent work. The gate auto-discovers the receipt added in the PR's diff. The legacy single-file receipt (and the whole `.proofgate/` dir from the tool’s pre-rename era) still works for one-PR-at-a-time repos.

## CLI

The complete command set, in lifecycle order:

```bash
plumb init             # scaffold the gate into a repo: workflow + .plumbline/ + AGENTS.md — start here
plumb propose "<ask>"  # intake: GitHub issue + openspec/changes/<slug>/ contract folder, born linked
                       #   (--lite = plain issue, no folder — typo-fix-grade work)
plumb receipt --write  # one idempotent step: scaffold or refresh the per-PR receipt's mechanical fields
                       #   (diff_sha256, changed_files, self_modifying) — judgment fields never touched
plumb receipt --check  # mechanical staleness only; exit 1 if stale — pre-push-hook friendly
plumb new              # lower-level: scaffold a fresh per-PR receipt (receipt --write supersedes)
plumb stamp            # lower-level: fill diff_sha256 + changed_files only (receipt --write supersedes)
plumb check            # local pre-flight: shape + diff_sha256, prints the would-be capsule — no push needed
plumb shape            # deterministic checks only — fast, no API key needed
plumb review           # shape + semantic review, prints JSON verdict
plumb run              # CI mode: shape + review + posts/updates the PR comment
plumb archive <slug>   # close the loop: apply the change's spec deltas to openspec/specs/ (the living
                       #   source of truth), move it to openspec/changes/archive/<date>-<slug>/;
                       #   refuses unless the receipt passes the gate (--force overrides, loudly)
plumb schema           # print the receipt field reference
```

`stamp` + `check` close the loop in the working tree: `stamp` generates the two most error-prone,
recompute-on-every-edit fields (`diff_sha256`, `changed_files`) with the exact computation the gate
uses, and `check` runs the same shape + diff-integrity verification the CI action does — so receipt
errors are caught before pushing, instead of via a red CI round-trip (which burns Actions minutes).
Author the intent/plan/evidence; let `stamp` handle the mechanical fields.

Common flags: `--receipt <path>` `--policy <path>` `--base <ref>` `--mission <path>` `--no-git` (fixture testing).

Exit code is the gate: `0` only on approve.

### Evidence integrity (`ci_evidence_checks`)

`execution_evidence[].status` in the receipt is *self-reported* — by itself the gate would be
taking "the suite passed" on faith. Set `ci_evidence_checks` in the policy to the GitHub
**check-run names** that must actually conclude `success` for the PR head commit (e.g.
`["test"]`). In `run` mode the gate reads the **real** check-run conclusions for that commit and
fails if a required check didn't pass — so a receipt can't claim a passing suite the CI didn't
run. The receipt declares the *plan*; CI *proves* it. (Agents needn't fuss over self-reporting
status for these — CI is the source of truth, and an optimistic receipt is caught.)

### Tuning strictness (`strictness` / `check_severity`)

How much of the gate hard-fails is **policy, not code**. Two knobs in `policy.json`:

```jsonc
{
  "strictness": "standard",                        // strict (default) | standard | lenient
  "check_severity": { "undeclared_files": "off" }  // per-check override: error | warn | off
}
```

Every finding belongs to a named check: `schema`, `receipt_size`, `required_checks`,
`evidence_coverage`, `protected_paths`, `diff_integrity`, `undeclared_files`, `ci_evidence`.
Resolution: error (base) → preset → `check_severity` override. `warn` shows in the PR
comment without failing the gate; `off` suppresses with a note.

| Preset | Relaxes (→ warn) |
|---|---|
| `strict` (default) | nothing — every finding is an error |
| `standard` | `undeclared_files`, `receipt_size` |
| `lenient` | those + `required_checks`, `evidence_coverage`, `ci_evidence` |

**The floor never moves:** `schema`, `diff_integrity` (the hash binding), and
`protected_paths` (the `self_modifying` human-review escalation) can never be downgraded —
a policy that tries gets a warning and they stay errors. They are the point of the tool.

### Attempt history (reruns keep context)

The gate updates a single PR comment in place — but a rerun no longer erases the previous
result. Prior attempts are archived, newest first, in a collapsed **📜 Attempt history**
section (capped at 5), so an agent picking up a multi-round fix sees the whole trajectory —
what attempt #1 failed on, what changed — in one comment.

## The receipt

The contract an agent must satisfy (`templates/receipt.example.json`):

| Field | Meaning |
|---|---|
| `intent` | What this change is for, in plain language (min 40 chars — no "fix stuff") |
| `policy_refs` | Which mission/policy docs the agent read |
| `validation_plan` | Commands + *why each one covers the change* + required flag |
| `execution_evidence` | What actually ran, status, output reference |
| `changed_files` | Must account for the real diff — undeclared changes fail the gate |
| `diff_sha256` | sha256 of `git diff <base>...HEAD -- . ':(exclude).plumbline/receipt.json' ':(exclude).plumbline/receipts/*.json' ':(exclude).proofgate/receipt.json' ':(exclude).proofgate/receipts/*.json'` — **3-dot (merge-base), over the committed HEAD** (not `--cached`, not the working tree), receipts excluded. Binds the receipt to the diff so receipts can't be recycled. `<base>` is auto-detected (your default branch) — `origin/main` *or* `origin/master`. **Always run `plumb receipt --write` (or `plumb stamp`) rather than hand-computing** (`git diff --cached` / 2-dot give a different hash). Excluding the receipt makes it computable before the commit (a commit can't contain its own SHA); a content hash also survives GitHub's merge-ref checkout where a head SHA cannot. |
| `self_modifying` | True if protected surfaces are touched; removes any auto-approve path |
| `result_summary` | What a human should know before merging |

## Design rules inherited from AMOS

- **Self-modifying work has no override path.** Changes to auth, payments, migrations, the gate itself — whatever you mark protected — always require a human, regardless of how good the review looks.
- **Low confidence never auto-approves.** Verdicts below `min_review_confidence` are downgraded to escalate.
- **Failure capsules, not log dumps.** A revise verdict includes the failing check, suspected cause, implicated files, and a single concrete next action — structured to be fed straight back to the agent.
- **The gate protects itself.** `.plumbline/**` (and legacy `.proofgate/**`) and your workflows belong in `protected_paths`.

## Running agents at scale

Plumbline is the *gate*; pair it with an issue-tracker queue + an executor and you have
an autonomous delivery loop. See **[docs/AGENTS_ON_A_MISSION.md](docs/AGENTS_ON_A_MISSION.md)** —
a harness-agnostic pattern: queue in your issue tracker (a human-applied `agent-ready`
label), progress in a checkpoint file, discipline in hooks, judgment in this gate. Two
human checkpoints (apply `agent-ready` on intake; `self_modifying`/escalate on output)
let the middle run unattended.

## Operating notes (learned in production)

- **One receipt file per PR** (`.plumbline/receipts/<task_id>.json`) — many PRs open at
  once never conflict on the receipt. The gate auto-discovers the one in the diff.
- **Compute `diff_sha256` and write the receipt in the *same* step.** The hash is over
  the diff *excluding* receipt paths, so it's computable before committing the receipt —
  but shell variables don't persist across separate tool calls, so compute-and-write
  together or you'll ship an empty/stale SHA and fail the shape gate.
- **`self_modifying` PRs don't auto-merge** — wire auto-merge only for non-self_modifying
  green PRs; protected work waits for a human override-merge.
- **Mass-outbound / irreversible prod ops should be `human-only`**, not auto-drained.
- **Keep agent concurrency at 1–2** against a shared main branch.

## Status

v0. Single-repo, GitHub Actions + Anthropic API. Planned: drift monitoring (scheduled job sampling merged work against the mission), provider abstraction (Bedrock), check-runs API instead of comments, receipt signing.
