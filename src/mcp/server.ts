import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { SwarmError, errorMessage } from "../errors.js";
import type { DelegateMapResult, DelegateResult } from "../orchestration/delegate.js";
import { createLogger, type Logger } from "../logging/logger.js";
import type { SwarmBackend } from "./backend.js";

export type Toolset = "core" | "all";

export interface SwarmServerOptions {
  /** core: the tools needed to offload and track work. all: adds chat, votes, and planner tools. */
  tools?: Toolset;
  /** Directory relative paths resolve against. Defaults to this process's working directory. */
  cwd?: string;
}

const StartInput = z.object({
  task: z.string().min(1).max(20_000).describe("High-level task for the swarm"),
  repo_path: z.string().min(1).describe("Absolute or relative path to the git repository root"),
  base_branch: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Existing local branch to fork work from"),
  worker_count: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Concurrent workers. Values above five require explicit configuration."),
  config_profile: z.string().min(1).optional().describe("Profile name from the YAML config"),
  dry_run: z.boolean().optional().describe("Plan only. Do not launch workers or change git state."),
  plan: z
    .unknown()
    .optional()
    .describe(
      "Optional explicit task graph with file ownership and shared interface contracts. Validated before execution.",
    ),
});

const StartOutput = z.object({
  job_id: z.string(),
  status: z.string(),
});

const JobIdInput = z.object({
  job_id: z.string().min(1).describe("Job id returned by start_swarm"),
});

const ChatInput = z.object({
  job_id: z.string().min(1),
  message: z.string().min(1).max(16_000).describe("Message posted into the job chat room"),
  channel: z.string().min(1).max(100).optional().describe("Channel name. Defaults to general."),
});

const VoteInput = z.object({
  job_id: z.string().min(1),
  decision_id: z.string().min(1),
  option: z.string().min(1).max(200).describe("One of the decision's options"),
  rationale: z.string().max(4000).optional(),
  voter: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Caller identity. Defaults to mcp-client. A second vote from the same voter replaces the first.",
    ),
});

// Compact JSON: tool output lands in the caller's context window, so every byte is a token.
function ok(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function footer(result: DelegateResult): string {
  const tokens =
    result.inputTokens !== undefined
      ? ` ${result.inputTokens}+${result.outputTokens ?? 0} tok`
      : "";
  const failover = result.failover?.length
    ? ` after ${result.failover.map((item) => `${item.provider}:${item.kind}`).join(",")}`
    : "";
  return `\n\n[${result.provider}${result.model ? `/${result.model}` : ""}${failover} · ${result.files} files · ${Math.round(result.durationMs / 1000)}s${tokens}${result.truncated ? " · clipped" : ""}]`;
}

function renderMap(result: DelegateMapResult): string {
  const body = result.reduced
    ? result.reduced.text
    : result.results.map((item) => `## ${item.file}\n${item.text}`).join("\n\n");
  const failures = result.reduced
    ? result.results.filter((item) => !item.ok).map((item) => `- ${item.file}: ${item.text}`)
    : [];
  return `${body}${failures.length ? `\n\nFailed:\n${failures.join("\n")}` : ""}\n\n[${result.files} files · ${result.failed} failed · ${Math.round(result.durationMs / 1000)}s · ${result.inputTokens}+${result.outputTokens} tok]`;
}

/** Status without the full call log and blocker evidence. Ask with verbose for everything. */
export function compactStatus(full: Record<string, unknown>): Record<string, unknown> {
  const measurements = { ...(full.measurements as Record<string, unknown>) };
  delete measurements.calls;
  const blockers = (full.blockers as Array<Record<string, unknown>>)
    .filter((blocker) => blocker.status !== "resolved")
    .map((blocker) => ({
      id: blocker.id,
      category: blocker.category,
      summary: String(blocker.summary).slice(0, 300),
      next_action: String(blocker.nextAction).slice(0, 300),
      occurrences: blocker.occurrences,
    }));
  return {
    ...full,
    recent_events: (full.recent_events as Array<Record<string, unknown>>)
      .slice(-6)
      .map((event) => ({ type: event.type, at: event.at })),
    measurements,
    blockers,
  };
}

function fail(error: unknown) {
  const message = error instanceof SwarmError ? error.message : errorMessage(error);
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

const DelegateBase = {
  task: z
    .string()
    .min(1)
    .max(40_000)
    .describe("What to do. Be specific about the output you want; the answer is all you get back."),
  root: z
    .string()
    .optional()
    .describe("Directory files resolve against. Defaults to the current project."),
  agent: z
    .string()
    .optional()
    .describe("Agent name from the swarm config. Defaults to the cheap delegate agent."),
  format: z.enum(["text", "json"]).optional(),
  max_output_chars: z.number().int().positive().max(200_000).optional(),
};

export function createSwarmServer(
  backend: SwarmBackend,
  options: SwarmServerOptions = {},
): McpServer {
  const orchestrator = backend;
  const all = (options.tools ?? "all") === "all";
  const cwd = options.cwd ?? process.cwd();
  const server = new McpServer({ name: "llm-swarm", version: "1.1.0" });
  // Each advertised tool costs the caller context on every turn; the core set omits
  // tools the dashboard covers better.
  const extras: Array<{ remove(): void }> = [];
  const register = server.registerTool.bind(server);
  server.registerTool = ((name: string, ...rest: unknown[]) => {
    const tool = (register as (...args: unknown[]) => { remove(): void })(name, ...rest);
    if (!CORE_TOOLS.has(name)) extras.push(tool);
    return tool;
  }) as typeof server.registerTool;

  server.registerTool(
    "delegate",
    {
      title: "Delegate to a cheap model",
      description:
        "Offload a self-contained task to a local/free model and get back only its answer. The model reads the files, so you don't. Good for: summarizing or searching files, explaining code, drafting boilerplate/tests/docs, reviewing a diff, extracting data. Verify anything you act on.",
      inputSchema: z.object({
        ...DelegateBase,
        files: z
          .array(z.string().min(1))
          .max(500)
          .optional()
          .describe(
            "Paths, directories, or globs (src/**/*.ts) under root, sent with line numbers.",
          ),
        context: z
          .string()
          .max(200_000)
          .optional()
          .describe("Extra inline text, e.g. a diff or log."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const result = await orchestrator.delegate({
          task: args.task,
          root: path.resolve(cwd, args.root ?? "."),
          files: args.files,
          context: args.context,
          agent: args.agent,
          format: args.format,
          maxOutputChars: args.max_output_chars,
        });
        return text(result.text + footer(result));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "delegate_map",
    {
      title: "Delegate per file",
      description:
        "Run the same task on each matched file in parallel on cheap models, optionally combining the answers with a final 'reduce' instruction. Use for large file sets that don't fit one delegate call.",
      inputSchema: z.object({
        ...DelegateBase,
        files: z.array(z.string().min(1)).min(1).max(500).describe("Paths, directories, or globs"),
        reduce: z
          .string()
          .max(20_000)
          .optional()
          .describe("Instruction to merge all per-file answers into one result"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const result = await orchestrator.delegateMap({
          task: args.task,
          root: path.resolve(cwd, args.root ?? "."),
          files: args.files,
          agent: args.agent,
          format: args.format,
          maxOutputChars: args.max_output_chars,
          reduce: args.reduce,
        });
        return text(renderMap(result));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "swarm_wait",
    {
      title: "Wait for a job",
      description:
        "Block until a job finishes, needs an answer, or timeout_s passes, then return compact status. Use instead of polling swarm_status.",
      inputSchema: z.object({
        job_id: z.string().min(1),
        timeout_s: z.number().int().min(1).max(3600).optional().describe("Default 300"),
      }),
    },
    async ({ job_id, timeout_s }) => {
      try {
        const waited = await orchestrator.wait(job_id, (timeout_s ?? 300) * 1000);
        const status = compactStatus(await orchestrator.status(job_id));
        return ok({ ...waited, ...status });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "swarm_jobs",
    {
      title: "List jobs",
      description: "Recent swarm jobs with status and task counts.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit }) => {
      try {
        return ok({ jobs: await orchestrator.jobs(limit ?? 10) });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "swarm_providers",
    {
      title: "Provider health",
      description:
        "Which models are healthy, cooling down after rate limits, or unavailable, plus each agent's failover chain and delegation totals.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return ok(await orchestrator.providersView());
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "launch_swarm_plan",
    {
      title: "Launch a stored plan",
      description: "Execute a completed dry-run plan after the caller has reviewed it.",
      inputSchema: JobIdInput,
      outputSchema: StartOutput,
    },
    async ({ job_id }) => {
      try {
        return ok(await orchestrator.launchPlan(job_id));
      } catch (error) {
        return fail(error);
      }
    },
  );
  server.registerTool(
    "swarm_planner_chat",
    {
      title: "Talk to planner",
      description:
        "Ask about a job or propose additional implementation tasks. Tasks are persisted as proposals until applied.",
      inputSchema: z.object({ job_id: z.string().min(1), message: z.string().min(1).max(16000) }),
      outputSchema: z.object({
        reply: z.string(),
        tasks: z.array(z.unknown()),
        contracts: z.array(z.string()),
        proposalId: z.string().optional(),
      }),
    },
    async ({ job_id, message }) => {
      try {
        return ok(await orchestrator.plannerChat(job_id, message));
      } catch (error) {
        return fail(error);
      }
    },
  );
  server.registerTool(
    "apply_swarm_proposal",
    {
      title: "Apply planner proposal",
      description:
        "Validate and add proposed tasks to the execution graph, including dependencies and file ownership.",
      inputSchema: z.object({ job_id: z.string().min(1), proposal_id: z.string().min(1) }),
      outputSchema: z.object({ job_id: z.string(), tasks_added: z.number(), status: z.string() }),
    },
    async ({ job_id, proposal_id }) => {
      try {
        return ok(await orchestrator.applyProposal(job_id, proposal_id));
      } catch (error) {
        return fail(error);
      }
    },
  );
  server.registerTool(
    "swarm_maintenance",
    {
      title: "Run recovery sweep",
      description:
        "Resume interrupted jobs and have the planner answer agent questions when supported by the human goal. Human-only questions remain pending.",
      inputSchema: z.object({}),
      outputSchema: z.record(z.string(), z.unknown()),
    },
    async () => {
      try {
        return ok(await orchestrator.maintenanceTick());
      } catch (error) {
        return fail(error);
      }
    },
  );
  server.registerTool(
    "swarm_blockers",
    {
      title: "Swarm blockers",
      description:
        "Show stuck tasks, repeated failures, attempted fixes, recovery state, and specific actions required from the caller.",
      inputSchema: JobIdInput,
      outputSchema: z.object({ blockers: z.array(z.record(z.string(), z.unknown())) }),
    },
    async ({ job_id }) => {
      try {
        return ok({ blockers: (await orchestrator.status(job_id)).blockers as unknown[] });
      } catch (error) {
        return fail(error);
      }
    },
  );
  server.registerTool(
    "resume_swarm",
    {
      title: "Resume swarm",
      description:
        "Resume an interrupted, failed, or cancelled job, preserving successful task commits. Grants failed tasks a fresh attempt budget.",
      inputSchema: JobIdInput,
      outputSchema: StartOutput,
    },
    async ({ job_id }) => {
      try {
        return ok(await orchestrator.resume(job_id));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "resolve_swarm_decision",
    {
      title: "Answer swarm decision",
      description:
        "Record the caller's explicit answer to a decision and unblock scheduling. Use rationale for the human's requirements.",
      inputSchema: z.object({
        job_id: z.string().min(1),
        decision_id: z.string().min(1),
        option: z.string().min(1),
        rationale: z.string().min(1).max(4000),
      }),
      outputSchema: z.object({ decision_id: z.string(), status: z.string() }),
    },
    async (args) => {
      try {
        return ok(
          await orchestrator.resolveDecision({
            jobId: args.job_id,
            decisionId: args.decision_id,
            option: args.option,
            rationale: args.rationale,
          }),
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "start_swarm",
    {
      title: "Start swarm",
      description:
        "Create a job, persist it, and start orchestration in the background. Returns a job id without waiting for completion.",
      inputSchema: StartInput,
      outputSchema: StartOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const started = await orchestrator.startJob({
          task: args.task,
          repoPath: path.resolve(cwd, args.repo_path),
          baseBranch: args.base_branch,
          workerCount: args.worker_count,
          configProfile: args.config_profile,
          dryRun: args.dry_run,
          plan: args.plan,
        });
        return ok(started);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "swarm_status",
    {
      title: "Swarm status",
      description:
        "Job status, task counts, active workers, open blockers and questions, token totals. Set verbose for the full call log and blocker evidence.",
      inputSchema: JobIdInput.extend({ verbose: z.boolean().optional() }),
      outputSchema: z.object({
        job_id: z.string(),
        status: z.string(),
        review_state: z.string().nullable(),
        dry_run: z.boolean(),
        worker_count: z.number(),
        task_counts: z.record(z.string(), z.number()),
        active_workers: z.array(z.record(z.string(), z.unknown())),
        recent_events: z.array(z.record(z.string(), z.unknown())),
        snapshot_path: z.string().nullable(),
        error: z.string().nullable(),
        pending_decisions: z.array(z.record(z.string(), z.unknown())),
        measurements: z.record(z.string(), z.unknown()),
        blockers: z.array(z.record(z.string(), z.unknown())),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ job_id, verbose }) => {
      try {
        const status = await orchestrator.status(job_id);
        return ok(verbose ? status : compactStatus(status));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "swarm_chat",
    {
      title: "Swarm chat",
      description: "Add a message to the persistent job chat room.",
      inputSchema: ChatInput,
      outputSchema: z.object({ id: z.string(), channel: z.string() }),
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        return ok(
          await orchestrator.chat({
            jobId: args.job_id,
            message: args.message,
            channel: args.channel,
          }),
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "swarm_decisions",
    {
      title: "Swarm decisions",
      description: "List open and resolved decisions, options, votes, and rationale.",
      inputSchema: JobIdInput,
      outputSchema: z.object({ decisions: z.array(z.record(z.string(), z.unknown())) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ job_id }) => {
      try {
        const decisions = await orchestrator.decisions(job_id);
        return ok({ decisions: decisions as Record<string, unknown>[] });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "swarm_vote",
    {
      title: "Swarm vote",
      description:
        "Record or replace the caller's vote. Votes inform the decision owner and do not approve work unless the configured policy says so.",
      inputSchema: VoteInput,
      outputSchema: z.object({
        decision_id: z.string(),
        voter: z.string(),
        option: z.string(),
      }),
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        return ok(
          await orchestrator.vote({
            jobId: args.job_id,
            decisionId: args.decision_id,
            option: args.option,
            rationale: args.rationale,
            voter: args.voter,
          }),
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "swarm_result",
    {
      title: "Swarm result",
      description:
        "Return the final report when the job is terminal, or a clear in-progress response.",
      inputSchema: JobIdInput,
      outputSchema: z.object({
        ready: z.boolean(),
        job_id: z.string(),
        status: z.string(),
        message: z.string().optional(),
        report: z.unknown().optional(),
        error: z.string().nullable().optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ job_id }) => {
      try {
        return ok(await orchestrator.result(job_id));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "cancel_swarm",
    {
      title: "Cancel swarm",
      description: "Request cooperative cancellation and stop launching new work.",
      inputSchema: JobIdInput,
      outputSchema: z.object({ job_id: z.string(), status: z.string() }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ job_id }) => {
      try {
        return ok(await orchestrator.cancel(job_id));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool = register;
  if (!all) for (const tool of extras) tool.remove();
  return server;
}

export const CORE_TOOLS = new Set([
  "delegate",
  "delegate_map",
  "start_swarm",
  "swarm_wait",
  "swarm_status",
  "swarm_result",
  "swarm_jobs",
  "swarm_providers",
  "cancel_swarm",
  "resume_swarm",
  "launch_swarm_plan",
  "resolve_swarm_decision",
]);

export function serveSwarm(
  backend: SwarmBackend,
  logger: Logger = createLogger("info", (text) => text),
  options: SwarmServerOptions = {},
): void {
  serveStdio(() => createSwarmServer(backend, options), {
    onerror(error) {
      logger.error({ err: error.message }, "mcp transport error");
    },
  });
  logger.info({}, "llm-swarm MCP server listening on stdio");
}
