## ADDED Requirements

### Requirement: Local pre-flight reports only the shape dimension
`plumb check` (without `--review`) SHALL run only the shape floor + `diff_sha256`
verification and SHALL NOT print a bare gate verdict (`APPROVE` / `REVIEW` /
`REWORK`). It SHALL print a scoped `shape pre-flight: PASS/FAIL` banner and SHALL
state that the semantic review still runs in CI.

#### Scenario: Shape passes locally
- GIVEN a well-formed receipt whose `diff_sha256` matches the committed diff
- WHEN a developer runs `plumb check`
- THEN the output shows `shape pre-flight: PASS`
- AND the output does not contain `plumbline: APPROVE`
- AND the output says the semantic review runs in CI

#### Scenario: Shape fails locally
- GIVEN a receipt whose `diff_sha256` does not match the committed diff
- WHEN a developer runs `plumb check`
- THEN the output shows `shape pre-flight: FAIL` with the shape errors
- AND the exit code is non-zero

### Requirement: Opt-in full-parity local review
`plumb check --review` SHALL additionally run the semantic review through the same
code path as the CI gate and print the real verdict. When no provider key is
available it SHALL degrade to the shape-only pre-flight and SHALL state that it did
so — it SHALL NOT print a verdict it did not compute.

#### Scenario: Review requested without a key
- GIVEN no `ANTHROPIC_API_KEY` / `PLUMBLINE_API_KEY` in the environment
- WHEN a developer runs `plumb check --review`
- THEN the output states it is falling back to the shape-only pre-flight
- AND it prints the `shape pre-flight` banner, not a semantic verdict

#### Scenario: Review requested with a key
- GIVEN a valid provider key in the environment
- WHEN a developer runs `plumb check --review`
- THEN the output is the real gate verdict (shape + semantic), matching what CI would produce for the same diff
