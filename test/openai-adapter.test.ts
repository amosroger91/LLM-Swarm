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
  it("builds the chat completions URL", () => {
    expect(completionsUrl("http://127.0.0.1:11434/v1")).toBe(
      "http://127.0.0.1:11434/v1/chat/completions",
    );
    expect(completionsUrl("http://127.0.0.1:11434/v1/chat/completions/")).toBe(
      "http://127.0.0.1:11434/v1/chat/completions",
    );
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
