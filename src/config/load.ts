import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import { SwarmError, errorMessage } from "../errors.js";
import { SwarmConfigSchema, type SwarmConfig } from "./schema.js";

const ollamaCapabilities = {
  structuredOutput: true,
  toolCalling: false,
  streaming: false,
  nonInteractive: true,
};

export function defaultConfig(): SwarmConfig {
  return SwarmConfigSchema.parse({
    providers: {
      ollama: {
        type: "openai_compatible",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "qwen2.5-coder:7b",
        apiKeyEnv: "OLLAMA_API_KEY",
        apiKeyOptional: true,
        jsonMode: "json_object",
        capabilities: ollamaCapabilities,
      },
    },
    agents: {
      "ollama-planner": { role: "planner", provider: "ollama" },
      "ollama-worker": { role: "worker", provider: "ollama" },
      "ollama-reviewer": { role: "reviewer", provider: "ollama" },
    },
    profiles: {
      default: {
        planner: "ollama-planner",
        worker: "ollama-worker",
        reviewer: "ollama-reviewer",
        workerCount: 2,
      },
    },
  });
}

export function loadConfig(filePath?: string): SwarmConfig {
  const selected = filePath ?? process.env.SWARM_CONFIG;
  if (!selected) return defaultConfig();
  const absolute = path.resolve(selected);
  let text: string;
  try {
    text = fs.readFileSync(absolute, "utf8");
  } catch (error) {
    throw new SwarmError(`Cannot read config ${absolute}: ${errorMessage(error)}`, "bad_config");
  }
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    const position = (error as { linePos?: Array<{ line: number; col: number }> }).linePos?.[0];
    throw new SwarmError(
      `Config ${absolute} is not valid YAML${position ? ` at line ${position.line}, column ${position.col}` : ""}. Check its syntax.`,
      "bad_config",
    );
  }
  // Accept credentials in an ignored local config, but never snapshot their values.
  // The provider receives only an environment-variable reference in SQLite.
  if (raw && typeof raw === "object" && "providers" in raw) {
    const providers = (raw as { providers?: unknown }).providers;
    if (providers && typeof providers === "object") {
      for (const [name, value] of Object.entries(providers)) {
        if (!value || typeof value !== "object") continue;
        const provider = value as Record<string, unknown>;
        const explicitKey =
          typeof provider.apiKey === "string" ? provider.apiKey.trim() : undefined;
        if (typeof provider.apiKey === "string") delete provider.apiKey;
        const literal = explicitKey
          ? explicitKey
          : typeof provider.apiKeyEnv === "string" &&
              /^(?:sk-or-|nvapi-|gsk_)/.test(provider.apiKeyEnv)
            ? provider.apiKeyEnv
            : undefined;
        if (!literal) continue;
        const slot =
          typeof provider.apiKeyEnv === "string" &&
          /^[A-Za-z_][A-Za-z0-9_]*$/.test(provider.apiKeyEnv)
            ? provider.apiKeyEnv
            : `SWARM_INLINE_${createHash("sha256").update(`${absolute}:${name}`).digest("hex").slice(0, 16).toUpperCase()}_API_KEY`;
        process.env[slot] = literal;
        provider.apiKeyEnv = slot;
        delete provider.apiKey;
      }
    }
  }
  const parsed = SwarmConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new SwarmError(`Config ${absolute} is invalid: ${details}`, "bad_config");
  }
  const baseDir = path.dirname(absolute);
  return {
    ...parsed.data,
    dataDir: path.resolve(baseDir, expandHome(parsed.data.dataDir)),
    database: parsed.data.database
      ? path.resolve(baseDir, expandHome(parsed.data.database))
      : undefined,
  };
}

/** `~/x` means the user's home directory, so one data directory can serve every project. */
export function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\"))
    return path.join(os.homedir(), value.slice(2));
  return value;
}

export function databasePath(config: SwarmConfig): string {
  return config.database ?? path.join(path.resolve(config.dataDir), "swarm.db");
}
