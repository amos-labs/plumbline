import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderConsolidatedBody,
  fileConsolidatedFollowUps,
  closeFollowUpOnMerge,
} from "../github.js";
import { PolicySchema } from "../types.js";

test("follow_ups policy: sane defaults (bar 0.8, consolidate, close-on-merge)", () => {
  const f = PolicySchema.parse({ version: "1.0" }).follow_ups;
  assert.equal(f.min_confidence, 0.8);
  assert.equal(f.consolidate, true);
  assert.equal(f.close_on_merge, true);
});

test("renderConsolidatedBody: one checklist keyed to the PR (dedup marker + items)", () => {
  const body = renderConsolidatedBody(42, ["Add a test for the edge case", "Extract the helper"]);
  assert.ok(body.includes("plumbline:pr-followups:42"), "carries the per-PR dedup marker");
  assert.ok(body.includes("- [ ] Add a test for the edge case"));
  assert.ok(body.includes("- [ ] Extract the helper"));
  assert.ok(/follow-?up/i.test(body), "reads as a follow-up issue");
});

/** fetch mock: search finds an existing issue or not, records POST/PATCH. */
function mockFetch(existing: { number: number; state: string } | null) {
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url, body: init?.body as string | undefined });
    if (url.includes("/search/issues")) {
      return new Response(JSON.stringify({ items: existing ? [existing] : [] }), { status: 200 });
    }
    if (url.includes("/issues") && method === "POST" && !url.includes("/comments")) {
      return new Response(JSON.stringify({ number: 999 }), { status: 201 });
    }
    if (method === "PATCH") return new Response(JSON.stringify({ number: existing?.number }), { status: 200 });
    if (url.includes("/comments")) return new Response("{}", { status: 201 });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return { fn, calls };
}

test("fileConsolidatedFollowUps: creates ONE issue when none exists", async (t) => {
  const { fn, calls } = mockFetch(null);
  const real = global.fetch;
  global.fetch = fn;
  t.after(() => (global.fetch = real));

  const res = await fileConsolidatedFollowUps("o/r", 7, ["a", "b", "c"], "tok");
  assert.equal(res.action, "created");
  assert.equal(res.number, 999);
  const posts = calls.filter((c) => c.method === "POST" && c.url.endsWith("/issues"));
  assert.equal(posts.length, 1, "exactly ONE issue created for 3 findings (not 3)");
});

test("fileConsolidatedFollowUps: UPDATES in place on re-run (dedup by PR)", async (t) => {
  const { fn, calls } = mockFetch({ number: 55, state: "open" });
  const real = global.fetch;
  global.fetch = fn;
  t.after(() => (global.fetch = real));

  const res = await fileConsolidatedFollowUps("o/r", 7, ["a", "b"], "tok");
  assert.equal(res.action, "updated");
  assert.equal(res.number, 55);
  assert.ok(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/issues/55")));
  assert.ok(!calls.some((c) => c.method === "POST" && c.url.endsWith("/issues")), "no new issue on re-run");
});

test("fileConsolidatedFollowUps: no findings → noop (nothing filed)", async (t) => {
  const { fn, calls } = mockFetch(null);
  const real = global.fetch;
  global.fetch = fn;
  t.after(() => (global.fetch = real));

  const res = await fileConsolidatedFollowUps("o/r", 7, [], "tok");
  assert.equal(res.action, "noop");
  assert.equal(calls.length, 0);
});

test("closeFollowUpOnMerge: closes an open consolidated issue", async (t) => {
  const { fn, calls } = mockFetch({ number: 55, state: "open" });
  const real = global.fetch;
  global.fetch = fn;
  t.after(() => (global.fetch = real));

  const closed = await closeFollowUpOnMerge("o/r", 7, "tok");
  assert.equal(closed, 55);
  const patch = calls.find((c) => c.method === "PATCH" && c.url.endsWith("/issues/55"));
  assert.ok(patch && patch.body!.includes("closed"), "PATCHed state=closed");
});

test("closeFollowUpOnMerge: already-closed issue → noop (null)", async (t) => {
  const { fn } = mockFetch({ number: 55, state: "closed" });
  const real = global.fetch;
  global.fetch = fn;
  t.after(() => (global.fetch = real));

  assert.equal(await closeFollowUpOnMerge("o/r", 7, "tok"), null);
});
