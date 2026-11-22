# Revision approvals and test evidence

Enable `revision-approval: "true"` on the Plumbline gate action. Keep the suite and gate as required GitHub checks, check out the PR head in the gate job, and list the suite job in `ci_evidence_checks`. A terminal human REVIEW includes the exact command to post as a new PR comment. A repository admin or maintainer posts `/plumbline approve FULL_HEAD_SHA`, then selects **Re-run failed jobs**. Plumbline verifies the account's current repository role, the PR head, successful Actions checks and a fresh semantic review. A new commit requires a new decision. To withdraw before reevaluation, post `/plumbline revoke FULL_HEAD_SHA` and rerun the gate. A signed-off pass leaves the merge to the maintainer and normal GitHub branch rules. Use a native GitHub required review when you also require a second person.

## Test the merge tree once

For a suite whose results depend on the checkout, run the PR suite on the default synthetic merge checkout. Add this witness in the **same job after the full suite**. Keep the checkout and workflow protected. Suites that must test the deployed environment or newly resolved external inputs still need to run there.

```yaml
- uses: actions/checkout@v4
- id: proof
  if: github.event_name == 'push'
  continue-on-error: true
  uses: amos-labs/plumbline/actions/test-proof@REVIEWED_COMMIT_SHA
  with:
    workflow: ci.yml
    job: test
    test-step: Full suite
- name: Full suite
  if: steps.proof.outputs.reuse != 'true'
  run: npm test
- name: Verified PR ${{ github.event.number }} checkout ${{ github.sha }}
  if: github.event_name == 'pull_request'
  run: test "$(git rev-parse HEAD)" = "$GITHUB_SHA"
```

The action needs Python 3.8+, Git, the GitHub CLI, and token read access to Actions, contents and PRs. Missing proof selects the full suite. A proof identifies the workflow, attempt, job, measured test-step duration, PR head, tested merge commit and tree. The push and PR receipts are downloadable Actions artifacts. The PR gate receipt also records the policy digest, reviewer, verdict, findings and human decision. A missing checkout witness leaves the tested tree unknown.

## Compare reviewers and label outcomes

On the same PR checkout, use the same policy, receipt, base and PR number for each reviewer. Store results outside the checkout. An evaluated REVIEW or REWORK exits 1 and still writes its result. Both commands below are local reviews and have no merge authority.

```sh
mkdir -p /tmp/reviewer-comparison
plumb check --review --repo owner/project --pr 17 --result /tmp/reviewer-comparison/current.json
# Configure the candidate's PLUMBLINE_API_BASE and PLUMBLINE_API_KEY in this shell.
PLUMBLINE_PROVIDER=openai PLUMBLINE_MODEL=qwen plumb check --review --repo owner/project --pr 17 --result /tmp/reviewer-comparison/qwen.json
plumb outcomes /tmp/reviewer-comparison
```

Use the deployed model ID in place of `qwen`. The report pairs verdicts only when the revision, policy and exact rendered prompt match. It reports live review latency, deduplicated findings and the observed duration of reused test steps. To credit a fix, add a JSON file alongside the downloaded receipts with an evidence link and the finding ID from the review.

```json
{"schema":"plumbline.outcome.v1","repository":"owner/project","pr":17,"head":"0123456789abcdef0123456789abcdef01234567","finding":"ID_FROM_RESULT","outcome":"fixed","evidence":"URL of the fixing commit"}
```

Use `dismissed` for a rejected finding. Use `regression` with the PR head and incident or rollback evidence for a confirmed post-merge regression. Unlabeled findings stay visible. Regression counts measure only explicitly recorded incidents.
