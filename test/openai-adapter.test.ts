import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createRedactor } from "../src/safety/redact.js";
import { SwarmError } from "../src/errors.js";
import { completionsUrl, OpenAICompatibleProvider } from "../src/providers/openai.js";
import { createProvider, registerProviderBuilder } from "../src/providers/registry.js";
import type { OpenAIProviderConfig } from "../src/config/schema.js";

interface Captured {
  authorization?: string;
  body: Record<string, unknown>;
}

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
});

function providerConfig(
  baseUrl: string,
  patch: Partial<OpenAIProviderConfig> = {},
): OpenAIProviderConfig {
  return {
    type: "openai_compatible",
    baseUrl,
    model: "fake-model",
    apiKeyEnv: "SWARM_TEST_OPENAI_KEY",
    apiKeyOptional: false,
    timeoutMs: 1_000,
    jsonMode: "json_object",
    capabilities: {
      structuredOutput: true,
      toolCalling: false,
      streaming: false,
      nonInteractive: true,
    },
    ...patch,
  };
}

function listen(
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: Record<string, unknown>,
  ) => void,
): Promise<string> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      handler(req, res, body);
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}/v1`);
    });
  });
}

describe("OpenAI-compatible provider", () => {
  it("compacts older tool evidence while retaining the human goal and newest result", async () => {
    const captured: Array<Array<Record<string, unknown>>> = [];
    const baseUrl = await listen((_req, res, body) => {
      captured.push(body.messages as Array<Record<string, unknown>>);
      const round = captured.length;
      res.end(
        JSON.stringify({
          choices: [
            {
              message:
                round < 3
                  ? {
                      content: null,
                      tool_calls: [
                        {
                          id: `call-${round}`,
                          type: "function",
                          function: { name: "read", arguments: "{}" },
                        },
                      ],
                    }
                  : { content: '{"ok":true}' },
            },
          ],
        }),
      );
    });
    const provider = new OpenAICompatibleProvider(
      providerConfig(baseUrl, {
        apiKeyOptional: true,
        apiKeyEnv: undefined,
        capabilities: {
          structuredOutput: true,
          toolCalling: true,
          streaming: false,
          nonInteractive: true,
        },
      }),
      "test",
    );
    const compactions: Array<[number, number]> = [];
    let reads = 0;
    const result = await provider.complete({
      prompt: "Immutable human goal",
      system: "Keep the original requirements",
      expectJson: true,
      maxPromptChars: 12000,
      onContextCompacted: (before, after) => compactions.push([before, after]),
      tools: [
        {
          name: "read",
          description: "Read evidence",
          parameters: { type: "object" },
          execute: async () => ({ evidence: `${++reads}:` + "x".repeat(6500) }),
        },
      ],
    });
    expect(result.structured).toEqual({ ok: true });
    expect(compactions).toHaveLength(1);
    expect(compactions[0]![1]).toBeLessThan(compactions[0]![0]);
    expect(captured[2]![0]!.content).toBe("Keep the original requirements");
    expect(captured[2]![1]!.content).toBe("Immutable human goal");
    const evidence = captured[2]!.filter((message) => message.role === "tool");
    expect(JSON.parse(evidence[0]!.content as string)).toMatchObject({ compacted: true });
    expect(JSON.parse(evidence[1]!.content as string).evidence).toContain("2:");
  });

  it("builds the chat completions URL", () => {
    expect(completionsUrl("http://127.0.0.1:11434/v1")).toBe(
      "http://127.0.0.1:11434/v1/chat/completions",
    );
    expect(completionsUrl("http://127.0.0.1:11434/v1/chat/completions/")).toBe(
      "http://127.0.0.1:11434/v1/chat/completions",
    );
  });

  it("rejects oversized requests before contacting a quota-limited provider", async () => {
    let requests = 0;
    const baseUrl = await listen((_req, res) => {
      requests++;
      res.end("{}");
    });
    const provider = new OpenAICompatibleProvider(
      providerConfig(baseUrl, { apiKeyOptional: true, maxInputChars: 1000 }),
      "free-tier",
    );
    await expect(provider.complete({ prompt: "x".repeat(2000) })).rejects.toMatchObject({
      code: "context_limit",
    });
    expect(requests).toBe(0);
  });

  it("detects repeated read tools with unchanged arguments and evidence", async () => {
    const baseUrl = await listen((_req, res) => {
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "loop",
                    type: "function",
                    function: { name: "list_files", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        }),
      );
    });
    const provider = new OpenAICompatibleProvider(
      providerConfig(baseUrl, {
        apiKeyOptional: true,
        capabilities: {
          structuredOutput: true,
          toolCalling: true,
          streaming: false,
          nonInteractive: true,
        },
      }),
      "looping",
    );
    await expect(
      provider.complete({
        prompt: "implement",
        tools: [
          {
            name: "list_files",
            description: "list",
            parameters: {},
            execute: async () => ({ files: ["a.ts"] }),
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "tool_loop" });
  });

  it("sends the configured thinking toggle through native Ollama", async () => {
    let body: Record<string, unknown> = {};
    const baseUrl = await listen((_req, res, input) => {
      body = input;
      res.end(
        JSON.stringify({ model: "qwen3:4b", message: { content: '{"ok":true}' }, done: true }),
      );
    });
    const provider = new OpenAICompatibleProvider(
      providerConfig(baseUrl, { protocol: "ollama", thinking: false, apiKeyOptional: true }),
      "local",
    );
    expect(
      (await provider.complete({ prompt: "Return JSON", expectJson: true })).structured,
    ).toEqual({ ok: true });
    expect(body.think).toBe(false);
  });

  it("sends a bearer token, usage, and response_format only when JSON mode is actually enabled", async () => {
    const seen: Captured[] = [];
    const baseUrl = await listen((req, res, body) => {
      seen.push({ authorization: req.headers.authorization, body });
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          model: "fake-model",
          choices: [{ message: { content: '{"ok":true}' } }],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        }),
      );
    });
    const key = "sk-test-secret-value-123456";
    process.env.SWARM_TEST_OPENAI_KEY = key;
    try {
      const full = new OpenAICompatibleProvider(
        providerConfig(baseUrl),
        "ollama",
        createRedactor([key]),
      );
      const result = await full.complete({ prompt: "hi", system: "sys", expectJson: true });
      expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 4, totalTokens: 7 });
      expect(result.structured).toEqual({ ok: true });
      expect(seen[0]?.authorization).toBe(`Bearer ${key}`);
      expect(seen[0]?.body.response_format).toEqual({ type: "json_object" });

      const off = new OpenAICompatibleProvider(
        providerConfig(baseUrl, { jsonMode: "off" }),
        "ollama",
        createRedactor([key]),
      );
      await off.complete({ prompt: "hi", expectJson: true });
      expect(seen[1]?.body.response_format).toBeUndefined();

      const unstructured = new OpenAICompatibleProvider(
        providerConfig(baseUrl, {
          capabilities: {
            structuredOutput: false,
            toolCalling: false,
            streaming: false,
            nonInteractive: true,
          },
        }),
        "ollama",
        createRedactor([key]),
      );
      await unstructured.complete({ prompt: "hi", expectJson: true });
      expect(seen[2]?.body.response_format).toBeUndefined();

      await full.complete({ prompt: "plain", expectJson: false });
      expect(seen[3]?.body.response_format).toBeUndefined();
    } finally {
      delete process.env.SWARM_TEST_OPENAI_KEY;
    }
  });

  it("omits the authorization header when the key is optional and unset", async () => {
    const seen: Array<string | undefined> = [];
    const baseUrl = await listen((req, res) => {
      seen.push(req.headers.authorization);
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    });
    delete process.env.SWARM_TEST_OPENAI_KEY;
    const provider = new OpenAICompatibleProvider(
      providerConfig(baseUrl, { apiKeyOptional: true, jsonMode: "off" }),
      "ollama",
    );
    const result = await provider.complete({ prompt: "hi", expectJson: false });
    expect(result.text).toBe("ok");
    expect(seen).toEqual([undefined]);
  });

  it("redacts a key echoed by a non-2xx response and rejects malformed JSON", async () => {
    const key = "sk-test-secret-value-123456";
    let mode: "error" | "bad" = "error";
    const baseUrl = await listen((_req, res) => {
      if (mode === "error") {
        res.statusCode = 500;
        res.end(`upstream said ${key}`);
        return;
      }
      res.end("not-json");
    });
    const provider = new OpenAICompatibleProvider(
      providerConfig(baseUrl),
      "ollama",
      createRedactor([key]),
    );
    process.env.SWARM_TEST_OPENAI_KEY = key;
    try {
      await expect(provider.complete({ prompt: "hi" })).rejects.toMatchObject({
        code: "http",
        retryable: true,
      });
      try {
        await provider.complete({ prompt: "hi" });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        expect(message).not.toContain(key);
        expect(message).toContain("[REDACTED]");
      }
      mode = "bad";
      await expect(provider.complete({ prompt: "hi" })).rejects.toMatchObject({
        code: "malformed",
      });
    } finally {
      delete process.env.SWARM_TEST_OPENAI_KEY;
    }
  });

  it("respects a short rate-limit cooldown and records the retry", async () => {
    let calls = 0;
    const baseUrl = await listen((_req, res) => {
      calls++;
      if (calls === 1) {
        res.statusCode = 429;
        res.setHeader("retry-after", "0.01");
        res.end('{"error":"rate limited"}');
      } else res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
    });
    const observations: Array<{ error?: string }> = [];
    const provider = new OpenAICompatibleProvider(
      providerConfig(baseUrl, { apiKeyOptional: true }),
      "groq",
    );
    const result = await provider.complete({
      prompt: "Return JSON",
      expectJson: true,
      onCall: (call) => observations.push(call),
    });
    expect(result.structured).toEqual({ ok: true });
    expect(calls).toBe(2);
    expect(observations).toHaveLength(2);
    expect(observations[0]?.error).toContain("HTTP 429");
    expect(observations[1]?.error).toBeUndefined();
  });

  it("stops after two rate-limit retries", async () => {
    let calls = 0;
    const baseUrl = await listen((_req, res) => {
      calls++;
      res.statusCode = 429;
      res.setHeader("retry-after", "0");
      res.end("rate limited");
    });
    const provider = new OpenAICompatibleProvider(
      providerConfig(baseUrl, { apiKeyOptional: true }),
      "groq",
    );
    await expect(provider.complete({ prompt: "hi" })).rejects.toMatchObject({
      code: "http",
      retryable: true,
    });
    expect(calls).toBe(3);
  });

  it("maps abort and timeout and refuses a missing required key", async () => {
    const baseUrl = await listen((_req, res) => {
      setTimeout(() => {
        res.end(JSON.stringify({ choices: [{ message: { content: "late" } }] }));
      }, 2_000);
    });
    delete process.env.SWARM_TEST_OPENAI_KEY;
    const missing = new OpenAICompatibleProvider(providerConfig(baseUrl), "ollama");
    await expect(missing.complete({ prompt: "hi" })).rejects.toMatchObject({
      code: "missing_secret",
    });

    process.env.SWARM_TEST_OPENAI_KEY = "sk-test-secret-value-123456";
    try {
      const slow = new OpenAICompatibleProvider(
        providerConfig(baseUrl, { timeoutMs: 80 }),
        "ollama",
      );
      await expect(slow.complete({ prompt: "hi" })).rejects.toMatchObject({
        code: "timeout",
        retryable: true,
      });
      const controller = new AbortController();
      const hanging = new OpenAICompatibleProvider(
        providerConfig(baseUrl, { timeoutMs: 5_000 }),
        "ollama",
      );
      const pending = hanging.complete({ prompt: "hi", signal: controller.signal });
      controller.abort();
      await expect(pending).rejects.toBeInstanceOf(SwarmError);
    } finally {
      delete process.env.SWARM_TEST_OPENAI_KEY;
    }
  });

  it("dispatches a custom driver without changing the scheduler", async () => {
    registerProviderBuilder("echo-driver", (_config, context) => ({
      name: context.name,
      capabilities: {
        structuredOutput: false,
        toolCalling: false,
        streaming: false,
        nonInteractive: true,
      },
      complete: async () => ({ text: "from-custom", provider: context.name }),
    }));
    const provider = createProvider(
      "custom-a",
      {
        type: "custom",
        driver: "echo-driver",
        options: {},
        timeoutMs: 1_000,
        capabilities: {
          structuredOutput: false,
          toolCalling: false,
          streaming: false,
          nonInteractive: true,
        },
      },
      (text) => text,
    );
    await expect(provider.complete({ prompt: "hi" })).resolves.toMatchObject({
      text: "from-custom",
    });
    expect(() =>
      createProvider(
        "missing",
        {
          type: "custom",
          driver: "not-registered",
          options: {},
          timeoutMs: 1_000,
          capabilities: {
            structuredOutput: false,
            toolCalling: false,
            streaming: false,
            nonInteractive: true,
          },
        },
        (text) => text,
      ),
    ).toThrow(/registerProviderBuilder/);
  });
});
