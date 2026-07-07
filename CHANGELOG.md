# Changelog

All notable changes to Plumbline are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Consumers should pin a released tag (e.g. `amos-labs/plumbline@v1`) rather than
`@master` — see [Pinning a version](README.md#pinning-a-version) in the README.

## [Unreleased]

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

[Unreleased]: https://github.com/amos-labs/plumbline/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/amos-labs/plumbline/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/amos-labs/plumbline/releases/tag/v0.1.0
