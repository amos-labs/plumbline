# proofgate

**A proof-carrying gate for AI agent work.** Agent PRs ship with a structured receipt; a deterministic shape check and an LLM semantic review judge the work against your repository's mission before a human ever reads the diff. Failed reviews produce a structured *failure capsule* the agent can use as its rework prompt.

Extracted from the [AMOS](https://github.com/amos-labs) proof-carrying autonomous loop. Apache 2.0.

## The problem

AI agents multiply your velocity until the codebase quietly diverges from your intent — every PR looks fine, the project drifts. Reviewing everything yourself caps velocity at your reading speed. Trusting the agent loses the project over time. proofgate is the missing middle: **legibility as the control surface.** Work carries proof; humans review exceptions.

## How it works

```text
agent does work
  -> emits .proofgate/receipt.json   (intent, validation plan, evidence, changed files, self_modifying flag)
  -> shape gate                       deterministic: schema, evidence coverage, protected paths, SHA/diff integrity
  -> semantic review                  one LLM call vs your MISSION.md: coverage, alignment, risk
  -> verdict
       approve   -> CI check green, human merges at leisure
       revise    -> failure capsule posted; agent reworks and resubmits
       escalate  -> human must decide (always the case for self-modifying work)
```

Two-tier validation, on purpose: the shape gate never pretends to understand meaning, and the reviewer never re-does deterministic checks.

## Quick start

1. **Write your constitution.** Copy `templates/MISSION.md` to `.proofgate/MISSION.md` and fill it in. This is the highest-leverage hour you'll spend: state what the project is for, the invariants no change may weaken, and which surfaces are protected.

2. **Add the policy.** Copy `templates/policy.json` to `.proofgate/policy.json`. Set `required_checks` (commands every validation plan must include, e.g. your test suite) and `protected_paths` (globs that force `self_modifying: true` and human review).

3. **Add the CI hook.**
   - **GitHub:** copy `templates/workflow.yml` to `.github/workflows/proofgate.yml`, add `ANTHROPIC_API_KEY` to repo secrets, make the check required in branch protection.
   - **Azure DevOps:** copy `templates/azure-pipelines.yml`, add `ANTHROPIC_API_KEY` as a secret variable, grant the build service "Contribute to pull requests", and add the pipeline as a required build validation policy. The gate posts/updates a PR thread (active on revise/escalate, resolved on approve).

4. **Teach your agent the contract.** Add to your `CLAUDE.md` / agent instructions: every PR must include `.proofgate/receipt.json` conforming to `templates/receipt.example.json`, with real evidence from commands actually run.

## CLI

```bash
proofgate shape    # deterministic checks only — fast, no API key needed
proofgate review   # shape + semantic review, prints JSON verdict
proofgate run      # CI mode: shape + review + posts/updates the PR comment
```

Common flags: `--receipt <path>` `--policy <path>` `--base <ref>` `--mission <path>` `--no-git` (fixture testing).

Exit code is the gate: `0` only on approve.

## The receipt

The contract an agent must satisfy (`templates/receipt.example.json`):

| Field | Meaning |
|---|---|
| `intent` | What this change is for, in plain language (min 40 chars — no "fix stuff") |
| `policy_refs` | Which mission/policy docs the agent read |
| `validation_plan` | Commands + *why each one covers the change* + required flag |
| `execution_evidence` | What actually ran, status, output reference |
| `changed_files` | Must account for the real diff — undeclared changes fail the gate |
| `head_sha` | Must match the PR head — receipts can't be recycled |
| `self_modifying` | True if protected surfaces are touched; removes any auto-approve path |
| `result_summary` | What a human should know before merging |

## Design rules inherited from AMOS

- **Self-modifying work has no override path.** Changes to auth, payments, migrations, the gate itself — whatever you mark protected — always require a human, regardless of how good the review looks.
- **Low confidence never auto-approves.** Verdicts below `min_review_confidence` are downgraded to escalate.
- **Failure capsules, not log dumps.** A revise verdict includes the failing check, suspected cause, implicated files, and a single concrete next action — structured to be fed straight back to the agent.
- **The gate protects itself.** `.proofgate/**` and your workflows belong in `protected_paths`.

## Status

v0. Single-repo, GitHub Actions + Anthropic API. Planned: drift monitoring (scheduled job sampling merged work against the mission), provider abstraction (Bedrock), check-runs API instead of comments, receipt signing.
