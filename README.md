# proofgate

**A proof-carrying gate for AI agent work.** Agent PRs ship with a structured receipt; a deterministic shape check and an LLM semantic review judge the work against your repository's mission before a human ever reads the diff. Failed reviews produce a structured *failure capsule* the agent can use as its rework prompt.

Extracted from the [AMOS](https://github.com/amos-labs) proof-carrying autonomous loop. Apache 2.0.

## Quick start (agent-installable)

One command scaffolds the workflow, policy, mission, an example receipt, and an
**`AGENTS.md`** that tells an AI agent exactly how to satisfy the gate:

```bash
npx github:amos-labs/proofgate init   # scaffold .github/workflows + .proofgate/ + AGENTS.md
```

Then the per-PR loop (no human needed after one-time setup):

```bash
npx github:amos-labs/proofgate new     # scaffold .proofgate/receipts/<branch>.json, diff-stamped
# …fill intent / validation_plan / execution_evidence / result_summary…
npx github:amos-labs/proofgate stamp   # refresh diff_sha256 + changed_files after edits/rebase
npx github:amos-labs/proofgate check   # local pre-flight — same shape+diff checks as CI; must PASS before push
```

`init` prints the two human-only steps (make `proofgate` a required check; add the
`ANTHROPIC_API_KEY` secret) — also spelled out in `.proofgate/AGENTS.md`. See that
file for the full agent guide.

## The problem

AI agents multiply your velocity until the codebase quietly diverges from your intent — every PR looks fine, the project drifts. Reviewing everything yourself caps velocity at your reading speed. Trusting the agent loses the project over time. proofgate is the missing middle: **legibility as the control surface.** Work carries proof; humans review exceptions.

## How it works

```text
agent does work
  -> emits .proofgate/receipt.json   (intent, validation plan, evidence, changed files, self_modifying flag)
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

1. **Write your constitution.** Copy `templates/MISSION.md` to `.proofgate/MISSION.md` and fill it in. This is the highest-leverage hour you'll spend: state what the project is for, the invariants no change may weaken, and which surfaces are protected.

2. **Add the policy.** Copy `templates/policy.json` to `.proofgate/policy.json`. Set `required_checks` (commands every validation plan must include, e.g. your test suite) and `protected_paths` (globs that force `self_modifying: true` and human review).

3. **Add the CI hook.**
   - **GitHub:** copy `templates/workflow.yml` to `.github/workflows/proofgate.yml`, add `ANTHROPIC_API_KEY` to repo secrets, make the check required in branch protection.
   - **Azure DevOps:** copy `templates/azure-pipelines.yml`, add `ANTHROPIC_API_KEY` as a secret variable, grant the build service "Contribute to pull requests", and add the pipeline as a required build validation policy. The gate posts/updates a PR thread (active on revise/escalate, resolved on approve).

4. **Teach your agent the contract.** Add to your `CLAUDE.md` / agent instructions: every PR must include a receipt conforming to `templates/receipt.example.json`, with real evidence from commands actually run.

   **Use one receipt file per PR: `.proofgate/receipts/<task_id>.json`** (e.g. `.proofgate/receipts/ISSUE-142.json`). Because each PR writes a *different* filename, many PRs can be open at once without ever conflicting on the receipt — essential for autonomous / parallel agent work. The gate auto-discovers the receipt added in the PR's diff. The legacy single-file `.proofgate/receipt.json` still works for one-PR-at-a-time repos.

## CLI

```bash
proofgate stamp    # fill diff_sha256 + changed_files from the real diff (do this before committing)
proofgate check    # local pre-flight: shape + diff_sha256, prints the would-be capsule — no push needed
proofgate shape    # deterministic checks only — fast, no API key needed
proofgate review   # shape + semantic review, prints JSON verdict
proofgate run      # CI mode: shape + review + posts/updates the PR comment
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

## The receipt

The contract an agent must satisfy (`templates/receipt.example.json`):

| Field | Meaning |
|---|---|
| `intent` | What this change is for, in plain language (min 40 chars — no "fix stuff") |
| `policy_refs` | Which mission/policy docs the agent read |
| `validation_plan` | Commands + *why each one covers the change* + required flag |
| `execution_evidence` | What actually ran, status, output reference |
| `changed_files` | Must account for the real diff — undeclared changes fail the gate |
| `diff_sha256` | sha256 of `git diff <base>...HEAD -- . ':(exclude).proofgate/receipt.json' ':(exclude).proofgate/receipts/*.json'` — **3-dot (merge-base), over the committed HEAD** (not `--cached`, not the working tree), receipts excluded. Binds the receipt to the diff so receipts can't be recycled. `<base>` is auto-detected (your default branch) — `origin/main` *or* `origin/master`. **Always run `proofgate stamp` rather than hand-computing** (`git diff --cached` / 2-dot give a different hash). Excluding the receipt makes it computable before the commit (a commit can't contain its own SHA); a content hash also survives GitHub's merge-ref checkout where a head SHA cannot. |
| `self_modifying` | True if protected surfaces are touched; removes any auto-approve path |
| `result_summary` | What a human should know before merging |

## Design rules inherited from AMOS

- **Self-modifying work has no override path.** Changes to auth, payments, migrations, the gate itself — whatever you mark protected — always require a human, regardless of how good the review looks.
- **Low confidence never auto-approves.** Verdicts below `min_review_confidence` are downgraded to escalate.
- **Failure capsules, not log dumps.** A revise verdict includes the failing check, suspected cause, implicated files, and a single concrete next action — structured to be fed straight back to the agent.
- **The gate protects itself.** `.proofgate/**` and your workflows belong in `protected_paths`.

## Running agents at scale

proofgate is the *gate*; pair it with an issue-tracker queue + an executor and you have
an autonomous delivery loop. See **[docs/AGENTS_ON_A_MISSION.md](docs/AGENTS_ON_A_MISSION.md)** —
a harness-agnostic pattern: queue in your issue tracker (a human-applied `agent-ready`
label), progress in a checkpoint file, discipline in hooks, judgment in this gate. Two
human checkpoints (apply `agent-ready` on intake; `self_modifying`/escalate on output)
let the middle run unattended.

## Operating notes (learned in production)

- **One receipt file per PR** (`.proofgate/receipts/<task_id>.json`) — many PRs open at
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
