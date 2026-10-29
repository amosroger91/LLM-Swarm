import type { OpenAIProviderConfig } from "../config/schema.js";
import { SwarmError, errorMessage } from "../errors.js";
import { createRedactor } from "../safety/redact.js";
import { extractJsonValue } from "./parse.js";
import type { AgentProvider, ProviderRequest, ProviderResponse } from "./types.js";
import { z } from "zod";

const CompletionSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z
          .object({
            content: z.string().nullable().optional(),
          })
          .passthrough(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      total_tokens: z.number().optional(),
    })
    .optional(),
});

export function completionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  return `${trimmed}/chat/completions`;
}

export class OpenAICompatibleProvider implements AgentProvider {
  readonly name: string;
  readonly model: string;
  readonly capabilities: OpenAIProviderConfig["capabilities"];

  constructor(
    private readonly config: OpenAIProviderConfig,
    private readonly providerName: string,
    private readonly redact: (text: string) => string = (text) => text,
  ) {
    this.name = providerName;
    this.model = config.model;
    this.capabilities = config.capabilities;
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const timeoutMs = request.timeoutMs ?? this.config.timeoutMs;
    const key = this.readKey();
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (key) headers.authorization = `Bearer ${key}`;
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: [
        ...(request.system ? [{ role: "system", content: request.system }] : []),
        { role: "user", content: request.prompt },
      ],
    };
    if (this.config.temperature !== undefined) body.temperature = this.config.temperature;
    if (
      request.expectJson &&
      this.config.capabilities.structuredOutput &&
      this.config.jsonMode === "json_object"
    ) {
      body.response_format = { type: "json_object" };
    }
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(completionsUrl(this.config.baseUrl), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (request.signal?.aborted) {
        throw new SwarmError("Provider call was cancelled", "cancelled");
      }
      if (timeout.aborted || (error instanceof Error && error.name === "TimeoutError")) {
        throw new SwarmError(
          `OpenAI-compatible provider timed out after ${timeoutMs}ms`,
          "timeout",
          true,
        );
      }
      throw new SwarmError(
        `OpenAI-compatible request failed: ${this.redact(errorMessage(error))}`,
        "http",
        true,
      );
    }
    const raw = await response.text();
    const redacted = this.redact(raw.slice(0, 4000));
    if (!response.ok) {
      throw new SwarmError(
        `OpenAI-compatible provider returned HTTP ${response.status}: ${redacted}`,
        "http",
        response.status >= 500 || response.status === 429,
      );
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw) as unknown;
    } catch {
      throw new SwarmError("OpenAI-compatible provider returned malformed JSON", "malformed", true);
    }
    const parsed = CompletionSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new SwarmError(
        "OpenAI-compatible response is missing choices[0].message",
        "malformed",
        true,
      );
    }
    const content = parsed.data.choices[0]?.message.content;
    if (!content) {
      throw new SwarmError("OpenAI-compatible response content was empty", "malformed", true);
    }
    const result: ProviderResponse = {
      text: content,
      provider: this.providerName,
      model: parsed.data.model ?? this.config.model,
    };
    if (parsed.data.usage) {
      result.usage = {
        inputTokens: parsed.data.usage.prompt_tokens,
        outputTokens: parsed.data.usage.completion_tokens,
        totalTokens: parsed.data.usage.total_tokens,
      };
    }
    if (request.expectJson && this.capabilities.structuredOutput) {
      try {
        result.structured = extractJsonValue(content);
      } catch (error) {
        throw new SwarmError(this.redact(errorMessage(error)), "malformed", true);
      }
    }
    return result;
  }

  private readKey(): string | undefined {
    const name = this.config.apiKeyEnv;
    if (!name) {
      if (!this.config.apiKeyOptional) {
        throw new SwarmError(
          `Provider ${this.providerName} requires apiKeyEnv to be configured`,
          "missing_secret",
        );
      }
      return undefined;
    }
    const value = process.env[name];
    if (!value) {
      if (this.config.apiKeyOptional) return undefined;
      throw new SwarmError(
        `Provider ${this.providerName} expects an API key in ${name}. Set that environment variable. The value is never stored.`,
        "missing_secret",
      );
    }
    return value;
  }
}

export function redactorForKey(key: string | undefined): (text: string) => string {
  return createRedactor(key ? [key] : []);
}
