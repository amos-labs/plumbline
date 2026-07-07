import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AnthropicProvider,
  OpenAICompatibleProvider,
  resolveProviderId,
  selectProvider,
  ENV,
} from "../provider.js";
import { PolicySchema } from "../types.js";

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const basePolicy = PolicySchema.parse({ version: "1.0" });

test("resolveProviderId: defaults to anthropic", () => {
  withEnv({ [ENV.provider]: undefined }, () => {
    assert.equal(resolveProviderId(basePolicy), "anthropic");
  });
});

test("resolveProviderId: PLUMBLINE_PROVIDER env selects openai (aliases normalized)", () => {
  withEnv({ [ENV.provider]: "OpenAI-Compatible" }, () => {
    assert.equal(resolveProviderId(basePolicy), "openai");
  });
});

test("resolveProviderId: policy.review_provider used when no env", () => {
  withEnv({ [ENV.provider]: undefined }, () => {
    assert.equal(resolveProviderId({ review_provider: "openai" }), "openai");
  });
});

test("selectProvider: Anthropic default with ANTHROPIC_API_KEY", () => {
  withEnv(
    { [ENV.provider]: undefined, [ENV.anthropicKey]: "sk-ant", [ENV.apiBase]: undefined },
    () => {
      const p = selectProvider(basePolicy);
      assert.ok(p instanceof AnthropicProvider);
      assert.equal(p.id, "anthropic");
    },
  );
});

test("selectProvider: Anthropic errors clearly when no key", () => {
  withEnv(
    {
      [ENV.provider]: "anthropic",
      [ENV.anthropicKey]: undefined,
      [ENV.apiKey]: undefined,
      [ENV.apiKeyLegacy]: undefined,
    },
    () => {
      assert.throws(() => selectProvider(basePolicy), /no API key.*anthropic/);
    },
  );
});

test("selectProvider: openai builds OpenAICompatibleProvider with base+key", () => {
  withEnv(
    {
      [ENV.provider]: "openai",
      [ENV.apiKey]: "sk-oai",
      [ENV.apiBase]: "https://api.openai.com/v1",
    },
    () => {
      const p = selectProvider(basePolicy);
      assert.ok(p instanceof OpenAICompatibleProvider);
      assert.equal(p.id, "openai");
    },
  );
});

test("selectProvider: openai requires a base URL", () => {
  withEnv(
    { [ENV.provider]: "openai", [ENV.apiKey]: "sk-oai", [ENV.apiBase]: undefined },
    () => {
      assert.throws(() => selectProvider(basePolicy), /requires a base URL/);
    },
  );
});

test("selectProvider: openai base URL can come from policy.review_api_base", () => {
  withEnv(
    { [ENV.provider]: "openai", [ENV.apiKey]: "sk-oai", [ENV.apiBase]: undefined },
    () => {
      const p = selectProvider({ review_provider: "openai", review_api_base: "http://localhost:11434/v1" });
      assert.ok(p instanceof OpenAICompatibleProvider);
    },
  );
});
