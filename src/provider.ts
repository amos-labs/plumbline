import type { Policy } from "./types.js";

/**
 * Provider abstraction for the semantic-review LLM call.
 *
 * The prompt and the verdict schema (approve/rework/review) live in review.ts
 * and are provider-INDEPENDENT — a provider only knows how to turn a prompt
 * into a completion string. This is the "no lock-in on intelligence" seam:
 * adopters can point the gate at Anthropic (default), any OpenAI-compatible
 * endpoint (OpenAI, Azure OpenAI, Together, Groq, vLLM, LM Studio, Ollama's
 * OpenAI shim, …), or a self-hosted model — without touching the review logic.
 */
export interface CompletionRequest {
  prompt: string;
  /** Model id. Resolved by the caller from env/policy before dispatch. */
  model: string;
  /** Upper bound on output tokens. */
  maxTokens: number;
  /**
   * Sampling temperature. OPTIONAL: when undefined the provider must OMIT it
   * from the request entirely (not send 0). Some Anthropic models reject an
   * explicit `temperature` and would break the gate — so the default is to send
   * no temperature and let the backend use its own low default. Only set when
   * the adopter explicitly configures `review_temperature` in policy (or
   * PLUMBLINE_TEMPERATURE). Where supported, an explicit value pins determinism.
   */
  temperature?: number;
}

export interface ReviewProvider {
  /** Stable provider id recorded in the receipt for auditability. */
  readonly id: string;
  /** Return the raw model text (expected to be the verdict JSON). */
  complete(req: CompletionRequest): Promise<string>;
}

interface AnthropicResponse {
  content: Array<{ type: string; text?: string }>;
}

/**
 * Anthropic Messages API — the default, unchanged path. Reads ANTHROPIC_API_KEY
 * (with a PLUMBLINE_API_KEY / PROOFGATE_API_KEY fallback shared with the
 * OpenAI-compatible provider). Endpoint override via PLUMBLINE_API_BASE for
 * proxies/gateways; defaults to api.anthropic.com.
 */
export class AnthropicProvider implements ReviewProvider {
  readonly id = "anthropic";
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.anthropic.com",
  ) {}

  async complete(req: CompletionRequest): Promise<string> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens,
        // Omit temperature unless explicitly configured — some Anthropic models
        // reject an explicit temperature.
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        messages: [{ role: "user", content: req.prompt }],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 500)}`);
    }
    const data = (await res.json()) as AnthropicResponse;
    return data.content.find((c) => c.type === "text")?.text ?? "";
  }
}

interface OpenAIResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

/**
 * OpenAI-compatible Chat Completions provider. Works against any endpoint that
 * speaks POST {base}/chat/completions with a Bearer key — OpenAI itself, Azure
 * OpenAI (via a compatible gateway), Together, Groq, Fireworks, vLLM, Ollama's
 * OpenAI shim, LM Studio, etc. Base URL is REQUIRED (no implicit default) so a
 * self-hosted endpoint is a first-class citizen and nothing silently phones
 * home to a vendor the adopter didn't choose.
 */
export class OpenAICompatibleProvider implements ReviewProvider {
  readonly id = "openai";
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
  ) {}

  async complete(req: CompletionRequest): Promise<string> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens,
        // Same policy as the Anthropic path: omit unless explicitly configured.
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        messages: [{ role: "user", content: req.prompt }],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI-compatible API error ${res.status}: ${body.slice(0, 500)}`);
    }
    const data = (await res.json()) as OpenAIResponse;
    return data.choices?.[0]?.message?.content ?? "";
  }
}

/** Env-var names, kept in one place so docs and code can't drift. */
export const ENV = {
  provider: "PLUMBLINE_PROVIDER",
  apiBase: "PLUMBLINE_API_BASE",
  apiKey: "PLUMBLINE_API_KEY",
  // Back-compat alias from the proofgate→Plumbline rename — retained on purpose
  // so early adopters' env keeps working; PLUMBLINE_API_KEY is the canonical name.
  apiKeyLegacy: "PROOFGATE_API_KEY",
  anthropicKey: "ANTHROPIC_API_KEY",
} as const;

/**
 * Resolve which provider ID is active. Precedence: PLUMBLINE_PROVIDER env >
 * policy.review_provider > "anthropic" (default). Case-insensitive; "openai",
 * "openai-compatible", and "openai_compatible" all map to the OpenAI provider.
 */
export function resolveProviderId(policy: Pick<Policy, "review_provider">): string {
  const raw = (process.env[ENV.provider] || policy.review_provider || "anthropic").toLowerCase();
  if (raw === "openai-compatible" || raw === "openai_compatible") return "openai";
  return raw;
}

/**
 * Construct the active provider from env + policy. Throws a clear, actionable
 * error when required config (an API key, or a base URL for the OpenAI path) is
 * missing — the CLI turns that into a non-zero exit rather than a mystery.
 *
 * The Anthropic path is intentionally unchanged in its env surface:
 * ANTHROPIC_API_KEY still works exactly as before.
 */
export function selectProvider(policy: Pick<Policy, "review_provider" | "review_api_base">): ReviewProvider {
  const id = resolveProviderId(policy);
  const sharedKey = process.env[ENV.apiKey] || process.env[ENV.apiKeyLegacy];

  if (id === "anthropic") {
    const key = process.env[ENV.anthropicKey] || sharedKey;
    if (!key) {
      throw new Error(
        `semantic review: no API key for provider "anthropic" — set ${ENV.anthropicKey} (or ${ENV.apiKey}).`,
      );
    }
    const base = process.env[ENV.apiBase] || policy.review_api_base;
    return base ? new AnthropicProvider(key, base) : new AnthropicProvider(key);
  }

  if (id === "openai") {
    // SECURITY: do NOT fall back to ANTHROPIC_API_KEY here. An OpenAI-compatible
    // provider points at a third-party/self-hosted endpoint; sending an
    // Anthropic key there would leak that credential to a host that has no
    // business seeing it. Require an explicit provider key.
    const key = sharedKey;
    if (!key) {
      throw new Error(
        `semantic review: no API key for provider "openai" — set ${ENV.apiKey} (or ${ENV.apiKeyLegacy}). ` +
          `The Anthropic key (${ENV.anthropicKey}) is intentionally NOT used for a non-Anthropic ` +
          `endpoint — that would leak your Anthropic credential to a third-party host.`,
      );
    }
    const base = process.env[ENV.apiBase] || policy.review_api_base;
    if (!base) {
      throw new Error(
        `semantic review: provider "openai" requires a base URL — set ${ENV.apiBase} ` +
          `(or policy.review_api_base), e.g. https://api.openai.com/v1 or your self-hosted endpoint.`,
      );
    }
    return new OpenAICompatibleProvider(key, base);
  }

  throw new Error(
    `semantic review: unknown provider "${id}" — supported: "anthropic" (default), "openai".`,
  );
}
