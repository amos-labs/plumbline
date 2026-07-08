# Semantic review — verdict semantics delta

## ADDED Requirements

### Requirement: Turn-based verdict selection
The gate SHALL derive the semantic-review verdict mechanically from the classified
findings — not from the model's self-reported verdict — so the verdict encodes
whose turn it is, exclusively.

#### Scenario: Agent-fixable defect on a protected path
- GIVEN a review that returns a blocking, agent-actionable finding
- AND the change touches a protected path (self_modifying is true)
- WHEN the gate selects the verdict
- THEN the verdict is `rework` (the agent's turn), and the protected floor still forbids auto-approve but does not skip the agent-iteration phase

#### Scenario: Empty agent set with a human decision
- GIVEN a review whose blocking-agent set is empty
- AND there is a blocking human finding OR the protected floor holds
- WHEN the gate selects the verdict
- THEN the verdict is `review` and the comment contains zero agent (🤖) items

#### Scenario: Clean pass
- GIVEN a review with no blocking findings and no protected floor
- WHEN the gate selects the verdict
- THEN the verdict is `approve`

### Requirement: Blocking vs advisory findings
The review SHALL classify each finding as `blocking` or `advisory`, and only
blocking findings SHALL affect the verdict. Advisory findings are recorded and
rendered in a separate, non-blocking section.

#### Scenario: Advisory notes never block
- GIVEN a review that returns only advisory findings (e.g. "consider…", style)
- WHEN the gate selects the verdict
- THEN the verdict is `approve` (or `review` if the protected floor holds), never `rework`, and the advisory notes appear in their own non-blocking section

### Requirement: Convergent re-review with a round cap
On a re-review the gate SHALL feed the prior failure capsule and the fix commits
into the prompt and constrain the model to verify the previously named blocking
items and review only the new/changed hunks for regressions. After two rework
rounds a convergence cap SHALL engage: only regressions-in-fixes may block, and
any other unresolved item escalates to human review under an explicit
"gate did not converge — human decides" banner.

#### Scenario: Non-regression nit at the round cap
- GIVEN a PR that has been through two rework rounds
- AND the re-review returns a blocking, agent-actionable finding that is not a regression
- WHEN the gate selects the verdict
- THEN the finding is escalated to a human decision, the verdict is `review`, and the capsule is flagged as not converged

#### Scenario: Regression at the round cap still blocks
- GIVEN a PR that has been through two rework rounds
- AND the re-review returns a blocking, agent-actionable finding marked as a regression introduced by the fix commits
- WHEN the gate selects the verdict
- THEN the verdict is `rework` (the regression must be fixed)
