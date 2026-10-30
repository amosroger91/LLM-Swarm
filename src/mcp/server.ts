import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { SwarmError, errorMessage } from "../errors.js";
import type { Orchestrator } from "../orchestration/service.js";
import { createLogger, type Logger } from "../logging/logger.js";

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

function ok(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function fail(error: unknown) {
  const message = error instanceof SwarmError ? error.message : errorMessage(error);
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

export function createSwarmServer(orchestrator: Orchestrator): McpServer {
  const server = new McpServer({ name: "llm-swarm", version: "1.0.0" });
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
        return ok({ blockers: orchestrator.status(job_id).blockers });
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
          orchestrator.resolveDecision({
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
          repoPath: args.repo_path,
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
        "Return job status, task counts, active workers, recent events, and review state.",
      inputSchema: JobIdInput,
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
    async ({ job_id }) => {
      try {
        return ok(orchestrator.status(job_id));
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
          orchestrator.chat({
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
        const decisions = orchestrator.decisions(job_id);
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
          orchestrator.vote({
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
        return ok(orchestrator.result(job_id));
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
        return ok(orchestrator.cancel(job_id));
      } catch (error) {
        return fail(error);
      }
    },
  );

  return server;
}

export function serveSwarm(
  orchestrator: Orchestrator,
  logger: Logger = createLogger("info", (text) => text),
): void {
  serveStdio(() => createSwarmServer(orchestrator), {
    onerror(error) {
      logger.error({ err: error.message }, "mcp transport error");
    },
  });
  logger.info({}, "llm-swarm MCP server listening on stdio");
}
