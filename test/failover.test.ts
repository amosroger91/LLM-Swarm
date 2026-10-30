import { describe, expect, it } from "vitest";
import { SwarmError } from "../src/errors.js";
import { FailoverProvider, type FailoverCandidate } from "../src/providers/failover.js";
import type { AgentProvider } from "../src/providers/types.js";
import { defaultConfig } from "../src/config/load.js";
import { SwarmConfigSchema } from "../src/config/schema.js";
import { jsonResponse } from "./helpers.js";

const capabilities = {
  toolCalling: true,
  structuredOutput: true,
  streaming: false,
  nonInteractive: true,
};
function agent(name: string, run: AgentProvider["complete"]): AgentProvider {
  return { name, model: name, capabilities, complete: run };
}
function candidate(provider: AgentProvider): FailoverCandidate {
  return {
    name: provider.name,
    model: provider.model,
    timeoutMs: 1000,
    toolCalling: true,
    fileEditing: true,
    create: () => provider,
  };
}
function chain(providers: AgentProvider[], cooldowns = new Map<string, number>()) {
  return new FailoverProvider(providers[0]!, providers.map(candidate), cooldowns, (text) =>
    text.replaceAll("secret-value", "[REDACTED]"),
  );
}
const broken = (name: string) =>
  agent(name, async () => {
    throw new SwarmError("provider unavailable secret-value", "http", true);
  });

describe("provider failover", () => {
  it("never invokes a candidate denied by the local/free cost policy", async () => {
    let paidCalls = 0;
    const paid = agent("paid", async () => {
      paidCalls++;
      return jsonResponse({});
    });
    const free = agent("free", async () => jsonResponse({ ok: true }));
    const provider = new FailoverProvider(
      paid,
      [
        { ...candidate(paid), costAllowed: false },
        { ...candidate(free), costAllowed: true },
      ],
      new Map(),
      (text) => text,
    );
    expect((await provider.complete({ prompt: "goal" })).structured).toEqual({ ok: true });
    expect(paidCalls).toBe(0);
    const denied = new FailoverProvider(
      paid,
      [{ ...candidate(paid), costAllowed: false }],
      new Map(),
      (text) => text,
    );
    await expect(denied.complete({ prompt: "goal" })).rejects.toThrow(
      "local/free-only cost policy",
    );
    expect(paidCalls).toBe(0);
  });
  it("tries another model, then another provider, and reports actual provider usage", async () => {
    const calls: string[] = [];
    const switches: Array<{ from: string; to: string | null; reason: string }> = [];
    const success = agent("groq-backup", async (request) => {
      expect(request.cwd).toBe("assigned-worktree");
      expect(request.prompt).toContain("Inspect current files");
      return { ...jsonResponse({ ok: true }), provider: "groq-backup", model: "backup-model" };
    });
    const result = await chain([broken("local-a"), broken("local-b"), success]).complete({
      prompt: "original goal",
      cwd: "assigned-worktree",
      onCall: (call) => calls.push(call.provider),
      onFailover: (event) => switches.push(event),
    });
    expect(result.provider).toBe("groq-backup");
    expect(calls).toEqual(["local-a", "local-b", "groq-backup"]);
    expect(switches.map((event) => event.to)).toEqual(["local-b", "groq-backup"]);
    expect(JSON.stringify(switches)).not.toContain("secret-value");
  });

  it("reserves time for a backup when the first provider hangs", async () => {
    const stalled = agent("stalled", () => new Promise(() => {}));
    const backup = agent("backup", async () => jsonResponse({ ok: true }));
    const result = await chain([stalled, backup]).complete({ prompt: "goal", totalTimeoutMs: 100 });
    expect(result.structured).toEqual({ ok: true });
  });

  it("does not switch providers after cancellation or a safety rejection", async () => {
    let backups = 0;
    const backup = agent("backup", async () => {
      backups++;
      return jsonResponse({});
    });
    const cancel = new AbortController();
    const primary = agent("primary", async () => {
      cancel.abort();
      throw new SwarmError("cancel", "cancelled");
    });
    await expect(
      chain([primary, backup]).complete({ prompt: "goal", signal: cancel.signal }),
    ).rejects.toBeDefined();
    const unsafe = agent("unsafe", async () => {
      throw new SwarmError("outside workspace", "unsafe_path");
    });
    await expect(chain([unsafe, backup]).complete({ prompt: "goal" })).rejects.toMatchObject({
      code: "unsafe_path",
    });
    expect(backups).toBe(0);
  });

  it("fails visibly after exhausting the chain and cools down failed providers", async () => {
    let calls = 0;
    const primary = agent("primary", async () => {
      calls++;
      throw new SwarmError("timeout", "timeout");
    });
    const fallback = agent("fallback", async () => {
      calls++;
      throw new SwarmError("missing", "missing_secret");
    });
    const provider = chain([primary, fallback]);
    await expect(provider.complete({ prompt: "goal" })).rejects.toMatchObject({
      code: "providers_exhausted",
    });
    await expect(provider.complete({ prompt: "goal" })).rejects.toThrow("cooling down");
    expect(calls).toBe(2);
  });

  it("validates the final response contract before accepting a backup", async () => {
    const invalid = agent("invalid", async () => jsonResponse({ intention: "read more" }));
    const valid = agent("valid", async () => jsonResponse({ ok: true }));
    const result = await chain([invalid, valid]).complete({
      prompt: "goal",
      validateResponse: (response) => {
        if (!(response.structured as { ok?: boolean }).ok)
          throw new SwarmError("invalid contract", "malformed", true);
      },
    });
    expect(result.structured).toEqual({ ok: true });
  });

  it("waits for pending tools before starting a replacement in the same worktree", async () => {
    let edited = false;
    const primary = agent("primary", async (request) => {
      void request.tools![0]!.execute({});
      throw new SwarmError("lost connection", "http", true);
    });
    const backup = agent("backup", async () => {
      expect(edited).toBe(true);
      return jsonResponse({ ok: true });
    });
    await chain([primary, backup]).complete({
      prompt: "goal",
      tools: [
        {
          name: "write_file",
          description: "fixture",
          parameters: {},
          execute: async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            edited = true;
          },
        },
      ],
    });
  });

  it("skips a backup that cannot maintain required editing capabilities", async () => {
    let invoked = false;
    const primary = broken("primary");
    const patchOnly = agent("patch-only", async () => {
      invoked = true;
      return jsonResponse({});
    });
    const candidates = [
      candidate(primary),
      { ...candidate(patchOnly), fileEditing: false, toolCalling: false },
    ];
    const provider = new FailoverProvider(primary, candidates, new Map(), (text) => text);
    await expect(
      provider.complete({
        prompt: "goal",
        tools: [{ name: "write", description: "", parameters: {}, execute: async () => {} }],
      }),
    ).rejects.toThrow("file-editing capability");
    expect(invoked).toBe(false);
  });

  it("rejects missing and repeated fallback configuration", () => {
    for (const fallbackProviders of [["missing"], ["ollama"], ["backup", "backup"]]) {
      const config = defaultConfig();
      config.providers.backup = config.providers.ollama!;
      config.agents["ollama-worker"]!.fallbackProviders = fallbackProviders;
      expect(SwarmConfigSchema.safeParse(config).success).toBe(false);
    }
  });
});
