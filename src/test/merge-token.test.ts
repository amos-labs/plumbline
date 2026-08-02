import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveMergeToken } from "../github.js";

/**
 * Regression cover for "auto-merged, green, and never deployed".
 *
 * `lifecycle: auto_merge` hands the merge to GitHub. GitHub performs it on
 * behalf of whoever ENABLED auto-merge — and GitHub's recursion guard
 * suppresses every workflow trigger for actions taken with the default
 * `GITHUB_TOKEN`. So enabling auto-merge with `GITHUB_TOKEN` produces a merge
 * commit that fires NO `push` event: a CD workflow on `push: [main]` never
 * runs, and the commit sits on main looking shipped while nothing deployed.
 *
 * Observed downstream (cuspr, 2026-08-02): four PRs auto-merged green and not
 * one of them deployed. That repo had already papered over it with a
 * ten-minute cron safety net, but GitHub throttles schedules on busy shared
 * runners — every deploy run there was `event: schedule` at a 1–3 HOUR cadence,
 * never `push`. An earlier incident in the same repo silently held 29 commits
 * for 5 days.
 *
 * The contract: a repo can supply `PLUMBLINE_MERGE_TOKEN` (the action's
 * `merge-token` input) to attribute the merge to a real identity, and the
 * caller must be able to tell when it is falling back — so it can WARN rather
 * than merge silently into a void.
 */

test("a merge token is preferred and does not suppress workflows", () => {
  const r = resolveMergeToken({ PLUMBLINE_MERGE_TOKEN: "pat_abc", GITHUB_TOKEN: "ghs_default" });
  assert.equal(r.token, "pat_abc");
  assert.equal(r.suppressesWorkflows, false);
});

test("falls back to GITHUB_TOKEN and flags that it suppresses workflows", () => {
  const r = resolveMergeToken({ GITHUB_TOKEN: "ghs_default" });
  assert.equal(r.token, "ghs_default");
  assert.equal(
    r.suppressesWorkflows,
    true,
    "the caller must know the fallback is in use — that is the whole point of the warning",
  );
});

test("a blank or whitespace merge token is treated as absent, not as a token", () => {
  // An unset `merge-token` action input arrives as "" — using it as a bearer
  // token would fail the mutation and silently disable auto-merge entirely.
  for (const blank of ["", "   ", "\n"]) {
    const r = resolveMergeToken({ PLUMBLINE_MERGE_TOKEN: blank, GITHUB_TOKEN: "ghs_default" });
    assert.equal(r.token, "ghs_default", `blank merge token ${JSON.stringify(blank)} should fall back`);
    assert.equal(r.suppressesWorkflows, true);
  }
});

test("no tokens at all yields no token and nothing to warn about", () => {
  const r = resolveMergeToken({});
  assert.equal(r.token, undefined);
  assert.equal(r.suppressesWorkflows, false, "there is no merge to warn about if we cannot enable one");
});

test("a whitespace-only GITHUB_TOKEN is not a token either", () => {
  const r = resolveMergeToken({ GITHUB_TOKEN: "  " });
  assert.equal(r.token, undefined);
  assert.equal(r.suppressesWorkflows, false);
});
