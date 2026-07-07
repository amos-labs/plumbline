# plumbline — agent guide

This repo is gated by **plumbline**: every PR must ship a **proof receipt** that
declares what the change is, how it was validated, and a hash binding it to the
diff. The gate (a GitHub Action) checks the receipt's *shape* + *diff binding*
deterministically, then runs a semantic review. **A PR without a passing receipt
does not merge.** This file tells an AI agent exactly how to satisfy it — and
which steps need the human.

## TL;DR for the agent

```bash
plumb new          # scaffold .plumbline/receipts/<branch>.json (prefilled + diff-stamped)
# …edit the receipt: intent, validation_plan, execution_evidence, result_summary…
plumb receipt --write        # refresh diff_sha256 + changed_files from the real diff (after edits/rebase)
plumb check        # local pre-flight: shape + diff_sha256 — MUST pass before you push
git add .plumbline && git commit && git push
```

Run `plumb check` until it prints **PASS**. It runs the *same* shape + diff
checks the CI gate runs, so a green pre-flight means the gate's shape stage will
pass — no red-CI round-trips. (Semantic review still runs server-side in CI.)

## Agent steps (no human needed)

1. **`plumb new`** — creates `.plumbline/receipts/<task_id>.json` (one file
   per PR, keyed off your branch, so concurrent PRs never collide). It prefills
   placeholders and stamps the current `diff_sha256` + `changed_files`.
2. **Fill the receipt** (see field guide below). Be truthful — the semantic
   review compares `intent`/`result_summary` against the actual diff.
3. **`plumb receipt --write`** after any further edits or a rebase — regenerates
   `diff_sha256` + `changed_files` so they match HEAD (the most common failure
   is a stale hash; never hand-edit these).
4. **`plumb check`** — fix anything it flags, repeat until PASS, then push.

### Receipt field guide
- `task_id` — ticket/issue/branch id (also the receipt filename).
- `agent_id` — which agent/human did the work.
- `intent` — ≥40 chars, plain language: what + why. The review reads this.
- `self_modifying` — **`true` if the diff touches plumbline's own config or
  guardrails** (`.plumbline/**`, `.github/workflows/**`, or whatever the repo's
  `protected_paths` lists). Touching a protected path with `self_modifying:false`
  is a hard fail. When `true`, the gate routes to **human review** — it will
  not auto-approve.
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

### Database migrations (if this repo has a `migrations/` directory)
Three rules, enforced so parallel agent branches don't corrupt the schema:

1. **Never edit an already-applied migration.** Once a migration has run
   anywhere (prod, a teammate's DB, CI), its checksum is recorded; changing the
   file makes the migrator refuse to start. Fix-forward with a NEW migration.
2. **Version migrations with a full UTC timestamp**, not a hand-picked ordinal.
   `sqlx migrate add -r <name>` does this; or `date -u +%Y%m%d%H%M%S`. Two
   branches created seconds apart then get distinct, monotonic versions — a
   short ordinal (`0007_…`) collides the moment two branches both pick it.
3. **The `migration-guard` check rejects a new migration whose version is
   `<= the base branch's max`.** A new migration must sort strictly AFTER
   everything already merged. If the guard fails, don't renumber down —
   re-stamp your migration with a fresh timestamp (rule 2) so it lands last.

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

## Human-only steps (agent: relay these to the user)

These need repo-admin rights an agent doesn't have. Ask the user to do them once:

1. **Make the gate a required, blocking check + enable auto-merge — in one command:**
   ```bash
   GITHUB_TOKEN=<admin token> plumb setup-protection --repo <owner/name>
   ```
   This makes the `plumbline` gate **and** the repo's CI checks REQUIRED on the
   default branch (strict:false) and turns on auto-merge — the "blocking +
   auto-merge on all green" shape. It's idempotent and prints exactly what it
   changed. Needs a token with repo-admin scope. (The manual path is GitHub →
   **Settings → Branches → Branch protection rules** → require `plumbline`; but
   the command gets the shape right every time, which hand-setup reliably does not.)
2. **Add the review API key secret** (semantic review needs it):
   GitHub → **Settings → Secrets and variables → Actions → New repository
   secret** → name **`ANTHROPIC_API_KEY`**, paste the key. (`GITHUB_TOKEN` is
   provided automatically.)
3. **First run:** open any PR; the `plumbline` check runs (and becomes selectable
   as a required check if you set protection manually).

That's it — once those are set, the loop is fully agent-driven: `new` → fill →
`stamp` → `check` → push.
