# Tasks — Pre-flight honesty: scope the local check banner + optional --review full-parity mode

- [x] `renderPreflight()` renders a `shape pre-flight: PASS/FAIL` banner with no gate-verdict word (unit test: `src/test/preflight.test.ts`)
- [x] `plumb check` (default) prints the pre-flight banner, not `plumbline: APPROVE` (integration test: `src/test/cli-check.test.ts`)
- [x] `plumb check --review` runs the semantic review via the shared gate path; with no key it degrades to shape-only with an explicit note (integration test: `src/test/cli-check.test.ts`)
- [x] `--help` + README document default `check` = shape-only, `--review` = full parity
- [x] receipt: `plumb receipt --write`, fill judgment fields, `plumb check`
