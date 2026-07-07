# Changelog

All notable changes to Plumbline are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Consumers should pin a released tag (e.g. `amos-labs/plumbline@v1`) rather than
`@master` — see [Pinning a version](README.md#pinning-a-version) in the README.

## [Unreleased]

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
