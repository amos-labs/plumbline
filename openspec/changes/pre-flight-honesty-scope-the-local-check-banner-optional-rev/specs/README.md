# Delta specs

One folder per capability this change touches: `specs/<capability>/spec.md`
(matching `openspec/specs/<capability>/spec.md`, the living source of truth).
On `plumb archive`, ADDED requirements are appended to the living spec,
MODIFIED replace the same-named requirement, REMOVED are deleted.

Format (OpenSpec convention):

```markdown
## ADDED Requirements

### Requirement: Session Timeout
The system SHALL expire a session after 30 minutes of inactivity.

#### Scenario: Idle timeout
- GIVEN an authenticated session
- WHEN 30 minutes pass with no activity
- THEN the session is invalidated and the user must re-authenticate

## MODIFIED Requirements

### Requirement: <existing name — full new version>
...

## REMOVED Requirements

### Requirement: <existing name>
Reason: <one line on why this behavior is going away>
```

One observable behavior per requirement (one SHALL/MUST); every requirement
gets at least one GIVEN/WHEN/THEN scenario that exercises it.
