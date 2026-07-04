# Contributing

This repo is **self-hosted**: plumbline gates plumbline. Every PR — human or
agent — carries a proof receipt and passes its own gate.

## The loop

```bash
plumb propose "<what you intend>"   # optional for trivial work (--lite):
                                    # opens the issue + OpenSpec contract, born linked
# ... do the work, commit ...
plumb receipt --write               # scaffold/refresh the mechanical fields
# fill the judgment fields: intent, validation_plan, execution_evidence, result_summary
plumb check                         # local pre-flight — what CI will say, before you push
git add .plumbline/receipts/<your-slug>.json && git commit && git push
```

CI runs two jobs on your PR:

- **test** — `tsc --noEmit`, build, full suite. Must pass; the gate reads this
  check-run's real conclusion (`ci_evidence_checks`), so the receipt can't
  claim a run CI didn't pass.
- **plumbline** — the gate itself, running **this PR's own code** (`uses: ./`),
  judged against [.plumbline/MISSION.md](.plumbline/MISSION.md).

## House rules

- One receipt per PR: `.plumbline/receipts/<branch-slug>.json`. Never edit
  another PR's receipt or a shared `receipt.json`.
- Touching the enforcement core (`src/shape.ts`, `src/severity.ts`,
  `src/github.ts`, `src/types.ts`, `action.yml`, `.plumbline/**`,
  `.github/workflows/**`) means `self_modifying: true` — a human always
  reviews. `receipt --write` derives this for you.
- Behavior changes need a test that fails without the change; enforcement
  changes need tests for the **failure modes**.
- The hard floor (`schema`, `diff_integrity`, `protected_paths`) is not
  configurable. Don't try.

See [.plumbline/AGENTS.md](.plumbline/AGENTS.md) for the full agent guide and
`plumb schema` for the receipt field reference.
