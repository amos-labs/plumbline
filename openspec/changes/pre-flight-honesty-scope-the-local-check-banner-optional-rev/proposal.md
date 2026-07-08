---
title: Pre-flight honesty: scope the local check banner + optional --review full-parity mode
task_id: "39"
status: proposed
---

# Pre-flight honesty: scope the local check banner + optional --review full-parity mode

**Observed:** local `plumb check` prints a full `✅ plumbline: APPROVE` banner — visually identical to the final CI verdict — but it only ran the **shape floor + diff_sha256**. The **LLM semantic review runs only in CI**, so a dev can get local-APPROVE then CI-REVIEW/REWORK (happened live on the v0.2.1 release PR #38: local APPROVE → CI REVIEW on changelog-date/CI-corroboration). The behavior is correct (no API key/cost/latency on every local check); the **label is the bug** — it reads as "less stringent but claiming the same verdict."

## Fix 1 — scope the pre-flight banner (the honesty fix)
`plumb check` must NOT print a bare `APPROVE`/`REVIEW`/`REWORK`. Reserve those for the actual gate verdict (shape + semantic). Local pre-flight prints something scoped, e.g.:
- `✅ shape pre-flight: PASS — semantic review still runs in CI`
- `❌ shape pre-flight: FAIL — <capsule>` (unchanged behavior, just not called APPROVE)

Only the shape dimension is asserted locally; the banner should say so.

## Fix 2 — optional `plumb check --review` (full-parity local mode)
Add an opt-in flag so devs who want the real verdict before pushing can run the semantic layer locally:
- `plumb check --review` → runs shape floor **and** the LLM semantic review (same code path as CI `plumb run`), printing the real APPROVE/REVIEW/REWORK verdict.
- Requires an API key in env (`ANTHROPIC_API_KEY`/`PLUMBLINE_API_KEY`); if absent, print a clear note that it falls back to shape-only pre-flight (never silently skip and still claim a verdict).
- Reuse the existing `plumb review` path; `--review` just composes shape + review locally so there's a single command for full local parity.

## Acceptance
- Local `plumb check` (no flag) never emits a bare gate verdict word; it names the shape-only scope + that semantic review runs in CI.
- `plumb check --review` with a key produces the same verdict CI would (shape + semantic); without a key it degrades to shape-only with an explicit note.
- Tests cover: banner wording for pass/fail, `--review` verdict parity vs `plumb run`, and the no-key degrade path.
- Docs (README + `plumb --help`) state clearly that default `check` is shape-only and `--review` is full parity.

## Why

The local pre-flight and the CI gate check *different things* — pre-flight runs the shape floor only, the LLM semantic review runs only in CI — but they printed the *same* `plumbline: APPROVE` banner. That equivalence is a lie: a shape-PASS locally routinely becomes `REVIEW`/`REWORK` in CI (it did on the v0.2.1 release PR #38). Users read the local banner as the verdict, push, and are surprised. The fix is to make the local output tell the truth about which dimension it actually checked, and to give an opt-in path to the *full* verdict locally.

## What Changes

- `plumb check` (default) prints a scoped `shape pre-flight: PASS/FAIL` banner and never a bare `APPROVE`/`REVIEW`/`REWORK`. It states that the semantic review still runs in CI.
- `plumb check --review` additionally runs the semantic review via the *same* code path as the CI gate and prints the real verdict (full local parity).
- With no provider key, `--review` degrades to the shape-only pre-flight and says so explicitly — it never prints a verdict it did not compute.
- `--help` and README document that default `check` is shape-only and `--review` is full parity.

## Scope / Non-goals

- Not changing what the CI gate does, the receipt schema, or the shape/semantic logic — only how the `check` command *labels* and *composes* existing checks locally.
- Not running the semantic review by default (keeps `check` fast/offline/free); `--review` is strictly opt-in.
- CI remains authoritative on merge (freshest diff + CI-evidence corroboration); `--review` is a pre-push convenience, not a replacement.
