import type { OpenAIProviderConfig } from "../config/schema.js";
import { SwarmError, errorMessage } from "../errors.js";
import { createRedactor } from "../safety/redact.js";
import { extractJsonValue } from "./parse.js";
import type { AgentProvider, ProviderRequest, ProviderResponse } from "./types.js";
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";

const CompletionSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z
          .object({
            content: z.string().nullable().optional(),
            tool_calls: z
              .array(
                z.object({
                  id: z.string(),
                  type: z.literal("function"),
                  function: z.object({ name: z.string(), arguments: z.string() }),
                }),
              )
              .optional(),
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
    const messages: Array<Record<string, unknown>> = [
      ...(request.system ? [{ role: "system", content: request.system }] : []),
      { role: "user", content: request.prompt },
    ];
    const tools = this.capabilities.toolCalling ? (request.tools ?? []) : [];
    let lastRead = "";
    let repeatedReads = 0;
    const promptLimit = Math.min(
      request.maxPromptChars ?? 200000,
      this.config.maxInputChars ?? Infinity,
    );
    for (let round = 0; round <= (this.config.maxToolRounds ?? 16); round++) {
      request.signal?.throwIfAborted();
      if (round > 0 && JSON.stringify(messages).length > promptLimit * 0.75) {
        const before = JSON.stringify(messages).length;
        // Keep the full original system/user contract and the newest tool result.
        // Only older, re-readable tool evidence is compacted, explicitly.
        for (let index = 2; index < messages.length - 1; index++) {
          const message = messages[index]!;
          if (
            message.role === "tool" &&
            typeof message.content === "string" &&
            message.content.length > 1200
          )
            message.content = JSON.stringify({
              compacted: true,
              tool: message.name,
              instruction:
                "Earlier tool output omitted to preserve the goal and current evidence. Read this source or coordination record again if needed before editing.",
            });
        }
        const after = JSON.stringify(messages).length;
        request.onContextCompacted?.(before, after);
        if (after > promptLimit)
          throw new SwarmError(
            "Tool context still exceeds its limit after bounded compaction; split the task",
            "context_limit",
            true,
          );
      }
      const started = Date.now();
      let response: ProviderResponse;
      try {
        response = await this.requestCompletion(request, messages, tools.length > 0);
      } catch (error) {
        request.onCall?.({
          provider: this.name,
          model: this.model,
          durationMs: Date.now() - started,
          error: this.redact(errorMessage(error)),
        });
        throw error;
      }
      request.onCall?.({
        provider: response.provider,
        model: response.model,
        durationMs: Date.now() - started,
        usage: response.usage,
      });
      if (!response.toolCalls?.length) {
        if (request.expectJson && this.capabilities.structuredOutput && tools.length) {
          try {
            response.structured = extractJsonValue(response.text);
          } catch {
            if (round === (this.config.maxToolRounds ?? 16))
              throw new SwarmError(
                "Agent did not produce final JSON within its turn budget",
                "malformed",
                true,
              );
            messages.push(
              { role: "assistant", content: response.text },
              {
                role: "user",
                content:
                  "Your final response was not a JSON object. Return ONLY the required final JSON result now. Preserve files already edited. Do not wrap it in prose or XML.",
              },
            );
            continue;
          }
        }
        return response;
      }
      if (!tools.length || round === (this.config.maxToolRounds ?? 16)) {
        throw new SwarmError("Agent exceeded its tool round limit", "tool_limit", true);
      }
      messages.push({
        role: "assistant",
        content: response.text || null,
        tool_calls: response.toolCalls,
      });
      for (const call of response.toolCalls) {
        request.signal?.throwIfAborted();
        let result: unknown;
        try {
          const tool = tools.find((tool) => tool.name === call.function.name);
          if (!tool) throw new Error(`Unknown tool ${call.function.name}`);
          result = await tool.execute(JSON.parse(call.function.arguments));
        } catch (error) {
          result = { error: this.redact(errorMessage(error)) };
        }
        const serialized = JSON.stringify(result);
        const readOnly = [
          "read_file",
          "list_files",
          "search_source",
          "read_coordination",
          "read_goal",
        ].includes(call.function.name);
        const signature = readOnly
          ? JSON.stringify([call.function.name, call.function.arguments, serialized])
          : "";
        repeatedReads = signature && signature === lastRead ? repeatedReads + 1 : 1;
        lastRead = signature;
        if (readOnly && repeatedReads >= 3)
          throw new SwarmError(
            `Agent repeated ${call.function.name} three times with unchanged evidence`,
            "tool_loop",
            true,
          );
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content:
            serialized.length > 20000
              ? JSON.stringify({
                  truncated: true,
                  excerpt: serialized.slice(0, 18000),
                  instruction:
                    "Narrow this query or read another page; this tool result is incomplete",
                })
              : serialized,
        });
      }
    }
    throw new SwarmError("Tool loop ended without a result", "tool_limit");
  }

  private async requestCompletion(
    request: ProviderRequest,
    messages: Array<Record<string, unknown>>,
    useTools: boolean,
    rateLimitRetries = 0,
  ): Promise<ProviderResponse> {
    const timeoutMs = request.timeoutMs ?? this.config.timeoutMs;
    const key = this.readKey();
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (key) headers.authorization = `Bearer ${key}`;
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
    };
    if (this.config.temperature !== undefined) body.temperature = this.config.temperature;
    if (this.config.maxOutputTokens !== undefined) body.max_tokens = this.config.maxOutputTokens;
    if (useTools)
      body.tools = request.tools!.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }));
    const nativeOllama = this.config.protocol === "ollama";
    if (nativeOllama) {
      body.stream = false;
      if (this.config.thinking !== undefined) body.think = this.config.thinking;
      body.think = false;
      body.options = {
        num_ctx: this.config.contextTokens ?? 16384,
        num_predict: this.config.maxOutputTokens ?? 4096,
        ...(this.config.temperature !== undefined ? { temperature: this.config.temperature } : {}),
      };
      body.messages = messages.map((message) => {
        if (message.role === "tool")
          return { role: "tool", content: message.content, tool_name: message.name };
        if (Array.isArray(message.tool_calls))
          return {
            ...message,
            content: message.content ?? "",
            tool_calls: (message.tool_calls as NonNullable<ProviderResponse["toolCalls"]>).map(
              (call) => ({
                function: {
                  name: call.function.name,
                  arguments: JSON.parse(call.function.arguments),
                },
              }),
            ),
          };
        return message;
      });
      if (request.expectJson && !useTools && this.config.jsonMode === "json_object")
        body.format = "json";
      delete body.temperature;
      delete body.max_tokens;
    }
    if (
      request.expectJson &&
      !useTools &&
      this.config.capabilities.structuredOutput &&
      this.config.jsonMode === "json_object"
    ) {
      body.response_format = { type: "json_object" };
    }
    if (nativeOllama) delete body.response_format;
    if (this.config.maxInputChars && JSON.stringify(body).length > this.config.maxInputChars)
      throw new SwarmError(
        `Request exceeds ${this.config.maxInputChars}-character provider input budget. Split the assignment or read smaller source excerpts; no request was sent.`,
        "context_limit",
        true,
      );
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    const requestStarted = Date.now();
    let response: Response;
    try {
      response = await fetch(
        nativeOllama
          ? `${this.config.baseUrl.replace(/\/(?:v1|api\/chat)\/?$/, "").replace(/\/+$/, "")}/api/chat`
          : completionsUrl(this.config.baseUrl),
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal,
        },
      );
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
    if (response.status === 429 && rateLimitRetries < 2) {
      const retryAfter = response.headers.get("retry-after");
      const seconds = retryAfter === null ? NaN : Number(retryAfter);
      const fromDate = retryAfter ? Date.parse(retryAfter) - Date.now() : NaN;
      const fromMessage = /try again in\s+([\d.]+)s/i.exec(raw)?.[1];
      const waitMs = Number.isFinite(seconds)
        ? seconds * 1000
        : Number.isFinite(fromDate)
          ? fromDate
          : fromMessage
            ? Number(fromMessage) * 1000
            : NaN;
      if (Number.isFinite(waitMs) && waitMs >= 0 && waitMs <= 60000 && waitMs + 50 < timeoutMs) {
        request.onCall?.({
          provider: this.name,
          model: this.model,
          durationMs: Date.now() - requestStarted,
          error: `HTTP 429; waiting ${Math.ceil(waitMs)}ms before bounded retry`,
        });
        await delay(waitMs + 50, undefined, { signal });
        return this.requestCompletion(
          { ...request, signal },
          messages,
          useTools,
          rateLimitRetries + 1,
        );
      }
    }
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
    if (nativeOllama && parsedJson && typeof parsedJson === "object") {
      const native = parsedJson as {
        model?: string;
        message?: {
          content?: string;
          tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
        };
        prompt_eval_count?: number;
        eval_count?: number;
      };
      parsedJson = {
        model: native.model,
        choices: [
          {
            message: {
              ...native.message,
              tool_calls: native.message?.tool_calls?.map((call, index) => ({
                id: `ollama-${Date.now()}-${index}`,
                type: "function",
                function: {
                  name: call.function.name,
                  arguments:
                    typeof call.function.arguments === "string"
                      ? call.function.arguments
                      : JSON.stringify(call.function.arguments),
                },
              })),
            },
          },
        ],
        ...(native.prompt_eval_count !== undefined || native.eval_count !== undefined
          ? {
              usage: {
                prompt_tokens: native.prompt_eval_count,
                completion_tokens: native.eval_count,
                total_tokens: (native.prompt_eval_count ?? 0) + (native.eval_count ?? 0),
              },
            }
          : {}),
      };
    }
    const parsed = CompletionSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new SwarmError(
        "OpenAI-compatible response is missing choices[0].message",
        "malformed",
        true,
      );
    }
    const message = parsed.data.choices[0]!.message;
    const content = message.content ?? "";
    if (!content && !message.tool_calls?.length) {
      throw new SwarmError("OpenAI-compatible response content was empty", "malformed", true);
    }
    const result: ProviderResponse = {
      text: content,
      provider: this.providerName,
      model: parsed.data.model ?? this.config.model,
      toolCalls: message.tool_calls,
    };
    if (parsed.data.usage) {
      result.usage = {
        inputTokens: parsed.data.usage.prompt_tokens,
        outputTokens: parsed.data.usage.completion_tokens,
        totalTokens: parsed.data.usage.total_tokens,
      };
    }
    if (
      request.expectJson &&
      this.capabilities.structuredOutput &&
      !message.tool_calls?.length &&
      !useTools
    ) {
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
