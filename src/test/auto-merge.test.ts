import { test } from "node:test";
import assert from "node:assert/strict";
import { enableAutoMerge } from "../github.js";
import { PolicySchema } from "../types.js";

const NODE_ID = "PR_kwDONODEID";

function mockFetch(opts: { graphqlErrors?: string[]; graphqlOk?: boolean } = {}) {
  const calls: Array<{ url: string; body?: string }> = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body as string | undefined });
    if (url.includes("/pulls/")) {
      return new Response(JSON.stringify({ node_id: NODE_ID }), { status: 200 });
    }
    if (url.includes("/graphql")) {
      if (opts.graphqlErrors) {
        return new Response(JSON.stringify({ errors: opts.graphqlErrors.map((m) => ({ message: m })) }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          data: { enablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: { enabledAt: "now" } } } },
        }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { fn, calls };
}

test("enableAutoMerge: sends the enablePullRequestAutoMerge mutation with the PR node id", async (t) => {
  const { fn, calls } = mockFetch();
  const real = global.fetch;
  global.fetch = fn;
  t.after(() => (global.fetch = real));

  const ok = await enableAutoMerge("o/r", 12, "tok");
  assert.equal(ok, true);
  const gql = calls.find((c) => c.url.includes("/graphql"));
  assert.ok(gql, "called the graphql endpoint");
  assert.ok(gql!.body!.includes("enablePullRequestAutoMerge"));
  assert.ok(gql!.body!.includes(NODE_ID), "used the PR node id from the REST lookup");
});

test("enableAutoMerge: returns false (never throws) when GitHub rejects (e.g. auto-merge not allowed)", async (t) => {
  const { fn } = mockFetch({ graphqlErrors: ["Auto merge is not allowed for this repository"] });
  const real = global.fetch;
  global.fetch = fn;
  t.after(() => (global.fetch = real));

  const ok = await enableAutoMerge("o/r", 12, "tok");
  assert.equal(ok, false);
});

test("lifecycle policy: defaults to review; auto_merge accepted", () => {
  assert.equal(PolicySchema.parse({ version: "1.0" }).lifecycle, "review");
  assert.equal(PolicySchema.parse({ version: "1.0", lifecycle: "auto_merge" }).lifecycle, "auto_merge");
});
