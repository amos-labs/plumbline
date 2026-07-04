import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyCiEvidence, getPrHeadSha } from "../github.js";

/**
 * The fetch path of CI-evidence verification — the security-critical part
 * that had zero coverage (the pure evaluator is covered in evidence.test.ts).
 * We mock global fetch and assert the gate consults the check-runs OF THE PR
 * HEAD SHA — not whatever SHA a receipt might point at.
 */

const HEAD_SHA = "abc123abc123abc123abc123abc123abc123abc1";
const OTHER_SHA = "ffff23abc123abc123abc123abc123abc123ffff";

interface MockRun {
  name: string;
  status: string;
  conclusion: string | null;
}

/** fetch mock: PR endpoint returns HEAD_SHA; check-runs are keyed by sha. */
function mockFetch(runsBySha: Record<string, MockRun[]>, prStatus = 200) {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/pulls/")) {
      return new Response(
        JSON.stringify(prStatus === 200 ? { head: { sha: HEAD_SHA } } : { message: "nope" }),
        { status: prStatus },
      );
    }
    const m = url.match(/\/commits\/([0-9a-f]+)\/check-runs/);
    if (m) {
      return new Response(JSON.stringify({ check_runs: runsBySha[m[1]] ?? [] }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { fn, calls };
}

test("verifyCiEvidence: passes when the required check succeeded on the PR head", async (t) => {
  const { fn, calls } = mockFetch({
    [HEAD_SHA]: [{ name: "test", status: "completed", conclusion: "success" }],
  });
  const real = global.fetch;
  global.fetch = fn;
  t.after(() => (global.fetch = real));

  const res = await verifyCiEvidence("o/r", 7, "tok", ["test"]);
  assert.equal(res.pass, true);
  assert.deepEqual(res.notes, ["test: success"]);
  // It consulted the check-runs of the HEAD sha specifically.
  assert.ok(calls.some((c) => c.includes(`/commits/${HEAD_SHA}/check-runs`)));
});

test("verifyCiEvidence: fails when the check concluded failure", async (t) => {
  const { fn } = mockFetch({
    [HEAD_SHA]: [{ name: "test", status: "completed", conclusion: "failure" }],
  });
  const real = global.fetch;
  global.fetch = fn;
  t.after(() => (global.fetch = real));

  const res = await verifyCiEvidence("o/r", 7, "tok", ["test"]);
  assert.equal(res.pass, false);
  assert.ok(res.errors[0].includes('did not pass'));
});

test("verifyCiEvidence: fails when the required check never ran on the head", async (t) => {
  const { fn } = mockFetch({ [HEAD_SHA]: [] });
  const real = global.fetch;
  global.fetch = fn;
  t.after(() => (global.fetch = real));

  const res = await verifyCiEvidence("o/r", 7, "tok", ["test"]);
  assert.equal(res.pass, false);
  assert.ok(res.errors[0].includes("did not run for the head commit"));
});

test("verifyCiEvidence: a success on a DIFFERENT sha does not count (wrong-head-SHA)", async (t) => {
  // The 'attack': the suite passed on some other commit, not this PR's head.
  const { fn, calls } = mockFetch({
    [OTHER_SHA]: [{ name: "test", status: "completed", conclusion: "success" }],
    [HEAD_SHA]: [],
  });
  const real = global.fetch;
  global.fetch = fn;
  t.after(() => (global.fetch = real));

  const res = await verifyCiEvidence("o/r", 7, "tok", ["test"]);
  assert.equal(res.pass, false, "success on another sha must not satisfy the gate");
  // And it never even asked about the other sha.
  assert.ok(!calls.some((c) => c.includes(OTHER_SHA)));
});

test("getPrHeadSha: PR fetch failure throws (gate treats as unverifiable)", async (t) => {
  const { fn } = mockFetch({}, 404);
  const real = global.fetch;
  global.fetch = fn;
  t.after(() => (global.fetch = real));

  await assert.rejects(() => getPrHeadSha("o/r", 7, "tok"), /get PR #7: 404/);
});
