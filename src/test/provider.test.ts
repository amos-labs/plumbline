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

async function withEnvAsync(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    await fn();
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

test("selectProvider: unknown provider errors clearly (#8)", () => {
  withEnv(
    { [ENV.provider]: "gemini", [ENV.apiKey]: "k", [ENV.anthropicKey]: "k2" },
    () => {
      assert.throws(
        () => selectProvider(basePolicy),
        /unknown provider "gemini".*supported: "anthropic".*"openai"/,
      );
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

// --- SECURITY: OpenAI provider must NOT read/leak the Anthropic key (#2) ---

test("selectProvider: openai errors clearly when no provider key — even if ANTHROPIC_API_KEY is set", () => {
  withEnv(
    {
      [ENV.provider]: "openai",
      [ENV.apiKey]: undefined,
      [ENV.apiKeyLegacy]: undefined,
      // An Anthropic key IS present — it must NOT be borrowed for a third-party endpoint.
      [ENV.anthropicKey]: "sk-ant-SECRET",
      [ENV.apiBase]: "https://api.openai.com/v1",
    },
    () => {
      assert.throws(
        () => selectProvider({ review_provider: "openai", review_api_base: "https://api.openai.com/v1" }),
        (e: Error) => /no API key for provider "openai"/.test(e.message) && !e.message.includes("sk-ant-SECRET"),
        "must error for the missing openai key and never surface the anthropic secret",
      );
    },
  );
});

test("selectProvider: openai never uses the Anthropic key as its credential", async () => {
  await withEnvAsync(
    {
      [ENV.provider]: "openai",
      [ENV.apiKey]: "sk-oai-OWN",
      [ENV.apiKeyLegacy]: undefined,
      [ENV.anthropicKey]: "sk-ant-SECRET",
      [ENV.apiBase]: "https://example.test/v1",
    },
    async () => {
      const p = selectProvider({ review_provider: "openai", review_api_base: "https://example.test/v1" });
      assert.ok(p instanceof OpenAICompatibleProvider);
      // Capture the Authorization header sent to the endpoint.
      const orig = globalThis.fetch;
      let sentAuth = "";
      globalThis.fetch = (async (_url: string, init?: { headers?: Record<string, string> }) => {
        sentAuth = init?.headers?.authorization ?? "";
        return {
          ok: true,
          status: 200,
          text: async () => "",
          json: async () => ({ choices: [{ message: { content: "{}" } }] }),
        } as unknown as Response;
      }) as typeof fetch;
      try {
        await p.complete({ prompt: "x", model: "gpt-4o", maxTokens: 10 });
        assert.equal(sentAuth, "Bearer sk-oai-OWN");
        assert.ok(!sentAuth.includes("sk-ant-SECRET"), "the Anthropic key must never be sent to an OpenAI endpoint");
      } finally {
        globalThis.fetch = orig;
      }
    },
  );
});

// --- temperature: omitted-by-default for Anthropic (#3) ---

test("AnthropicProvider: omits temperature from the request body when undefined", async () => {
  const p = new AnthropicProvider("sk-ant", "https://example.test");
  const orig = globalThis.fetch;
  let body: any;
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    body = init?.body ? JSON.parse(init.body) : {};
    return {
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({ content: [{ type: "text", text: "{}" }] }),
    } as unknown as Response;
  }) as typeof fetch;
  try {
    await p.complete({ prompt: "x", model: "claude-x", maxTokens: 10 }); // temperature omitted
    assert.ok(!("temperature" in body), "no temperature key should be present");
  } finally {
    globalThis.fetch = orig;
  }
});

test("AnthropicProvider: sends temperature only when explicitly provided", async () => {
  const p = new AnthropicProvider("sk-ant", "https://example.test");
  const orig = globalThis.fetch;
  let body: any;
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    body = init?.body ? JSON.parse(init.body) : {};
    return {
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({ content: [{ type: "text", text: "{}" }] }),
    } as unknown as Response;
  }) as typeof fetch;
  try {
    await p.complete({ prompt: "x", model: "claude-x", maxTokens: 10, temperature: 0 });
    assert.equal(body.temperature, 0, "explicit 0 is honored for determinism where supported");
  } finally {
    globalThis.fetch = orig;
  }
});
