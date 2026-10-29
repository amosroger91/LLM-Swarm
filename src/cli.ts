#!/usr/bin/env node
import path from "node:path";
import { databasePath, loadConfig } from "./config/load.js";
import { openDatabase } from "./db/connection.js";
import { Store } from "./db/store.js";
import { GitWorkspace } from "./git/workspace.js";
import { createLogger } from "./logging/logger.js";
import { serveSwarm } from "./mcp/server.js";
import { Orchestrator, configProviderResolver } from "./orchestration/service.js";
import { renderSnapshot, writeSnapshotAtomic } from "./orchestration/snapshot.js";
import { createRedactor, secretValuesFromEnv } from "./safety/redact.js";
import { SwarmError, errorMessage } from "./errors.js";

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
  migrate            Open the database and apply migrations
  jobs               List recent jobs
  status <job_id>    Print job status
  result <job_id>    Print the final report, or an in-progress response
  cancel <job_id>    Request cancellation
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
      }),
    );
    store.setSnapshotPath(jobId, filePath);
    process.stdout.write(`${filePath}\n`);
    store.close();
    return;
  }

  const workspace = new GitWorkspace({
    authorName: config.gitAuthorName,
    authorEmail: config.gitAuthorEmail,
    timeoutMs: config.providerTimeoutMs,
    policy: config.git,
    maxContextChars: config.maxPromptChars,
  });
  const orchestrator = new Orchestrator(store, config, workspace, configProviderResolver(redact), {
    logger,
    recoverOnStart: true,
  });

  if (args.command === "status") {
    process.stdout.write(
      `${JSON.stringify(orchestrator.status(requiredId(args.positionals)), null, 2)}\n`,
    );
    store.close();
    return;
  }
  if (args.command === "result") {
    process.stdout.write(
      `${JSON.stringify(orchestrator.result(requiredId(args.positionals)), null, 2)}\n`,
    );
    store.close();
    return;
  }
  if (args.command === "cancel") {
    process.stdout.write(
      `${JSON.stringify(orchestrator.cancel(requiredId(args.positionals)), null, 2)}\n`,
    );
    store.close();
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
