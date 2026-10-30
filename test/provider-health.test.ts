import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";
import { SwarmError } from "../src/errors.js";
import { FailoverProvider, type FailoverCandidate } from "../src/providers/failover.js";
import { ProviderHealth, classifyFailure } from "../src/providers/health.js";
import { parseProviderOutput } from "../src/providers/parse.js";
import type { AgentProvider } from "../src/providers/types.js";
import { jsonResponse, projectRoot } from "./helpers.js";

const capabilities = {
  structuredOutput: true,
  toolCalling: false,
  streaming: false,
  nonInteractive: true,
};

function member(name: string, run: AgentProvider["complete"]) {
  const calls: string[] = [];
  const provider: AgentProvider & { calls: string[] } = {
    name,
    model: name,
    capabilities,
    calls,
    complete: (request) => {
      calls.push(name);
      return run(request);
    },
  };
  return provider;
}

function candidate(provider: AgentProvider): FailoverCandidate {
  return {
    name: provider.name,
    model: provider.model,
    timeoutMs: 1000,
    toolCalling: false,
    fileEditing: false,
    create: () => provider,
  };
}

function chain(providers: AgentProvider[], health: ProviderHealth, cooldowns = new Map()) {
  return new FailoverProvider(
    providers[0]!,
    providers.map(candidate),
    cooldowns,
    (text) => text,
    health,
  );
}

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

describe("failover cooldowns and rotation", () => {
  it("honours Retry-After for a rate-limited provider, then uses it again", async () => {
    let now = 1_000_000;
    const health = new ProviderHealth(() => now);
    const cooldowns = new Map<string, number>();
    const realNow = Date.now;
    Date.now = () => now;
    try {
      let limited = true;
      const primary = member("local", async () => {
        if (limited) throw rateLimited();
        return jsonResponse({ by: "local" });
      });
      const backup = member("free", async () => jsonResponse({ by: "free" }));
      const provider = chain([primary, backup], health, cooldowns);
      expect((await provider.complete({ prompt: "x" })).structured).toEqual({ by: "free" });
      expect(cooldowns.get("local:local")).toBe(now + 30_000);
      expect(health.snapshot(["local"])[0]).toMatchObject({ state: "cooling", failures: 1 });

      await provider.complete({ prompt: "x" });
      expect(primary.calls).toHaveLength(1);

      limited = false;
      now += 31_000;
      expect((await provider.complete({ prompt: "x" })).structured).toEqual({ by: "local" });
      expect(health.snapshot(["local"])[0]).toMatchObject({ state: "healthy" });
    } finally {
      Date.now = realNow;
    }
  });

  it("benches a missing key for an hour but bad output only briefly", async () => {
    const health = new ProviderHealth();
    const cooldowns = new Map<string, number>();
    const noKey = member("keyless", async () => {
      throw new SwarmError("no key", "missing_secret");
    });
    const sloppy = member("sloppy", async () => {
      throw new SwarmError("not json", "malformed", true);
    });
    const good = member("good", async () => jsonResponse({}));
    await chain([noKey, sloppy, good], health, cooldowns).complete({ prompt: "x" });
    expect(cooldowns.get("keyless:keyless")! - Date.now()).toBeGreaterThan(59 * 60_000);
    expect(cooldowns.get("sloppy:sloppy")! - Date.now()).toBeLessThanOrEqual(15_000);
  });

  it("fails over a CLI that exited at its usage limit", async () => {
    const claude = member("claude", async () => {
      throw new SwarmError("CLI provider claude exited 1: usage limit reached", "exit", true);
    });
    const backup = member("backup", async () => jsonResponse({ ok: true }));
    const result = await chain([claude, backup], new ProviderHealth()).complete({ prompt: "x" });
    expect(result.structured).toEqual({ ok: true });
  });

  it("starts a task retry on a different model", async () => {
    const providers = ["a", "b", "c"].map((name) =>
      member(name, async () => ({ ...jsonResponse({}), provider: name })),
    );
    const provider = chain(providers, new ProviderHealth());
    const servedBy = async (attempt: string) =>
      (await provider.complete({ prompt: "x", metadata: { attempt } })).provider;
    expect(await servedBy("1")).toBe("a");
    expect(await servedBy("2")).toBe("b");
    expect(await servedBy("4")).toBe("a");
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

it("ships a valid hybrid config", () => {
  const config = loadConfig(path.join(projectRoot, "config", "hybrid.yaml"));
  expect(config.defaultProfile).toBe("hybrid");
  expect(config.agents.planner!.provider).toBe("claude");
  expect(config.agents.worker!.fallbackProviders?.length).toBeGreaterThan(0);
  expect(path.isAbsolute(config.dataDir)).toBe(true);
});
