import type { SwarmConfig } from "../config/schema.js";

/** Negotiate the active Ollama profile without changing its model or saved YAML. */
export async function negotiateOllamaCapabilities(config: SwarmConfig): Promise<string[]> {
  const profile = config.profiles[config.defaultProfile];
  if (!profile) return [];
  const names = new Set(
    [profile.planner, profile.worker, profile.reviewer].flatMap((name) => [
      config.agents[name]?.provider,
      ...(config.agents[name]?.fallbackProviders ?? []),
    ]),
  );
  const adjusted: string[] = [];
  for (const name of names) {
    const provider = name ? config.providers[name] : undefined;
    if (
      !provider ||
      provider.type !== "openai_compatible" ||
      provider.protocol !== "ollama" ||
      !provider.capabilities.toolCalling
    )
      continue;
    try {
      const origin = new URL(provider.baseUrl).origin;
      const key = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined;
      const response = await fetch(`${origin}/api/show`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({ model: provider.model }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) continue;
      const result = (await response.json()) as { capabilities?: string[] };
      if (Array.isArray(result.capabilities) && !result.capabilities.includes("tools")) {
        provider.capabilities = { ...provider.capabilities, toolCalling: false };
        adjusted.push(`${name}: ${provider.model} reports no tool support; using patch responses`);
      }
    } catch {
      /* A capability probe is optional; actual calls retain normal error handling. */
    }
  }
  return adjusted;
}
