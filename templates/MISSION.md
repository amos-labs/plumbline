# Mission

<!--
This file is the constitution for AI-agent work in this repository.
The proofgate semantic reviewer judges every agent PR against it.
Write it for a reviewer, not a marketer: concrete invariants beat vibes.
-->

## What this project is for

<!-- One or two paragraphs. What does this software do, for whom, and what
     does "advancing the project" mean? The reviewer uses this to judge
     whether a change helps or merely passes tests. -->

## Invariants — no change may weaken these

<!-- Number them. Be specific. The reviewer will quote these back when a
     change puts one at risk. Examples:

1. User data is never deleted without a soft-delete window.
2. All payment mutations go through the PaymentService — never raw SQL.
3. Public API responses remain backward compatible within a major version.
4. No new runtime dependencies without explicit human approval.
-->

## Protected surfaces (self-modifying work)

<!-- Changes here must declare self_modifying: true in the receipt and can
     never auto-approve — a human always decides. Keep in sync with
     protected_paths in .proofgate/policy.json. Examples:

- Authentication, authorization, or permission logic
- Payment and billing code
- Database migrations
- This file and .proofgate/** (the gate must not weaken itself)
-->

## Validation expectations

<!-- What does "adequately validated" mean here? Examples:

- Behavior changes require a test that fails without the change.
- UI changes include a screenshot or rendered-output reference.
- Migrations include a rollback path.
-->

## Out of scope

<!-- Things agents should not do even if asked by a ticket. Examples:
- Refactors unrelated to the stated intent
- Dependency upgrades bundled into feature work
-->
