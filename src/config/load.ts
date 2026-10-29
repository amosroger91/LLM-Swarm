import fs from "node:fs";
import path from "node:path";
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
    throw new SwarmError(
      `Config ${absolute} is not valid YAML: ${errorMessage(error)}`,
      "bad_config",
    );
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
    dataDir: path.resolve(baseDir, parsed.data.dataDir),
    database: parsed.data.database ? path.resolve(baseDir, parsed.data.database) : undefined,
  };
}

export function databasePath(config: SwarmConfig): string {
  return config.database ?? path.join(path.resolve(config.dataDir), "swarm.db");
}
