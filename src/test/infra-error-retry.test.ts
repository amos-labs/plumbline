import { test } from "node:test";
import assert from "node:assert/strict";
import {
  githubFetch,
  InfraError,
  verifyCiEvidence,
  getPrHeadSha,
  RETRY_ATTEMPTS,
} from "../github.js";

/**
 * v0.6.1 — the infra-error state. The 2026-07-16 incident: a GitHub outage
 * (503 Unicorn) made the ci-evidence step report "could not verify CI checks:
 * …503…", which routed to a hard REWORK on a PR whose code was fine. The gate
 * must instead RETRY transient failures and, if they persist, surface a
 * distinct INDETERMINATE (infra_error) outcome — never a REWORK.
 *
 * These tests mock the network (no live calls) and use a no-op sleep so the
 * backoff adds no real latency.
 */

const noSleep = async (): Promise<void> => {};

/** A fetch mock that returns a scripted sequence of Responses (or throws). */
function scripted(steps: Array<Response | (() => never)>): { fn: typeof fetch; count: () => number } {
  let i = 0;
  const fn = (async () => {
    const step = steps[Math.min(i, steps.length - 1)];
    i++;
    if (typeof step === "function") step();
    return step as Response;
  }) as typeof fetch;
  return { fn, count: () => i };
}

const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
const status = (s: number) => new Response("upstream error", { status: s });

// ── githubFetch retry semantics ─────────────────────────────────────────────

for (const s of [500, 502, 503, 504, 429]) {
  test(`githubFetch: HTTP ${s} is retried, then a later success is returned`, async () => {
    const { fn, count } = scripted([status(s), status(s), ok()]);
    const res = await githubFetch("https://api.github.com/x", {}, "test call", {
      fetchImpl: fn,
      sleepImpl: noSleep,
    });
    assert.equal(res.status, 200);
    assert.equal(count(), 3, "should have retried twice before the success");
  });
}

test(`githubFetch: a transient status that never recovers → InfraError (not a verdict)`, async () => {
  const { fn, count } = scripted([status(503)]);
  await assert.rejects(
    () => githubFetch("https://api.github.com/x", {}, "get check-runs for abc", { fetchImpl: fn, sleepImpl: noSleep }),
    (e: unknown) => e instanceof InfraError && /503/.test((e as Error).message),
  );
  assert.equal(count(), RETRY_ATTEMPTS, "should have used every retry attempt");
});

test("githubFetch: network errors (ECONNRESET / socket hang up) are retried then → InfraError", async () => {
  const throwReset = () => {
    const e = new Error("socket hang up") as Error & { code?: string };
    e.code = "ECONNRESET";
    throw e;
  };
  const { fn, count } = scripted([throwReset, throwReset, throwReset, throwReset]);
  await assert.rejects(
    () => githubFetch("https://api.github.com/x", {}, "get PR #7", { fetchImpl: fn, sleepImpl: noSleep }),
    (e: unknown) => e instanceof InfraError && /socket hang up/i.test((e as Error).message),
  );
  assert.equal(count(), RETRY_ATTEMPTS);
});

test("githubFetch: a network error that recovers on retry returns the success", async () => {
  const throwTimeout = () => {
    const e = new Error("network timeout") as Error & { code?: string };
    e.code = "ETIMEDOUT";
    throw e;
  };
  const { fn } = scripted([throwTimeout, ok()]);
  const res = await githubFetch("https://api.github.com/x", {}, "test", { fetchImpl: fn, sleepImpl: noSleep });
  assert.equal(res.status, 200);
});

for (const s of [401, 403, 404]) {
  test(`githubFetch: HTTP ${s} (real auth/permission error) is NOT retried and is returned as-is`, async () => {
    const { fn, count } = scripted([status(s), ok()]);
    const res = await githubFetch("https://api.github.com/x", {}, "test", { fetchImpl: fn, sleepImpl: noSleep });
    assert.equal(res.status, s, "the 4xx is handed back to the caller, not retried");
    assert.equal(count(), 1, "no retry for a real 4xx");
  });
}

test("githubFetch: a non-transient thrown error is re-thrown as-is (not wrapped in InfraError)", async () => {
  const boom = () => {
    throw new TypeError("invalid URL");
  };
  const { fn } = scripted([boom]);
  await assert.rejects(
    () => githubFetch("https://api.github.com/x", {}, "test", { fetchImpl: fn, sleepImpl: noSleep }),
    (e: unknown) => e instanceof TypeError && !(e instanceof InfraError),
  );
});

// ── verifyCiEvidence / getPrHeadSha through the retry wrapper ────────────────

const HEAD_SHA = "abc123abc123abc123abc123abc123abc123abc1";

/** Mock: PR + check-runs both 503 forever (a full GitHub outage). */
function outageFetch(): typeof fetch {
  return (async () => status(503)) as typeof fetch;
}

test("verifyCiEvidence: a sustained 503 outage throws InfraError (routes to INDETERMINATE, not REWORK)", async (t) => {
  const real = global.fetch;
  global.fetch = outageFetch();
  t.after(() => (global.fetch = real));
  await assert.rejects(
    () => verifyCiEvidence("o/r", 7, "tok", ["test"]),
    (e: unknown) => e instanceof InfraError,
  );
});

test("getPrHeadSha: a real 404 still throws a plain Error (real error path, not infra)", async (t) => {
  const real = global.fetch;
  global.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/pulls/")) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    return ok();
  }) as typeof fetch;
  t.after(() => (global.fetch = real));
  await assert.rejects(
    () => getPrHeadSha("o/r", 7, "tok"),
    (e: unknown) => e instanceof Error && !(e instanceof InfraError) && /404/.test((e as Error).message),
  );
});

test("verifyCiEvidence: recovers when the outage clears mid-flight (retried success)", async (t) => {
  let calls = 0;
  const real = global.fetch;
  global.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls++;
    // First PR fetch 503s once, then succeeds; check-runs succeed.
    if (url.includes("/pulls/")) {
      return calls === 1
        ? status(503)
        : new Response(JSON.stringify({ head: { sha: HEAD_SHA } }), { status: 200 });
    }
    if (url.includes("/check-runs")) {
      return new Response(
        JSON.stringify({ check_runs: [{ name: "test", status: "completed", conclusion: "success" }] }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  t.after(() => (global.fetch = real));
  const res = await verifyCiEvidence("o/r", 7, "tok", ["test"]);
  assert.equal(res.pass, true, "a transient blip that clears yields a normal verdict, not INDETERMINATE");
});
