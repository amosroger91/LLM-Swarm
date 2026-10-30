#!/usr/bin/env node
import path from "node:path";
import { databasePath, loadConfig } from "./config/load.js";
import { openDatabase } from "./db/connection.js";
import { Store } from "./db/store.js";
import { GitWorkspace } from "./git/workspace.js";
import { createLogger } from "./logging/logger.js";
import { serveSwarm } from "./mcp/server.js";
import {
  Orchestrator,
  configProviderResolver,
  statusPayload,
  resultPayload,
} from "./orchestration/service.js";
import { renderSnapshot, writeSnapshotAtomic } from "./orchestration/snapshot.js";
import { createRedactor, secretValuesFromEnv } from "./safety/redact.js";
import { SwarmError, errorMessage } from "./errors.js";
import { startDashboard } from "./web/server.js";

interface ParsedArgs {
  command: string;
  positionals: string[];
  config?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  let config: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") {
      const value = argv[index + 1];
      if (!value) throw new SwarmError("--config requires a file path", "bad_args");
      config = value;
      index += 1;
      continue;
    }
    if (arg) positionals.push(arg);
  }
  return { command: positionals[0] ?? "help", positionals: positionals.slice(1), config };
}

function help(): string {
  return `llm-swarm <command> [--config file]

Commands:
  mcp                Start the MCP server on stdio
  dashboard [port]   Start the local web control center (default 4317)
  maintenance       Run one recovery/question-answering sweep
  watchdog [port]   Restore the dashboard and resume interrupted work; no-op if a live scheduler exists
  migrate            Open the database and apply migrations
  jobs               List recent jobs
  status <job_id>    Print job status
  result <job_id>    Print the final report, or an in-progress response
  cancel <job_id>    Request cancellation
  resume <job_id>    Resume failed, cancelled, or interrupted work and wait for completion
  resolve <job_id> <decision_id> <option> <answer>  Answer a blocking decision
  metrics <job_id>   Print measured provider calls, tokens, retries, and elapsed time
  blockers <job_id>  Print blocker evidence, attempted fixes, and next actions
  snapshot <job_id>  Regenerate the swarm.md projection
  backup <file>      Copy the SQLite database to a file

Diagnostics go to stderr. MCP stdout is reserved for the protocol.
`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help" || args.command === "--help") {
    process.stdout.write(help());
    return;
  }
  const config = loadConfig(args.config);
  const redact = createRedactor(
    secretValuesFromEnv(["OLLAMA_API_KEY", "OPENAI_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY"]),
  );
  const logger = createLogger(config.logLevel, redact);
  const db = openDatabase(databasePath(config));
  const store = new Store(db);
  if (args.command === "migrate") {
    logger.info({ database: databasePath(config) }, "migrations applied");
    store.close();
    return;
  }
  if (args.command === "backup") {
    const destination = args.positionals[0];
    if (!destination) throw new SwarmError("backup requires a destination file", "bad_args");
    await store.backup(path.resolve(destination));
    process.stdout.write(`backed up to ${path.resolve(destination)}\n`);
    store.close();
    return;
  }
  if (args.command === "jobs") {
    process.stdout.write(`${JSON.stringify(store.listJobs(), null, 2)}\n`);
    store.close();
    return;
  }
  if (args.command === "snapshot") {
    const jobId = requiredId(args.positionals);
    const job = store.mustJob(jobId);
    const filePath = path.join(path.resolve(config.dataDir), "jobs", jobId, "swarm.md");
    writeSnapshotAtomic(
      filePath,
      renderSnapshot({
        job,
        tasks: store.listTasks(jobId),
        decisions: store.listDecisions(jobId),
        reviews: store.listReviews(jobId),
        blockers: store.listBlockers(jobId),
      }),
    );
    store.setSnapshotPath(jobId, filePath);
    process.stdout.write(`${filePath}\n`);
    store.close();
    return;
  }

  if (["status", "result", "cancel", "metrics", "resolve", "blockers"].includes(args.command)) {
    try {
      const id = requiredId(args.positionals);
      if (args.command === "resolve") {
        const decision = store.mustDecision(args.positionals[1] ?? "");
        if (decision.jobId !== id)
          throw new SwarmError("Decision belongs to another job", "bad_args");
        store.resolveDecision({
          decisionId: decision.id,
          option: args.positionals[2] ?? "",
          rationale: args.positionals.slice(3).join(" "),
          actor: "cli-caller",
          actorRole: decision.ownerRole,
        });
        process.stdout.write(`${JSON.stringify(store.mustDecision(decision.id), null, 2)}\n`);
        return;
      }
      const result =
        args.command === "blockers"
          ? store.listBlockers(id)
          : args.command === "metrics"
            ? store.measurements(id)
            : args.command === "status"
              ? statusPayload(store, id)
              : args.command === "result"
                ? resultPayload(store, id)
                : store.requestCancel(id);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } finally {
      store.close();
    }
    return;
  }
  if (!["mcp", "resume", "dashboard", "maintenance", "watchdog"].includes(args.command)) {
    store.close();
    throw new SwarmError(`Unknown command ${args.command}\n${help()}`, "bad_args");
  }
  const workspace = new GitWorkspace({
    authorName: config.gitAuthorName,
    authorEmail: config.gitAuthorEmail,
    timeoutMs: config.providerTimeoutMs,
    policy: config.git,
    maxContextChars: config.maxPromptChars,
  });
  let orchestrator: Orchestrator;
  try {
    orchestrator = new Orchestrator(store, config, workspace, configProviderResolver(redact), {
      logger,
      recoverOnStart: true,
    });
  } catch (error) {
    store.close();
    if (
      ["maintenance", "watchdog"].includes(args.command) &&
      error instanceof SwarmError &&
      error.code === "scheduler_busy"
    ) {
      process.stdout.write(
        `${JSON.stringify({ skipped: "A live scheduler owns recovery and question answering" })}\n`,
      );
      return;
    }
    throw error;
  }
  if (args.command === "maintenance") {
    try {
      const sweep = await orchestrator.maintenanceTick();
      process.stdout.write(`${JSON.stringify(sweep, null, 2)}\n`);
      await Promise.all(
        ((sweep.resumed as string[] | undefined) ?? []).map((id) => orchestrator.waitFor(id)),
      );
    } finally {
      await orchestrator.shutdown();
      store.close();
    }
    return;
  }
  if (args.command === "dashboard" || args.command === "watchdog") {
    const port = Number(args.positionals[0] ?? 4317);
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new SwarmError("Invalid dashboard port", "bad_args");
    const { server, url } = await startDashboard(store, orchestrator, config, port);
    process.stdout.write(`Swarm control center: ${url}\n`);
    if (args.command === "watchdog")
      void orchestrator
        .maintenanceTick()
        .catch((error) =>
          logger.error({ error: errorMessage(error) }, "initial watchdog recovery failed"),
        );
    const stop = (): void => {
      server.close();
      void orchestrator.shutdown().finally(() => {
        store.close();
        process.exit(0);
      });
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return;
  }

  if (args.command === "resume") {
    try {
      const started = await orchestrator.resume(requiredId(args.positionals));
      process.stdout.write(`${JSON.stringify(started)}\n`);
      await orchestrator.waitFor(started.job_id);
      process.stdout.write(`${JSON.stringify(orchestrator.result(started.job_id), null, 2)}\n`);
      if (store.mustJob(started.job_id).status !== "completed") process.exitCode = 1;
    } finally {
      await orchestrator.shutdown();
      store.close();
    }
    return;
  }

  if (args.command === "mcp") {
    const stop = (): void => {
      void orchestrator.shutdown().finally(() => {
        store.close();
        process.exit(0);
      });
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    serveSwarm(orchestrator, logger);
    return;
  }
  store.close();
  throw new SwarmError(`Unknown command ${args.command}\n${help()}`, "bad_args");
}

function requiredId(positionals: string[]): string {
  const id = positionals[0];
  if (!id) throw new SwarmError("A job id is required", "bad_args");
  return id;
}

main().catch((error: unknown) => {
  const message = error instanceof SwarmError ? error.message : errorMessage(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
