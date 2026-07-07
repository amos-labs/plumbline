import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeRequiredChecks, setupProtection } from "../protection.js";

test("mergeRequiredChecks: union, sorted, reports only what was added", () => {
  const { merged, added } = mergeRequiredChecks(["test"], ["plumbline", "test"]);
  assert.deepEqual(merged, ["plumbline", "test"]);
  assert.deepEqual(added, ["plumbline"]);
});

test("mergeRequiredChecks: nothing to add when desired already present (idempotent)", () => {
  const { merged, added } = mergeRequiredChecks(["plumbline", "test"], ["plumbline"]);
  assert.deepEqual(merged, ["plumbline", "test"]);
  assert.deepEqual(added, []);
});

/** A tiny fetch stub that records requests and replies from a route table. */
function stubFetch(routes: Array<{ match: RegExp; method?: string; status?: number; body?: unknown }>) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fn = async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
    const r = routes.find((x) => x.match.test(url) && (x.method ?? "GET") === method);
    const status = r?.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (r?.body !== undefined ? JSON.stringify(r.body) : ""),
    } as unknown as Response;
  };
  return { fn, calls };
}

test("setupProtection: fresh repo — enables required checks (strict:false) + auto-merge", async () => {
  const { fn, calls } = stubFetch([
    { match: /\/repos\/o\/r$/, method: "GET", body: { default_branch: "master", node_id: "n", allow_auto_merge: false } },
    { match: /branches\/master\/protection$/, method: "GET", status: 404 },
    { match: /branches\/master\/protection$/, method: "PUT", body: {} },
    { match: /\/repos\/o\/r$/, method: "PATCH", body: {} },
  ]);
  const orig = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;
  try {
    const res = await setupProtection({ repo: "o/r", token: "t", checks: ["test"] });
    assert.equal(res.branch, "master");
    assert.deepEqual(res.requiredChecks, ["plumbline", "test"]);
    assert.equal(res.autoMergeEnabled, true);
    // The PUT set strict:false with both contexts.
    const put = calls.find((c) => c.method === "PUT")!;
    assert.equal((put.body as any).required_status_checks.strict, false);
    const ctxs = (put.body as any).required_status_checks.checks.map((c: any) => c.context).sort();
    assert.deepEqual(ctxs, ["plumbline", "test"]);
    // Auto-merge PATCH fired.
    assert.ok(calls.some((c) => c.method === "PATCH" && (c.body as any).allow_auto_merge === true));
  } finally {
    globalThis.fetch = orig;
  }
});

test("setupProtection: idempotent — already-correct repo writes nothing", async () => {
  const { fn, calls } = stubFetch([
    { match: /\/repos\/o\/r$/, method: "GET", body: { default_branch: "main", node_id: "n", allow_auto_merge: true } },
    {
      match: /branches\/main\/protection$/,
      method: "GET",
      body: { required_status_checks: { strict: false, checks: [{ context: "plumbline" }, { context: "test" }] } },
    },
  ]);
  const orig = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;
  try {
    const res = await setupProtection({ repo: "o/r", token: "t", checks: ["test"] });
    assert.deepEqual(res.requiredChecks, ["plumbline", "test"]);
    assert.equal(res.autoMergeEnabled, true);
    // No mutating calls: idempotent.
    assert.equal(calls.filter((c) => c.method === "PUT" || c.method === "PATCH").length, 0);
    assert.ok(res.changes.every((c) => /no change/.test(c)));
  } finally {
    globalThis.fetch = orig;
  }
});

test("setupProtection: dry-run reports changes but makes no mutating calls", async () => {
  const { fn, calls } = stubFetch([
    { match: /\/repos\/o\/r$/, method: "GET", body: { default_branch: "main", node_id: "n", allow_auto_merge: false } },
    { match: /branches\/main\/protection$/, method: "GET", status: 404 },
  ]);
  const orig = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;
  try {
    const res = await setupProtection({ repo: "o/r", token: "t", dryRun: true });
    assert.ok(res.changes.length > 0);
    assert.equal(calls.filter((c) => c.method === "PUT" || c.method === "PATCH").length, 0);
  } finally {
    globalThis.fetch = orig;
  }
});
