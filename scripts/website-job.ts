import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { databasePath, loadConfig } from "../src/config/load.js";
import { openDatabase } from "../src/db/connection.js";
import { Store } from "../src/db/store.js";
import { GitWorkspace } from "../src/git/workspace.js";
import { createLogger } from "../src/logging/logger.js";
import { Orchestrator, configProviderResolver } from "../src/orchestration/service.js";
import { createRedactor } from "../src/safety/redact.js";

const progressPath = path.join(os.tmpdir(), "llm-swarm-website-job.log");
fs.writeFileSync(progressPath, "", "utf8");

function out(line: string): void {
  process.stdout.write(`${line}\n`);
  fs.appendFileSync(progressPath, `${line}\n`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llm-swarm-site-"));
const repo = path.join(root, "repo");
const dataDir = path.join(root, "data");
const configPath = path.join(root, "swarm.yaml");
const logPath = path.join(root, "orchestrator.log");
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

const configYaml = `dataDir: ${dataDir.replaceAll("\\", "/")}
defaultProfile: default
defaultWorkerCount: 1
defaultMaxAttempts: 3
maxReviewRounds: 4
jobTimeoutMs: 2700000
providerTimeoutMs: 300000
checks:
  - command: node
    args:
      - ${JSON.stringify(fileURLToPath(new URL("./check-site.mjs", import.meta.url)))}
logLevel: info
writeSnapshot: true
providers:
  ollama:
    type: openai_compatible
    baseUrl: http://127.0.0.1:11434/v1
    model: qwen2.5-coder:7b
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

const task = `Build a static website in the repository root. Create these three files and do not change README.md.

index.html
- The document title and the visible h1 text are both exactly: Swarm Test Site
- Include a short paragraph that says the page greets a visitor by name.
- Include a label whose text is Name and a text input with id="name".
- Include a button with id="greet" whose visible text is Greet.
- Include an empty paragraph with id="greeting".
- Load site.css and site.js from the same directory.

site.css
- Set the page background to a color other than white.
- Make the button visibly distinct from the page background.
- Use a font size of at least 16px for the paragraph and the greeting.

site.js
- When the button with id greet is clicked, read the input with id name.
- If the trimmed name is empty, set the text of the element with id greeting to exactly: Hello, stranger
- Otherwise set that text to exactly: Hello, <trimmed name>
- Use no framework and no build step.`;

const config = loadConfig(configPath);
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
  task,
  repoPath: repo,
  workerCount: 1,
});
out(`ROOT ${root}`);
out(`JOB ${started.job_id} ${started.status}`);

const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);
let previous = "";
const deadline = Date.now() + config.jobTimeoutMs;
while (Date.now() < deadline) {
  const status = orchestrator.status(started.job_id);
  const line = `${status.status} review=${String(status.review_state)} counts=${JSON.stringify(status.task_counts)} error=${String(status.error ?? "")}`;
  if (line !== previous) {
    out(`STATUS ${line}`);
    previous = line;
  }
  if (terminal.has(String(status.status))) break;
  await new Promise((resolve) => setTimeout(resolve, 3000));
}
await orchestrator.waitFor(started.job_id);
const job = store.mustJob(started.job_id);
out(`TERMINAL ${job.status}`);
out(JSON.stringify(orchestrator.result(job.id), null, 2));
const site = path.join(repo, "workspaces", job.id, "integration");
out(`SITE ${site}`);
for (const name of ["index.html", "site.css", "site.js", "README.md"]) {
  const file = path.join(site, name);
  out(`FILE ${name} ${fs.existsSync(file)}`);
}
store.close();
process.exit(job.status === "completed" ? 0 : 1);
