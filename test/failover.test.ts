import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";
import { SwarmConfigSchema } from "../src/config/schema.js";
import { SwarmError } from "../src/errors.js";
import { FailoverProvider } from "../src/providers/failover.js";
import { ProviderHealth, classifyFailure } from "../src/providers/health.js";
import { parseProviderOutput } from "../src/providers/parse.js";
import type { AgentProvider, ProviderResponse } from "../src/providers/types.js";
import { projectRoot } from "./helpers.js";
import path from "node:path";

const capabilities = {
  structuredOutput: true,
  toolCalling: false,
  streaming: false,
  nonInteractive: true,
};

function member(name: string, behave: () => ProviderResponse | Promise<ProviderResponse>) {
  const calls: string[] = [];
  const provider: AgentProvider & { calls: string[] } = {
    name,
    capabilities,
    calls,
    async complete() {
      calls.push(name);
      return behave();
    },
  };
  return provider;
}

const ok = (provider: string): ProviderResponse => ({ text: "ok", provider });
const rateLimited = () =>
  new SwarmError("HTTP 429: slow down", "http", true, { status: 429, retryAfterMs: 30_000 });

describe("failure classification", () => {
  it("separates exhaustion, outages, bad output, and cancellation", () => {
    expect(classifyFailure(rateLimited())).toBe("exhausted");
    expect(classifyFailure(new SwarmError("x", "http", false, { status: 402 }))).toBe("exhausted");
    expect(classifyFailure(new SwarmError("Claude AI usage limit reached", "exit", true))).toBe(
      "exhausted",
    );
    expect(classifyFailure(new SwarmError("RESOURCE_EXHAUSTED", "http", true))).toBe("exhausted");
    expect(classifyFailure(new SwarmError("no key", "missing_secret"))).toBe("unavailable");
    expect(classifyFailure(new SwarmError("x", "http", false, { status: 401 }))).toBe(
      "unavailable",
    );
    expect(classifyFailure(new SwarmError("not json", "malformed", true))).toBe("output");
    expect(classifyFailure(new SwarmError("boom", "http", true, { status: 503 }))).toBe(
      "transient",
    );
    expect(classifyFailure(new SwarmError("stop", "cancelled"))).toBe("cancelled");
  });
});

describe("FailoverProvider", () => {
  it("serves from the next provider when the primary is rate limited, then skips it while it cools", async () => {
    let now = 1_000_000;
    const health = new ProviderHealth(() => now);
    const primary = member("local", () => {
      throw rateLimited();
    });
    const backup = member("free", () => ok("free"));
    const chain = new FailoverProvider([primary, backup], health);

    const first = await chain.complete({ prompt: "x" });
    expect(first.provider).toBe("free");
    expect(first.failover).toEqual([
      expect.objectContaining({ provider: "local", kind: "exhausted" }),
    ]);
    expect(health.snapshot(["local"])[0]).toMatchObject({ state: "cooling", failures: 1 });

    const second = await chain.complete({ prompt: "x" });
    expect(second.failover).toBeUndefined();
    expect(primary.calls).toHaveLength(1);

    now += 31_000; // Retry-After elapsed
    await chain.complete({ prompt: "x" });
    expect(primary.calls).toHaveLength(2);
  });

  it("starts a task retry on a different model", async () => {
    const health = new ProviderHealth();
    const a = member("a", () => ok("a"));
    const b = member("b", () => ok("b"));
    const c = member("c", () => ok("c"));
    const chain = new FailoverProvider([a, b, c], health);
    expect((await chain.complete({ prompt: "x", metadata: { attempt: "1" } })).provider).toBe("a");
    expect((await chain.complete({ prompt: "x", metadata: { attempt: "2" } })).provider).toBe("b");
    expect((await chain.complete({ prompt: "x", metadata: { attempt: "4" } })).provider).toBe("a");
  });

  it("still tries cooling members last rather than failing without asking", async () => {
    const health = new ProviderHealth(() => 0);
    health.failure("a", rateLimited());
    const a = member("a", () => ok("a"));
    const b = member("b", () => {
      throw new SwarmError("down", "http", true, { status: 503 });
    });
    const served = await new FailoverProvider([a, b], health).complete({ prompt: "x" });
    expect(served.provider).toBe("a");
    expect(b.calls).toHaveLength(1);
  });

  it("reports every failure when the whole chain fails and never fails over a cancellation", async () => {
    const health = new ProviderHealth();
    const chain = new FailoverProvider(
      [
        member("a", () => {
          throw rateLimited();
        }),
        member("b", () => {
          throw new SwarmError("bad json", "malformed", true);
        }),
      ],
      health,
    );
    await expect(chain.complete({ prompt: "x" })).rejects.toThrow(
      /All 2 providers failed: a \(exhausted\).*b \(output\)/,
    );

    const after = member("after", () => ok("after"));
    const cancelled = new FailoverProvider(
      [
        member("first", () => {
          throw new SwarmError("stop", "cancelled");
        }),
        after,
      ],
      new ProviderHealth(),
    );
    await expect(cancelled.complete({ prompt: "x" })).rejects.toThrow("stop");
    expect(after.calls).toHaveLength(0);
  });

  it("rethrows the original error for a single provider", async () => {
    const error = new SwarmError("nope", "malformed", true);
    const single = new FailoverProvider([member("solo", () => Promise.reject(error))]);
    await expect(single.complete({ prompt: "x" })).rejects.toBe(error);
  });
});

describe("claude-json parser", () => {
  it("extracts the result, structured JSON, and usage", () => {
    const parsed = parseProviderOutput(
      "claude-json",
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: '```json\n{"goal":"g"}\n```',
        usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 },
      }),
      "",
    );
    expect(parsed.structured).toEqual({ goal: "g" });
    expect(parsed.usage).toEqual({ inputTokens: 100, outputTokens: 5, totalTokens: 105 });
  });

  it("turns an error envelope into an exhaustion the router understands", () => {
    let thrown: unknown;
    try {
      parseProviderOutput(
        "claude-json",
        JSON.stringify({ type: "result", is_error: true, result: "Claude AI usage limit reached" }),
        "",
      );
    } catch (error) {
      thrown = error;
    }
    expect(classifyFailure(thrown)).toBe("exhausted");
  });
});

describe("fallback configuration", () => {
  const base = {
    providers: {
      tools: {
        type: "openai_compatible",
        baseUrl: "http://127.0.0.1:1/v1",
        model: "m",
        apiKeyOptional: true,
        capabilities: { ...capabilities, toolCalling: true },
      },
      plain: {
        type: "openai_compatible",
        baseUrl: "http://127.0.0.1:2/v1",
        model: "m",
        apiKeyOptional: true,
        capabilities,
      },
    },
  };

  it("rejects a worker fallback that edits files differently, but lets planners mix", () => {
    const worker = SwarmConfigSchema.safeParse({
      ...base,
      agents: { w: { role: "worker", provider: "tools", fallbacks: ["plain"] } },
    });
    expect(worker.success).toBe(false);
    expect(JSON.stringify(worker.error?.issues)).toContain("does not match");
    const planner = SwarmConfigSchema.safeParse({
      ...base,
      agents: { p: { role: "planner", provider: "tools", fallbacks: ["plain"] } },
    });
    expect(planner.success).toBe(true);
    const unknown = SwarmConfigSchema.safeParse({
      ...base,
      agents: { p: { role: "planner", provider: "tools", fallbacks: ["missing"] } },
    });
    expect(unknown.success).toBe(false);
  });

  it("ships a valid hybrid config", () => {
    const config = loadConfig(path.join(projectRoot, "config", "hybrid.yaml"));
    expect(config.defaultProfile).toBe("hybrid");
    expect(config.agents.planner!.provider).toBe("claude");
    expect(config.agents.worker!.fallbacks.length).toBeGreaterThan(0);
    expect(path.isAbsolute(config.dataDir)).toBe(true);
  });
});
