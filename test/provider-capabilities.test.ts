import { afterEach, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config/load.js";
import { negotiateOllamaCapabilities } from "../src/providers/capabilities.js";
afterEach(() => vi.unstubAllGlobals());
it("uses the selected model's advertised tool support without replacing it", async () => {
  const c = defaultConfig();
  const p = c.providers.ollama!;
  if (p.type !== "openai_compatible") throw new Error("fixture");
  p.protocol = "ollama";
  p.model = "qwen2.5-coder:1.5b-base";
  p.capabilities.toolCalling = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ capabilities: ["completion", "insert"] }), { status: 200 }),
    ),
  );
  expect(await negotiateOllamaCapabilities(c)).toHaveLength(1);
  expect(p.model).toBe("qwen2.5-coder:1.5b-base");
  expect(p.capabilities.toolCalling).toBe(false);
});
