# Changelog

All notable changes to Plumbline are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Consumers should pin a released tag (e.g. `amos-labs/plumbline@v1`) rather than
`@master` — see [Pinning a version](README.md#pinning-a-version) in the README.

## [Unreleased]

## [0.5.0] - 2026-07-16

Gate-trust: make the three verdicts unmistakable end-to-end, tighten REWORK vs
REVIEW routing, and stop losing good-but-optional findings. Folds #55 (local
shape parity #53 + unambiguous REWORK vs REVIEW #54) and #57 (verdict
classification #56 + `check` first-run ergonomics #49 + doc refresh #48).

### Added
- **Distinct per-verdict surfaces (#54).** A single verdict-presentation table
  (`src/verdict.ts`) is now the sole source of how every surface renders a
  verdict, so REWORK and REVIEW can never again collapse into one identical red
  "failure" check. The CI gate publishes a **per-verdict check-run** with a
  distinct NAME and CONCLUSION:
  - `Plumbline: PASS` — `success`
  - `Plumbline: REWORK — blocked, do not merge` — `failure` (agent's turn)
  - `Plumbline: REVIEW — awaiting human approval` — `action_required` (human's
    turn; renders distinctly from a plain failure in the PR UI)

  The PR-comment title and the Checks-tab annotation are derived from the same
  table. Motivated by amos-platform#211, where a REWORK was merged by accident
  because it looked identical to a REVIEW.
- **Materiality axis + 3-way classification (#56).** Findings gain a
  `material / optional / noise` axis on top of `class` + `actor`. Routing is now
  deterministic and sequential: any **material, agent-fixable** finding ⇒
  **REWORK** (even on a protected / `self_modifying` surface); **REVIEW** is
  emitted only when no agent-fixable items remain (a pure human decision list);
  **noise** is dropped.
- **Optional-but-good findings become tracked follow-up issues (#56).**
  Optional findings are no longer silently skipped as advisory notes — the gate
  **files a deduped follow-up GitHub issue** for each (deduplicated by a stable
  per-finding fingerprint via issue search). Best-effort: filing never throws,
  so a repo without `issues: write` degrades gracefully rather than failing the
  gate. Requires `issues: write` (and `checks: write` for the per-verdict
  check-run) on the gate job.
- **`plumb check` finds an untracked receipt (#49).** Local pre-flight
  auto-discovery now consults `git status --porcelain`, so `plumb check` works
  before `git add`. LOCAL only — CI stays diff-based.

### Changed
- **Doc refresh (#48).** README Status updated to the v0.4.x/v0.5 shape; both
  AGENTS.md TL;DRs rewritten around the single idempotent `receipt --write` step.

### Compatibility
- **Back-compatible for consumers.** The new check-runs and follow-up-issue
  filing require `checks: write` / `issues: write` on the gate job; without them
  the gate degrades gracefully (no per-verdict check-run / no follow-up issues)
  rather than failing. No receipt-schema or gate exit-code change.

## [0.4.0] - 2026-07-13

### Added
- **`base_sha` receipt field — the diff base is now PINNED, killing the
  recurring `diff_sha256` staleness REWORKs.** The binding hash is
  `sha256(git diff <base>...HEAD)`, a 3-dot diff whose base is the *merge-base*
  of the branch and `origin/main`. In a high-merge-velocity repo that merge-base
  **drifts**: an agent stamps against a slightly stale local `origin/main` while
  the gate fetches a fresher one → a different merge-base → a different hash →
  a **spurious REWORK on a content-clean PR.** The fix: `plumb receipt --write`
  (and `stamp` / `new`) now record `base_sha` = the exact merge-base commit and
  compute `diff_sha256` as the **2-dot** `git diff <base_sha>..HEAD` (byte-for-byte
  identical to the old 3-dot, but deterministic — it names the base commit
  instead of re-deriving it). The gate verifies against that pinned commit and
  does **not** re-derive the base from the live `origin/main`, so concurrent
  merges / a stale local main / the synthetic GitHub merge-ref checkout can no
  longer move the hash.

### Security
- **Pinned-base ancestry backstop.** The gate asserts `base_sha` is a real
  ancestor of the default branch (`git merge-base --is-ancestor`). A forged or
  unrelated-history base — which could otherwise hide changes by diffing against
  the wrong commit — is **rejected**. The receipt still attests the branch's true
  diff off a legitimate fork point.

### Compatibility
- **Fully back-compatible.** A receipt *without* `base_sha` (old-format receipts,
  consumers still on `@v0.3.0`) verifies via the original `origin/main`-derived
  3-dot path — nothing breaks during rollout. `base_sha` is optional in the
  schema. Consumer repos can re-pin to `@v0.4.0` at their own pace.

## [0.3.0] - 2026-07-10

### ⚠️ BREAKING
- **The gate now fails CLOSED when the semantic review is required but can't run
  (trust-integrity).** Previously, if the review provider was absent or
  unreachable (no API key, provider/API error, timeout) the gate could fall back
  to the deterministic shape checks alone and still PASS. A proof-carrying trust
  gate that fails *open* is a bug in the thesis. Now, when the semantic review is
  required and cannot run, the verdict is a **BLOCK** (`review`) with a loud
  *"semantic review unavailable — failing closed"* capsule — never a silent
  shape-only pass. Governed by the new `require_semantic_review` policy flag,
  which **defaults to `true`.**

  **Why this is BREAKING:** any repo that was (perhaps unknowingly) relying on
  the old shape-only fallback with **no provider key configured** will now see
  the `plumbline` check go **red (BLOCK)** instead of passing. Repos that already
  provide a provider key (`ANTHROPIC_API_KEY` / `PLUMBLINE_API_KEY`) are
  unaffected — the review runs exactly as before.

  **Migration.** Either (a) add a provider key (recommended — you get the
  semantic half of the gate you were missing), or (b) for a **deliberately
  offline / self-hosted / air-gapped** repo, set
  `"require_semantic_review": false` in `policy.json` — the shape gate may then
  PASS, but the verdict and PR comment state *loudly* that the semantic review
  did not run (never a silent pass). This is exactly why consumers should pin a
  released tag, not `@master`: a breaking change like this arrives as a
  deliberate, CHANGELOG-noted upgrade rather than shifting under a floating ref.

### Added
- **`require_semantic_review` policy flag** (default `true`) — the fail-closed
  switch above. See "How it works" and the cost-controls section in the README.
  Enforced at both unavailability points (provider construction with no key, and
  a runtime provider-call failure — API error / network / timeout), via a single
  shared `resolveUnavailableVerdict` decision so the two paths cannot drift.
- **README honesty note on what "proof" means.** "Proof-carrying" here =
  diff-binding (`diff_sha256`) + CI evidence corroboration + a *probabilistic*
  semantic review, gated on that review actually having run — **not** a
  cryptographic attestation of the agent's work. Receipt signing is planned, not
  shipped; the README keeps that distinction explicit.

## [0.2.3] - 2026-07-09

### Changed
- **Marketplace listing metadata (`action.yml`).** `name` → `Plumbline Gate`
  (the bare "Plumbline" is taken on the Marketplace) and `description` shortened
  to under GitHub's 125-char listing limit. No behavior change.


## [0.2.2] - 2026-07-09

### Changed
- **Launch polish for the GitHub Marketplace (#43).** Marketplace metadata
  (`action.yml` name → `Plumbline`, branding `target`/`blue`), a "Why Plumbline"
  section, the brand kit under `assets/`, a sample failure-capsule in the README,
  and a documented backward-compatibility note for the retained `proofgate`
  aliases (`.proofgate/` dirs, `PROOFGATE_*` env vars, the `proofgate` CLI alias).

- **Turn-based verdicts — the verdict now encodes whose turn it is, exclusively (#41).**
  The verdict is derived mechanically from classified findings, not taken from the model.
  ANY blocking + agent-fixable finding ⇒ **REWORK** (the agent's turn), *even on a
  protected / `self_modifying` path* — the protected floor only forbids auto-APPROVE, it
  no longer skips the agent iteration phase. **REVIEW** is emitted only when the
  blocking + agent set is empty, so a REVIEW is by construction a pure human decision list
  with **zero 🤖 items**. Replaces the old "worst-trigger" behavior where a REVIEW could
  still hand the agent homework.

### Added
- **Blocking vs advisory findings (#41).** Findings are classified on two axes:
  `class` (`blocking` = a defect that gates, `advisory` = a "consider…"/style/nice-to-have)
  and `actor` (`agent` / `human`). Only blocking findings affect the verdict; advisory
  notes render in their own 💡 section, are recorded in the capsule, and never block a merge.
- **Convergent (delta) re-review with a round cap (#41).** On re-review the prompt receives
  the prior capsule + the fix commits and reviews ONLY the new/changed hunks for regressions
  — it must not raise fresh findings on unchanged code it already reviewed. After 2 rework
  rounds a convergence cap engages: only regressions in the fix commits may block; anything
  else escalates to REVIEW under a "gate did not converge — human decides" banner, so the
  loop is always bounded (no unbounded nitpick loops).
- **`plumb check` no longer prints a bare gate verdict.** The local pre-flight
  runs only the shape floor + `diff_sha256` (the LLM semantic review runs in CI),
  so it now prints a scoped `shape pre-flight: PASS/FAIL` banner instead of
  `APPROVE`/`REVIEW`/`REWORK` — a shape-PASS locally can still be `REVIEW`/`REWORK`
  in CI, and the banner says so. (#39)

### Added
- **`plumb check --review`** — full local parity: runs the semantic review too and
  prints the real verdict (same code path as the CI gate). Requires a provider key
  (`ANTHROPIC_API_KEY` / `PLUMBLINE_API_KEY`); with no key it degrades to the
  shape-only pre-flight and says so explicitly (never claims a verdict it didn't
  compute). (#39)

## [0.2.1] - 2026-07-08

### Security / Hardening
- **`setup-protection` no longer clobbers existing branch protection.** It now
  GETs the current protection first and PRESERVES existing
  `required_pull_request_reviews` (required reviewers, code-owner review) and
  `restrictions` (push allow-lists) — it only ever ADDS the required status
  checks + enables auto-merge, and never nulls those settings. If it can't read
  the current protection (so preserving isn't possible), it refuses to write
  unless `--force` is passed. CLI help + AGENTS.md document exactly what changes.
- **OpenAI-compatible provider never falls back to `ANTHROPIC_API_KEY`.**
  Sending an Anthropic key to a third-party/self-hosted OpenAI endpoint would
  leak that credential; the provider now requires an explicit
  `PLUMBLINE_API_KEY` (or `PROOFGATE_API_KEY`) and errors clearly when missing.
- **Temperature is omitted by default** (was always sent as `0`). Some Anthropic
  models reject an explicit `temperature`; the gate now sends none unless
  `review_temperature` (policy) or `PLUMBLINE_TEMPERATURE` (env) is set —
  keeping determinism where the model supports it without breaking those models.
- **Redundant protected-path / `self_modifying` floor before auto-approve.** The
  CLI re-checks the floor (from the ACTUAL diff, not just the receipt's
  self-report) on the review-skip path, so a bug in `shouldSkipReview` can never
  auto-approve a protected change.
- **Cache verdicts are validated against the real diff.** Before serving a
  cached verdict, the CLI recomputes the diff hash and confirms it matches
  `receipt.diff_sha256`; a mismatch is a cache miss (live review) — so a
  stale/wrong hash can't serve a mismatched cached verdict.
- **Robust poll-wait self-detection** in the scaffolded workflow. Self is now
  identified by this workflow run's id (embedded in the check-run's
  `details_url`), not a name substring — surviving a job rename and never
  self-waiting to timeout when another check merely contains "plumbline".

### Added
- **Provider abstraction for the semantic review (#25).** The review LLM call is
  now behind a small `ReviewProvider` interface. Anthropic stays the default with
  its env unchanged (`ANTHROPIC_API_KEY`, `PLUMBLINE_MODEL`/`PROOFGATE_MODEL`); any
  OpenAI-compatible endpoint (OpenAI, Azure OpenAI, Together, Groq, vLLM, Ollama,
  self-hosted, …) is selectable via `PLUMBLINE_PROVIDER=openai` + `PLUMBLINE_API_BASE`
  + `PLUMBLINE_API_KEY`, or `policy.review_provider` / `policy.review_api_base`. The
  prompt and the `approve`/`rework`/`review` verdict schema are provider-independent.
- **LLM cost + determinism controls (#26), all opt-in — defaults preserve today's
  behavior (review always runs).**
  - `skip_review` — pass docs-only / config-only / below-size-threshold diffs on the
    shape gate alone. **Hard floor:** `self_modifying` / `protected_paths` changes are
    never skipped.
  - `review_cache` — reuse a prior verdict for an identical diff (keyed by
    `diff_sha256`, scoped to provider + model + prompt version).
  - `budget` — optional cheaper-model tier (`use_cheap_model` / `cheap_model`) and an
    informational per-PR spend cap (`max_usd_per_pr`).
  - Determinism: `review_temperature` is optional (see Security / Hardening — now
    omitted by default rather than pinned to `0`); the verdict records `audit`
    metadata (provider, model, prompt version, temperature, cache hit) for
    reproducibility.
- **Batteries-included `plumb init` + `plumb setup-protection`** (#22) — two-layer,
  correct-by-default governed-CI setup so a new repo can't land the subtly-wrong
  configurations that silently defeat the gate.
  - **Language-agnostic core:** the scaffolded gate workflow now ships WITH the
    **ci-evidence poll-wait** wired (waits for the repo's CI check-runs to reach a
    terminal conclusion before the gate evaluates, so it never races CI; timeout via
    the `PLUMBLINE_POLL_TIMEOUT_SECONDS` repo/org variable, default 900s). AGENTS.md
    gains the database-migration conventions (never edit an applied migration,
    full-timestamp versions, the guard rejects a version ≤ base max).
  - **`plumb setup-protection --repo owner/name`** (and `plumb init --protect`) —
    via the GitHub API, makes the `plumbline` gate + the repo's CI checks REQUIRED on
    the default branch (`strict:false`) and enables auto-merge — the "blocking +
    auto-merge on all green" shape. Idempotent; prints what it changed; needs a
    repo-admin token.
  - **Stack presets** (auto-detected or `--stack`; `--no-stack` to skip). **`rust-sqlx`**
    (Cargo.toml + `migrations/` + sqlx): scaffolds a migration-version-collision guard
    (`plumb migration-guard`), rust-cache + parallelized (no `needs:` chain) test jobs,
    the policy's `ci_evidence_checks` pre-bound to those jobs, and — if a Dockerfile is
    present — a cargo-chef layering + `cache-to mode=max` hint. Everything is an
    overridable plain file.

## [0.2.0] - 2026-07-07

First tagged release with a changelog and a release process. No behavioral change
from the code merged after `v0` — this release exists so consumers can pin a real
version and pick up the accumulated wording and ergonomics changes deliberately,
instead of floating on `@master` or being stuck behind the `v0` tag.

Everything below is the state of the gate as of this release. It is grouped by area
rather than by the commit that introduced it, because `v0` was the only prior tag.

### Added
- **`propose` intake.** Scaffolds a GitHub issue and an OpenSpec-compatible
  `openspec/changes/<slug>/` contract (proposal + specs + tasks), born linked: the
  issue number is written into the proposal's `task_id` front-matter and the issue
  body carries the contract path. `--lite` opens a plain issue with no contract folder.
- **`receipt --write` / `receipt --check`.** One idempotent command computes all
  mechanical receipt fields — `diff_sha256`, `changed_files`, and `self_modifying`
  (derived from the policy's `protected_paths`) — and refreshes them after rebases
  while preserving author-written judgment fields. `receipt --check` exits non-zero
  when the mechanical half is stale (small enough for a pre-push hook).
- **`archive`.** Applies a change's ADDED/MODIFIED/REMOVED spec deltas to
  `openspec/specs/` and moves the change to `openspec/changes/archive/`. Refuses
  unless the change's receipt passes the gate (`--force` overrides, loudly).
- **Per-PR receipts.** Receipts live at `.plumbline/receipts/<task_id>.json`, one file
  per PR, so parallel/autonomous agents never conflict on a shared `receipt.json`. The
  gate auto-discovers the receipt added in the PR's diff.
- **Evidence integrity (`ci_evidence_checks`).** The gate corroborates a receipt's
  claimed execution evidence against the real conclusion of the named CI check-runs,
  so a receipt can't assert a green test suite the CI never ran. Includes a poll-wait
  so the gate waits for the corroborating check to finish before reading it.
- **Attempt history.** Reruns archive prior verdicts (newest first, capped at 5) in a
  collapsed section of the single in-place PR comment, so a multi-round fix keeps its
  full trajectory in one place instead of erasing it.
- **Tunable strictness.** `strictness` (`strict` / `lenient`) and per-check
  `check_severity` in `policy.json`, with a hard floor — `schema`, `diff_integrity`,
  and `protected_paths` can never be downgraded.
- **`human_review_level` dial** (`low` / `balanced` / `high`) tunes only how
  aggressively work routes to humans; it never lowers the hard floor (protected paths
  and `self_modifying` always need a human).
- **Failure capsule split.** Every capsule separates `agent_actions` (fixes an agent
  can do now) from `human_actions` (decisions only a human can make); a `review`
  verdict still lists `agent_actions` so agent-fixable work proceeds in parallel.
- **Self-hosting.** The repo runs its own gate on every PR (`uses: ./`), so
  enforcement changes are exercised by the PR that makes them.
- **Local pre-flight** (`stamp`, `check`) — same shape + diff checks as CI, runnable
  before push.
- **Discoverable receipt schema** (`plumb schema`) and an inline `_help` block in the
  scaffolded receipt.
- **Agent-installable `init`** — scaffolds `.github/workflows`, `.plumbline/`, and an
  `AGENTS.md` that tells an AI agent exactly how to satisfy the gate.
- **Azure DevOps support** — CI adapter, PR thread comments, and a pipeline template
  alongside the GitHub Actions path.

### Changed
- **Verdict labels renamed (wording only, behavior byte-for-byte identical):**
  `ESCALATE` → `REVIEW` and `REVISE` → `REWORK`. `APPROVE` is unchanged. This is the
  change `cuspr` and other `@v0`-pinned consumers could not see without a newer tag —
  the motivating case for this release.
- **Renamed the project** proofgate → Plumbline (binary `plumb`, with `proofgate`
  retained as an alias and `.proofgate/` directories read for back-compat).
- **`diff_sha256` binding hardened** — hashes the 3-dot (merge-base) diff over the
  committed HEAD with receipt paths excluded, so it survives GitHub's merge-ref
  checkout and can't be recycled across diffs.

### Notes
- **Migration guard concept.** Migrations (and other protected surfaces) belong in
  `policy.json` `protected_paths` so any change touching them forces
  `self_modifying: true` and routes to human review with no auto-approve path. This is
  a policy convention today, documented for consumers pinning this release.

## [0.1.0]

Initial extraction from the AMOS proof-carrying autonomous loop, released under the
floating `v0` tag: proof-carrying gate for AI agent work — structured receipt, a
deterministic shape check, an LLM semantic review against the repository's mission,
and a failure-capsule rework loop. Single-repo, GitHub Actions + Anthropic API.

[Unreleased]: https://github.com/amos-labs/plumbline/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/amos-labs/plumbline/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/amos-labs/plumbline/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/amos-labs/plumbline/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/amos-labs/plumbline/compare/v0.2.3...v0.3.0
[0.2.3]: https://github.com/amos-labs/plumbline/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/amos-labs/plumbline/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/amos-labs/plumbline/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/amos-labs/plumbline/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/amos-labs/plumbline/releases/tag/v0.1.0
