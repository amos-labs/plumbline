import { test } from "node:test";
import assert from "node:assert/strict";
import { PolicySchema, DEFAULT_PROTECTED_PATHS } from "../types.js";
import { matchesAny } from "../glob.js";

test("protected_paths: conservative default is applied when unset", () => {
  const p = PolicySchema.parse({ version: "1.0" });
  assert.deepEqual(p.protected_paths, DEFAULT_PROTECTED_PATHS);
});

test("default protects genuinely high-consequence surfaces", () => {
  const g = DEFAULT_PROTECTED_PATHS;
  assert.ok(matchesAny(".plumbline/policy.json", g), "gate's own files");
  assert.ok(matchesAny(".github/workflows/ci.yml", g), "CI workflows");
  assert.ok(matchesAny("src/auth/login.ts", g), "auth");
  assert.ok(matchesAny("migrations/001_init.sql", g), "migrations");
  assert.ok(matchesAny("src/billing/invoice.ts", g), "billing");
  assert.ok(matchesAny("app/services/stripe_client.rb", g), "stripe");
  assert.ok(matchesAny("proof/receipt.json", g), "proof surface");
});

test("default does NOT protect ordinary code (REVIEW stays meaningful)", () => {
  const g = DEFAULT_PROTECTED_PATHS;
  assert.equal(matchesAny("src/pages/home.tsx", g), null);
  assert.equal(matchesAny("src/mcp/handler.ts", g), null, "not an entire src/mcp/**");
  assert.equal(matchesAny("src/components/Button.tsx", g), null);
  assert.equal(matchesAny("lib/util.ts", g), null);
});

test("protected_paths: explicit override REPLACES the default entirely", () => {
  const p = PolicySchema.parse({ version: "1.0", protected_paths: ["src/payments/**"] });
  assert.deepEqual(p.protected_paths, ["src/payments/**"]);
  // Widen: the owner-added surface is protected...
  assert.ok(matchesAny("src/payments/charge.ts", p.protected_paths));
  // ...and the default surfaces are no longer protected once overridden.
  assert.equal(matchesAny(".github/workflows/ci.yml", p.protected_paths), null);
});
