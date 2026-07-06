# Mission

## What this project is for

Plumbline is the plumb line of Amos 7:7–8 for AI-agent work: a proof-carrying
gate. Every change ships with a **receipt** — intent, validation plan, evidence,
and a diff hash that cryptographically binds the claim to the actual change —
and the gate verifies the receipt before work merges. Advancing the project
means making honest work *easier to prove* and dishonest or sloppy work
*harder to merge*, for any team running coding agents — not just AMOS.

The one law that governs every feature: **automate the bookkeeping, never the
judgment.** Mechanical fields (hashes, file lists, derived `self_modifying`)
are computed by tooling; judgment fields (intent, validation plan, evidence,
result summary) are authored by the human or agent doing the work and verified
— never generated — by the gate.

## Invariants — no change may weaken these

1. **The hard floor is non-negotiable.** `schema`, `diff_integrity`, and
   `protected_paths` checks can never be downgraded, disabled, or bypassed by
   any policy knob, preset, or flag. A change that lets any strictness setting
   relax the floor is wrong by definition.
2. **The receipt schema is a public standard.** Field names, meanings, and
   `receipt_version` semantics stay backward compatible; existing receipts in
   the wild must keep validating.
3. **Scaffolding and gate can never disagree.** `receipt --write`, `stamp`,
   `propose`, and the gate must share the same hash/glob/diff code paths — no
   parallel reimplementations.
4. **`self_modifying` only auto-upgrades.** Tooling may set it `false → true`
   (naming the trigger); nothing may silently downgrade `true → false`.
5. **Evidence is corroborated, not trusted.** Where `ci_evidence_checks` is
   configured, the gate reads real check-run conclusions for the PR head —
   a receipt cannot claim a run CI didn't pass.
6. **Legacy `.proofgate/` repos keep working.** Dual-dir resolution stays.
7. **Exit code is the gate**: `0` only on approve.

## Protected surfaces (self-modifying work)

Changes here must declare `self_modifying: true` and always route to human
review — the gate must not weaken itself:

- `src/shape.ts`, `src/severity.ts`, `src/github.ts`, `src/types.ts` —
  the enforcement core (checks, severity floor, CI evidence, schemas)
- `action.yml` — what CI actually executes
- `.plumbline/**` — this repo's own policy, mission, and receipts
- `.github/workflows/**` — the pipeline that runs the gate

## Validation expectations

- Behavior changes require a test that fails without the change.
- Anything touching the enforcement core requires tests for the *failure*
  modes, not just happy paths (a gate is only as good as what it rejects).
- `npm test` (the full suite) and `tsc --noEmit` pass; CI's `test` job is the
  corroborated evidence source.

## Out of scope

- Refactors unrelated to the stated intent.
- Dependency additions/upgrades bundled into feature work — new runtime
  dependencies need explicit human approval.
- Auto-generating judgment fields (intent, plans, evidence, summaries) in any
  tooling — that would defeat the product.
