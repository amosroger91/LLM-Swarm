import { z } from "zod";
import { SwarmError } from "../errors.js";

export const CapabilitiesSchema = z
  .object({
    structuredOutput: z.boolean(),
    toolCalling: z.boolean(),
    streaming: z.boolean(),
    nonInteractive: z.boolean(),
  })
  .strict();

export type ProviderCapabilities = z.infer<typeof CapabilitiesSchema>;

const OpenAIProviderSchema = z
  .object({
    type: z.literal("openai_compatible"),
    costClass: z.enum(["local", "free", "metered", "unknown"]).optional(),
    maxInputChars: z.number().int().min(1000).max(1000000).optional(),
    baseUrl: z.string().url(),
    model: z.string().min(1),
    apiKeyEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .optional(),
    apiKeyOptional: z.boolean().default(false),
    timeoutMs: z.number().int().positive().max(3_600_000).default(120_000),
    jsonMode: z.enum(["off", "json_object"]).default("off"),
    temperature: z.number().min(0).max(2).optional(),
    maxToolRounds: z.number().int().min(1).max(100).optional(),
    maxOutputTokens: z.number().int().positive().max(100000).optional(),
    protocol: z.enum(["openai", "ollama"]).optional(),
    thinking: z.boolean().optional(),
    contextTokens: z.number().int().min(2048).max(262144).optional(),
    capabilities: CapabilitiesSchema,
  })
  .strict();

const CliProviderSchema = z
  .object({
    type: z.literal("cli"),
    costClass: z.enum(["local", "free", "metered", "unknown"]).optional(),
    command: z.string().min(1),
    fileEditing: z.boolean().optional(),
    args: z.array(z.string()).max(100),
    promptTransport: z.enum(["argv", "stdin", "file"]).default("argv"),
    outputParser: z
      .enum(["text", "json", "fenced-json", "grok-json", "opencode-events", "gemini-json"])
      .default("fenced-json"),
    timeoutMs: z.number().int().positive().max(3_600_000).default(300_000),
    capabilities: CapabilitiesSchema,
    envPass: z
      .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
      .max(50)
      .default([]),
    maxStdoutBytes: z.number().int().positive().max(20_000_000).default(1_000_000),
    documentedStatus: z.enum(["help-checked", "unverified"]).default("unverified"),
    notes: z.string().max(4000).default(""),
  })
  .strict();

const CustomProviderSchema = z
  .object({
    type: z.literal("custom"),
    costClass: z.enum(["local", "free", "metered", "unknown"]).optional(),
    driver: z.string().min(1).max(100),
    options: z.record(z.string(), z.unknown()).default({}),
    capabilities: CapabilitiesSchema,
    timeoutMs: z.number().int().positive().max(3_600_000).default(120_000),
  })
  .strict();

export const ProviderConfigSchema = z.discriminatedUnion("type", [
  OpenAIProviderSchema,
  CliProviderSchema,
  CustomProviderSchema,
]);

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type OpenAIProviderConfig = z.infer<typeof OpenAIProviderSchema>;
export type CliProviderConfig = z.infer<typeof CliProviderSchema>;
export type CustomProviderConfig = z.infer<typeof CustomProviderSchema>;

const AgentSchema = z
  .object({
    role: z.enum(["planner", "worker", "reviewer"]),
    provider: z.string().min(1),
    fallbackProviders: z.array(z.string().min(1)).max(4).optional(),
    systemPrompt: z.string().max(20_000).optional(),
  })
  .strict();

const ProfileSchema = z
  .object({
    planner: z.string().min(1),
    worker: z.string().min(1),
    reviewer: z.string().min(1),
    workerCount: z.number().int().positive().optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();

const CheckSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).max(50).default([]),
  })
  .strict();

export const SwarmConfigSchema = z
  .object({
    dataDir: z.string().min(1).default(".swarm-data"),
    database: z.string().min(1).optional(),
    defaultProfile: z.string().min(1).default("default"),
    costPolicy: z.enum(["configured", "local_or_free"]).default("configured"),
    defaultWorkerCount: z.number().int().positive().default(2),
    maxWorkerCount: z.number().int().positive().default(5),
    allowWorkerCountAboveDefault: z.boolean().default(false),
    defaultMaxAttempts: z.number().int().positive().max(10).default(2),
    maxReviewRounds: z.number().int().positive().max(10).default(3),
    jobTimeoutMs: z.number().int().positive().default(1_800_000),
    providerTimeoutMs: z.number().int().positive().default(120_000),
    agentTimeoutMs: z.number().int().positive().max(3600000).default(900000),
    maxPromptChars: z.number().int().positive().default(80_000),
    maxResponseChars: z.number().int().positive().default(200_000),
    maxMessageChars: z.number().int().positive().default(16_000),
    maxDiffChars: z.number().int().positive().default(50_000),
    logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
    writeSnapshot: z.boolean().default(true),
    requireChecks: z.boolean().default(true),
    recovery: z
      .object({
        enabled: z.boolean().default(true),
        maxAssistsPerTask: z.number().int().min(0).max(3).default(1),
        stallWarningMs: z.number().int().min(100).default(60000),
      })
      .prefault({}),
    maintenance: z
      .object({
        enabled: z.boolean().default(true),
        intervalMs: z.number().int().min(1000).default(30000),
        maxAutoResumes: z.number().int().min(0).max(10).default(3),
        maxPlanningRounds: z.number().int().min(0).max(10).default(3),
        maxTasksAdded: z.number().int().min(0).max(20).default(10),
      })
      .prefault({}),
    gitAuthorName: z.string().min(1).default("LLM Swarm"),
    gitAuthorEmail: z.string().min(3).default("swarm@localhost"),
    decision: z
      .object({
        policy: z.enum(["owner", "majority", "unanimous"]).default("owner"),
        quorum: z.number().int().positive().default(1),
        ownerRole: z.enum(["planner", "reviewer"]).default("reviewer"),
        blockOnQuestions: z.boolean().default(true),
      })
      .strict()
      .default({ policy: "owner", quorum: 1, ownerRole: "reviewer", blockOnQuestions: true }),
    git: z
      .object({
        cleanupWorktrees: z.boolean().default(false),
        preserveOnFailure: z.boolean().default(true),
        allowPush: z.boolean().default(false),
        allowMergeToBase: z.boolean().default(false),
        allowRemotePr: z.boolean().default(false),
      })
      .strict()
      .default({
        cleanupWorktrees: false,
        preserveOnFailure: true,
        allowPush: false,
        allowMergeToBase: false,
        allowRemotePr: false,
      }),
    checks: z.array(CheckSchema).max(20).default([]),
    providers: z.record(z.string(), ProviderConfigSchema).default({}),
    agents: z.record(z.string(), AgentSchema).default({}),
    profiles: z.record(z.string(), ProfileSchema).default({}),
  })
  .strict()
  .superRefine((config, ctx) => {
    const cap = config.allowWorkerCountAboveDefault
      ? config.maxWorkerCount
      : Math.min(5, config.maxWorkerCount);
    if (config.defaultWorkerCount > cap) {
      ctx.addIssue({
        code: "custom",
        path: ["defaultWorkerCount"],
        message: `defaultWorkerCount ${config.defaultWorkerCount} exceeds cap ${cap}`,
      });
    }
    for (const [name, agent] of Object.entries(config.agents)) {
      if (!config.providers[agent.provider]) {
        ctx.addIssue({
          code: "custom",
          path: ["agents", name, "provider"],
          message: `Unknown provider ${agent.provider}`,
        });
      }
      const seen = new Set([agent.provider]);
      for (const fallback of agent.fallbackProviders ?? []) {
        if (!config.providers[fallback] || seen.has(fallback)) {
          ctx.addIssue({
            code: "custom",
            path: ["agents", name, "fallbackProviders"],
            message: `Unknown or repeated fallback provider ${fallback}`,
          });
        }
        seen.add(fallback);
      }
    }
    for (const [name, profile] of Object.entries(config.profiles)) {
      for (const key of ["planner", "worker", "reviewer"] as const) {
        const agentName = profile[key];
        const agent = config.agents[agentName];
        if (!agent) {
          ctx.addIssue({
            code: "custom",
            path: ["profiles", name, key],
            message: `Unknown agent ${agentName}`,
          });
          continue;
        }
        const expected = key;
        if (agent.role !== expected) {
          ctx.addIssue({
            code: "custom",
            path: ["profiles", name, key],
            message: `Agent ${agentName} has role ${agent.role}, expected ${expected}`,
          });
        }
      }
      if (profile.workerCount !== undefined && profile.workerCount > cap) {
        ctx.addIssue({
          code: "custom",
          path: ["profiles", name, "workerCount"],
          message: `workerCount ${profile.workerCount} exceeds cap ${cap}`,
        });
      }
    }
    if (Object.keys(config.profiles).length > 0 && !config.profiles[config.defaultProfile]) {
      ctx.addIssue({
        code: "custom",
        path: ["defaultProfile"],
        message: `Unknown default profile ${config.defaultProfile}`,
      });
    }
  });

export type SwarmConfig = z.infer<typeof SwarmConfigSchema>;
export type AgentConfig = z.infer<typeof AgentSchema>;
export type ProfileConfig = z.infer<typeof ProfileSchema>;
export type CheckConfig = z.infer<typeof CheckSchema>;

export function workerCap(config: SwarmConfig): number {
  return config.allowWorkerCountAboveDefault
    ? config.maxWorkerCount
    : Math.min(5, config.maxWorkerCount);
}

export function resolveWorkerCount(
  config: SwarmConfig,
  requested: number | undefined,
  profileCount: number | undefined,
): number {
  const count = requested ?? profileCount ?? config.defaultWorkerCount;
  if (!Number.isInteger(count) || count < 1) {
    throw new SwarmError("worker_count must be a positive integer", "bad_worker_count");
  }
  const cap = workerCap(config);
  if (count > cap) {
    throw new SwarmError(
      `worker_count ${count} exceeds the cap of ${cap}. Set allowWorkerCountAboveDefault and raise maxWorkerCount only if you intend to run more than five workers.`,
      "bad_worker_count",
    );
  }
  return count;
}
