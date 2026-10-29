import type { ProviderConfig } from "../config/schema.js";
import { SwarmError } from "../errors.js";
import { CliProvider } from "./cli.js";
import { OpenAICompatibleProvider } from "./openai.js";
import type { AgentProvider } from "./types.js";

export interface ProviderBuildContext {
  name: string;
  redact: (text: string) => string;
}

export type ProviderBuilder = (
  config: ProviderConfig,
  context: ProviderBuildContext,
) => AgentProvider;

const builders = new Map<string, ProviderBuilder>();

export function registerProviderBuilder(driver: string, builder: ProviderBuilder): void {
  builders.set(driver, builder);
}

export function createProvider(
  name: string,
  config: ProviderConfig,
  redact: (text: string) => string,
): AgentProvider {
  if (config.type === "openai_compatible") {
    return new OpenAICompatibleProvider(config, name, redact);
  }
  if (config.type === "cli") {
    return new CliProvider(config, name, redact);
  }
  const builder = builders.get(config.driver);
  if (!builder) {
    throw new SwarmError(
      `No provider builder is registered for custom driver ${config.driver}. Call registerProviderBuilder without changing the scheduler.`,
      "unknown_provider",
    );
  }
  return builder(config, { name, redact });
}
