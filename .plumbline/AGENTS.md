# plumbline — agent guide

This repo is gated by **plumbline**: every PR must ship a **proof receipt** that
declares what the change is, how it was validated, and a hash binding it to the
diff. The gate (a GitHub Action) checks the receipt's *shape* + *diff binding*
deterministically, then runs a semantic review. **A PR without a passing receipt
does not merge.** This file tells an AI agent exactly how to satisfy it — and
which steps need the human.

## TL;DR for the agent

```bash
plumb receipt --write        # ONE idempotent step: scaffolds .plumbline/receipts/<branch>.json
                             # if absent, else refreshes diff_sha256 + changed_files from the
                             # real diff. Run it again after any edit or rebase.
# …edit the receipt's judgment fields: intent, validation_plan, execution_evidence, result_summary…
plumb receipt --write        # re-run to re-stamp the mechanical fields after your edits
plumb check                  # local pre-flight: shape + diff_sha256 — MUST pass before you push
git add .plumbline && git commit && git push
```

`plumb receipt --write` is the one step you need — it scaffolds a receipt on
first run and only ever touches the mechanical fields (diff hash, file list,
self_modifying) on later runs, never your judgment fields. Run `plumb check`
until it prints **PASS**: it runs the *same* shape + diff checks the CI gate
runs (one shared implementation — no local/CI drift), so a green pre-flight
means the gate's shape stage will pass, no red-CI round-trips. `plumb check`
finds your receipt even before you `git add` it. (Semantic review still runs
server-side in CI.)

## Agent steps (no human needed)

1. **`plumb receipt --write`** — the one idempotent authoring step. On first run
   it scaffolds `.plumbline/receipts/<task_id>.json` (one file per PR, keyed off
   your branch, so concurrent PRs never collide) with placeholders and the
   current `diff_sha256` + `changed_files`. On every later run it refreshes ONLY
   those mechanical fields (+ `self_modifying`), never your judgment fields.
   (The low-level `plumb new` / `plumb stamp` still exist but `receipt --write`
   supersedes them — you don't need them.)
2. **Fill the receipt** (see field guide below). Be truthful — the semantic
   review compares `intent`/`result_summary` against the actual diff.
3. **`plumb receipt --write`** again after your edits or a rebase — regenerates
   `diff_sha256` + `changed_files` so they match HEAD (the most common failure
   is a stale hash; never hand-edit these).
4. **`plumb check`** — fix anything it flags, repeat until PASS, then push. It
   discovers your receipt even before `git add` (#49).

### Receipt field guide
- `task_id` — ticket/issue/branch id (also the receipt filename).
- `agent_id` — which agent/human did the work.
- `intent` — ≥40 chars, plain language: what + why. The review reads this.
- `self_modifying` — **`true` if the diff touches plumbline's own config or
  guardrails** (`.plumbline/**`, `.github/workflows/**`, or whatever the repo's
  `protected_paths` lists). Touching a protected path with `self_modifying:false`
  is a hard fail. When `true`, the gate will **not auto-approve** — a human must
  approve before merge. It does **not** skip your rework phase: if a protected-path
  PR has agent-fixable defects, you still get REWORK first and fix them; it routes
  to REVIEW (human) only once there's nothing left for you to fix.
- `validation_plan` — the checks you intend to run; each is
  `{ command, reason, required }` where **`required` is a boolean** (`true`/`false`).
- `execution_evidence` — the checks you actually ran; each is
  `{ command, status, output_ref?, skip_reason? }`. **`status` is one of
  `passed` | `failed` | `skipped`** — it is an enum, NOT free text (values like
  `deferred-to-ci` / `pending-human` / `required-check` are rejected). Required
  steps must be `passed`; when `skipped`, include a `skip_reason`.
- `changed_files` / `diff_sha256` — set by `stamp`; don't edit by hand.
- `result_summary` — ≥40 chars: what changed + how it was verified.

### Receipt authoring: don't fight the gate on CI bookkeeping
Two habits cause almost every *false* shape REWORK — avoid both:

1. **Don't list CI-run checks as required manual-evidence steps.** Checks that
   only run in CI (Lint, Unit, Integration — anything you can't run in your
   sandbox) are already corroborated by the gate's **`ci-evidence`** check,
   which reads the PR's *real* CI run. So:
   - Keep `validation_plan` to steps you can actually run **locally** (unit
     tests, a lint you can invoke, a build). Give those `execution_evidence`
     with `status: "passed"`.
   - For a CI-only check, either **omit it** from the plan (ci-evidence covers
     it) or, if you want it recorded, mark the step `"ci_covered": true` (or
     name it exactly as a policy `ci_evidence_checks` entry). A CI-covered step
     may be `"skipped"` — the gate will **not** demand self-reported evidence
     for it. Do **not** add a step like `"CI: Lint & Unit + Integration"` as
     `required` and then mark it `skipped` expecting a pass — for a plain step
     that's a hard fail; make it CI-covered instead.
2. **Match evidence to the step, not to a byte-identical string.** Evidence is
   matched to its plan step by **`id`** first (set `"id"` on the step and
   `"step": "<id>"` on the evidence), then by command with **whitespace
   normalized** and a trailing `(note)`/`# note` allowed. A trivial spacing or
   wording diff no longer reads as "no evidence" — and if the command still
   diverges, `plumb check` names the exact mismatch (`evidence command does not
   match validation_plan step <id>: plan="…" evidence="…"`) so the fix is obvious.

**Don't memorize this — run `plumb schema`** to print every field with its
type, required/optional, and allowed enum values. A scaffolded receipt also
carries an inline `_help` block listing the same (safe to leave or delete — the
gate ignores unknown keys). And a failed `plumb check` names the allowed set
for any bad value, e.g. `execution_evidence.0.status must be one of: passed |
failed | skipped (got "deferred-to-ci")`.

### How `diff_sha256` is computed (so it always matches CI)
`plumb receipt --write`, `plumb check`, and the CI gate all run the **identical**
command — sha256 of:

```
git diff <base>...HEAD -- . ":(exclude).plumbline/receipt.json" ":(exclude).plumbline/receipts/*.json"
```

Four things that bite if you hand-roll the hash instead of using `stamp`:
- **3-dot, not 2-dot** — `<base>...HEAD` diffs `merge-base(<base>,HEAD)..HEAD`.
  Commits added to `<base>` *after* you branched are NOT included. `git diff
  <base>..HEAD` (2-dot) yields a different hash.
- **Committed HEAD, not the working tree** — NOT `--cached`, NOT staged, NOT the
  index. Commit first; the hash binds what you committed. (`plumb check`
  warns when you have uncommitted changes.)
- **Receipts are excluded** — both `.plumbline/receipt.json` and
  `.plumbline/receipts/*.json` are stripped (a commit can't contain its own hash).
- **`<base>` is auto-detected** — your repo's default branch (`origin/main` *or*
  `origin/master`, resolved from `origin/HEAD`). **No `--base` needed** for
  standard repos (this is why `main`-vs-`master` no longer trips setup); in CI
  it's the PR's base branch. Pass `--base <ref>` only to override.

**Don't hand-compute it — run `plumb receipt --write`** (it runs exactly the above). If
you must verify by hand, use that exact command, on a committed HEAD.

### How the gate picks your receipt
The gate scans `.plumbline/receipts/*.json`, then selects the one whose
`diff_sha256` matches the PR's actual diff (tie-broken by `task_id`/branch). So
every PR adds its **own** file — no shared file, no overwrite, no conflict. That
is why the binding diff *excludes* the receipts directory.

### Gotchas
- One receipt per PR at `.plumbline/receipts/<task_id>.json`. If a merge re-adds
  an old branch's receipt, the gate disambiguates by branch/diff-hash — but keep
  your diff to a single intended receipt.
- A no-op or wrong `diff_sha256` is the #1 false failure — always finish with
  `plumb receipt --write` then `plumb check`.

## Reading the gate's verdict (what to do with each)

The verdict tells you **whose turn it is** — nothing else. It is derived from the
review's findings; act on it literally:

- **APPROVE** ✅ — no blocking findings. The PR merges automatically. Nothing to do.
- **REWORK** 🔁 — *your turn.* The comment lists **🤖 Agent can do now** items — each
  is a concrete defect (failed/missing validation, a bug, a security regression,
  receipt≠diff, an untested critical path). **Fix every listed item, re-run
  `plumb receipt --write`, and re-push.** A REWORK self-clears once the agent set is
  empty — even on a protected path (the floor blocks only auto-APPROVE, not your
  rework). By construction a REWORK comment contains **no** 🧑 human items.
- **REVIEW** ⚠️ — *the human's turn, not yours.* By construction a REVIEW contains
  **zero 🤖 items** — there is nothing for you to fix. It lists **🧑 Human must
  decide** items (a protected-surface/billing override, a real trade-off, or
  irreducibly ambiguous intent). **Do NOT loop trying to satisfy a REVIEW** — do
  not invent code changes to clear it. Relay it to the user and stop; a maintainer
  decides and override-merges.
- **💡 Advisory** — non-blocking notes ("consider…", style, nice-to-haves). These
  **never block** and never change the verdict. Address them if cheap, or leave them;
  either way they do not hold up the merge and are not rework.

**Re-review is convergent.** On a re-push the gate verifies your fixes and reviews only
the changed hunks for regressions — it won't re-litigate code it already passed, so you
won't chase a growing nitpick list. After 2 rework rounds a **convergence cap** engages:
only regressions in your fixes can still block; everything else escalates to a REVIEW
(human decides) rather than looping you again. If you see "gate did not converge," stop
reworking and relay to the user.

## Human-only steps (agent: relay these to the user)

These need repo-admin rights an agent doesn't have. Ask the user to do them once:

1. **Enable the gate as a required check** (so unproven PRs can't merge):
   GitHub → repo **Settings → Branches → Branch protection rules** → add/edit a
   rule for the default branch → check **"Require status checks to pass before
   merging"** → search for and select **`plumbline`** (it appears after the
   workflow runs once).
2. **Add the review API key secret** (semantic review needs it):
   GitHub → **Settings → Secrets and variables → Actions → New repository
   secret** → name **`ANTHROPIC_API_KEY`**, paste the key. (`GITHUB_TOKEN` is
   provided automatically.) **This is required:** the gate **fails closed** —
   with no key the verdict is `review` (a BLOCK), never a shape-only pass —
   because `require_semantic_review` defaults to `true`. Only a deliberately
   offline/self-hosted repo sets `require_semantic_review: false` in
   `policy.json`, which lets the shape gate PASS but states loudly, on the
   verdict and PR comment, that the semantic review did not run.
3. **First run:** open any PR; the `plumbline` check runs and becomes selectable
   in step 1.

That's it — once those are set, the loop is fully agent-driven:
`receipt --write` → fill the judgment fields → `receipt --write` → `check` → push.
