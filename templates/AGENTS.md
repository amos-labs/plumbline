# proofgate — agent guide

This repo is gated by **proofgate**: every PR must ship a **proof receipt** that
declares what the change is, how it was validated, and a hash binding it to the
diff. The gate (a GitHub Action) checks the receipt's *shape* + *diff binding*
deterministically, then runs a semantic review. **A PR without a passing receipt
does not merge.** This file tells an AI agent exactly how to satisfy it — and
which steps need the human.

## TL;DR for the agent

```bash
proofgate new          # scaffold .proofgate/receipts/<branch>.json (prefilled + diff-stamped)
# …edit the receipt: intent, validation_plan, execution_evidence, result_summary…
proofgate stamp        # refresh diff_sha256 + changed_files from the real diff (after edits/rebase)
proofgate check        # local pre-flight: shape + diff_sha256 — MUST pass before you push
git add .proofgate && git commit && git push
```

Run `proofgate check` until it prints **PASS**. It runs the *same* shape + diff
checks the CI gate runs, so a green pre-flight means the gate's shape stage will
pass — no red-CI round-trips. (Semantic review still runs server-side in CI.)

## Agent steps (no human needed)

1. **`proofgate new`** — creates `.proofgate/receipts/<task_id>.json` (one file
   per PR, keyed off your branch, so concurrent PRs never collide). It prefills
   placeholders and stamps the current `diff_sha256` + `changed_files`.
2. **Fill the receipt** (see field guide below). Be truthful — the semantic
   review compares `intent`/`result_summary` against the actual diff.
3. **`proofgate stamp`** after any further edits or a rebase — regenerates
   `diff_sha256` + `changed_files` so they match HEAD (the most common failure
   is a stale hash; never hand-edit these).
4. **`proofgate check`** — fix anything it flags, repeat until PASS, then push.

### Receipt field guide
- `task_id` — ticket/issue/branch id (also the receipt filename).
- `agent_id` — which agent/human did the work.
- `intent` — ≥40 chars, plain language: what + why. The review reads this.
- `self_modifying` — **`true` if the diff touches proofgate's own config or
  guardrails** (`.proofgate/**`, `.github/workflows/**`, or whatever the repo's
  `protected_paths` lists). Touching a protected path with `self_modifying:false`
  is a hard fail. When `true`, the gate escalates to **human review** — it will
  not auto-approve.
- `validation_plan` — the checks you intend to run (command + reason + required).
- `execution_evidence` — the checks you actually ran + their result. Required
  checks must be `passed`.
- `changed_files` / `diff_sha256` — set by `stamp`; don't edit by hand.
- `result_summary` — ≥40 chars: what changed + how it was verified.

### Gotchas
- One receipt per PR at `.proofgate/receipts/<task_id>.json`. If a merge re-adds
  an old branch's receipt, the gate disambiguates by branch/diff-hash — but keep
  your diff to a single intended receipt.
- A no-op or wrong `diff_sha256` is the #1 false failure — always finish with
  `proofgate stamp` then `proofgate check`.

## Human-only steps (agent: relay these to the user)

These need repo-admin rights an agent doesn't have. Ask the user to do them once:

1. **Enable the gate as a required check** (so unproven PRs can't merge):
   GitHub → repo **Settings → Branches → Branch protection rules** → add/edit a
   rule for the default branch → check **"Require status checks to pass before
   merging"** → search for and select **`proofgate`** (it appears after the
   workflow runs once).
2. **Add the review API key secret** (semantic review needs it):
   GitHub → **Settings → Secrets and variables → Actions → New repository
   secret** → name **`ANTHROPIC_API_KEY`**, paste the key. (`GITHUB_TOKEN` is
   provided automatically.)
3. **First run:** open any PR; the `proofgate` check runs and becomes selectable
   in step 1.

That's it — once those are set, the loop is fully agent-driven: `new` → fill →
`stamp` → `check` → push.
