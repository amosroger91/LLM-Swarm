import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { databasePath, loadConfig } from "../src/config/load.js";
import { openDatabase } from "../src/db/connection.js";
import { Store } from "../src/db/store.js";
import { GitWorkspace } from "../src/git/workspace.js";
import { createLogger } from "../src/logging/logger.js";
import { Orchestrator, configProviderResolver } from "../src/orchestration/service.js";
import { createRedactor } from "../src/safety/redact.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llm-swarm-ollama-"));
const repo = path.join(root, "repo");
const dataDir = path.join(root, "data");
const configPath = path.join(root, "swarm.yaml");
const logPath = path.join(root, "orchestrator.log");
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

const configYaml = `dataDir: ${dataDir.replaceAll("\\", "/")}
defaultProfile: default
defaultWorkerCount: 1
jobTimeoutMs: 1800000
providerTimeoutMs: 300000
logLevel: info
writeSnapshot: true
providers:
  ollama:
    type: openai_compatible
    baseUrl: http://127.0.0.1:11434/v1
    model: ${process.env.SWARM_SMOKE_MODEL ?? "qwen2.5-coder:7b"}
    apiKeyOptional: true
    jsonMode: json_object
    timeoutMs: 300000
    capabilities:
      structuredOutput: true
      toolCalling: false
      streaming: false
      nonInteractive: true
agents:
  ollama-planner:
    role: planner
    provider: ollama
  ollama-worker:
    role: worker
    provider: ollama
  ollama-reviewer:
    role: reviewer
    provider: ollama
profiles:
  default:
    planner: ollama-planner
    worker: ollama-worker
    reviewer: ollama-reviewer
    workerCount: 1
`;
fs.writeFileSync(configPath, configYaml, "utf8");

function git(args: string[]): void {
  const result = spawnSync("git", args, {
    cwd: repo,
    shell: false,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "LLM Swarm",
      GIT_AUTHOR_EMAIL: "swarm@localhost",
      GIT_COMMITTER_NAME: "LLM Swarm",
      GIT_COMMITTER_EMAIL: "swarm@localhost",
    },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
}

git(["init", "-b", "main"]);
git(["config", "core.autocrlf", "false"]);
git(["config", "commit.gpgsign", "false"]);
git(["config", "user.name", "Temp User"]);
git(["config", "user.email", "temp@example.com"]);
fs.writeFileSync(path.join(repo, "README.md"), "base\n", "utf8");
git(["add", "README.md"]);
git(["commit", "-m", "init"]);

const config = loadConfig(configPath);
config.checks = [
  {
    command: process.execPath,
    args: [
      "-e",
      "const fs=require('node:fs'); if(fs.readFileSync('hello.txt','utf8')!=='hello-from-swarm\\n'||fs.readFileSync('README.md','utf8')!=='base\\n') process.exit(1); console.log('Exact file content and unchanged README verified');",
    ],
  },
];
// Persist the effective config so a second CLI process observes this same job.
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
const logger = createLogger("info", createRedactor([]), (line) => {
  fs.appendFileSync(logPath, `${line}\n`);
});
const store = new Store(openDatabase(databasePath(config)));
const orchestrator = new Orchestrator(
  store,
  config,
  new GitWorkspace({
    authorName: config.gitAuthorName,
    authorEmail: config.gitAuthorEmail,
    timeoutMs: config.providerTimeoutMs,
    policy: config.git,
    maxContextChars: config.maxPromptChars,
  }),
  configProviderResolver((text) => text),
  { logger, recoverOnStart: false },
);

const started = await orchestrator.startJob({
  task: "Create a file named hello.txt whose only line is hello-from-swarm. Do not change README.md.",
  repoPath: repo,
  workerCount: 1,
});
process.stdout.write(`ROOT ${root}\nJOB ${started.job_id} ${started.status}\n`);

const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);
let previous = "";
const deadline = Date.now() + config.jobTimeoutMs;
while (Date.now() < deadline) {
  const status = orchestrator.status(started.job_id);
  const line = `${status.status} review=${String(status.review_state)} counts=${JSON.stringify(status.task_counts)} error=${String(status.error ?? "")}`;
  if (line !== previous) {
    process.stdout.write(`STATUS ${line}\n`);
    previous = line;
  }
  if (terminal.has(String(status.status))) break;
  await new Promise((resolve) => setTimeout(resolve, 3000));
}
await orchestrator.waitFor(started.job_id);
const job = store.mustJob(started.job_id);
process.stdout.write(`TERMINAL ${job.status}\n`);
process.stdout.write(`${JSON.stringify(orchestrator.result(job.id), null, 2)}\n`);
const hello = path.join(repo, "workspaces", job.id, "integration", "hello.txt");
process.stdout.write(`HELLO_EXISTS ${fs.existsSync(hello)}\n`);
if (fs.existsSync(hello)) {
  process.stdout.write(`HELLO ${JSON.stringify(fs.readFileSync(hello, "utf8"))}\n`);
}
process.stdout.write(`SNAPSHOT ${job.snapshotPath ?? ""}\n`);
store.close();
process.exit(job.status === "completed" ? 0 : 1);
