import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig } from "../src/config/load.js";
import type { ProviderConfig, SwarmConfig } from "../src/config/schema.js";
import { openDatabase } from "../src/db/connection.js";
import { Store, type PlannedTaskInput } from "../src/db/store.js";
import { MemoryWorkspace } from "../src/git/workspace.js";
import { Orchestrator, type ProviderResolver } from "../src/orchestration/service.js";
import type { AgentProvider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(here, "..");

export function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeTemp(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    // A Windows git worktree can keep a handle for a moment after the test.
  }
}

export function testConfig(dataDir: string, patch: Partial<SwarmConfig> = {}): SwarmConfig {
  return {
    ...defaultConfig(),
    dataDir,
    writeSnapshot: false,
    requireChecks: false,
    recovery: { enabled: false, maxAssistsPerTask: 1, stallWarningMs: 60000 },
    maintenance: {
      enabled: false,
      intervalMs: 30000,
      maxAutoResumes: 3,
      maxPlanningRounds: 3,
      maxTasksAdded: 10,
    },
    jobTimeoutMs: 20_000,
    providerTimeoutMs: 5_000,
    ...patch,
  };
}

export function openStore(dir: string): { store: Store; dbPath: string } {
  const dbPath = path.join(dir, "swarm.db");
  return { store: new Store(openDatabase(dbPath)), dbPath };
}

export function providerConfig(structuredOutput = true): ProviderConfig {
  return {
    type: "openai_compatible",
    baseUrl: "http://127.0.0.1:9/v1",
    model: "fake",
    apiKeyOptional: true,
    jsonMode: "off",
    timeoutMs: 5_000,
    capabilities: {
      structuredOutput,
      toolCalling: false,
      streaming: false,
      nonInteractive: true,
    },
  };
}

export function jsonResponse(value: unknown): ProviderResponse {
  return { text: JSON.stringify(value), structured: value, provider: "fake", model: "fake" };
}

export function textResponse(text: string): ProviderResponse {
  return { text, provider: "fake", model: "fake" };
}

export interface RoleHandlers {
  planner?: (request: ProviderRequest) => Promise<ProviderResponse> | ProviderResponse;
  worker?: (request: ProviderRequest) => Promise<ProviderResponse> | ProviderResponse;
  reviewer?: (request: ProviderRequest) => Promise<ProviderResponse> | ProviderResponse;
}

export function scriptedResolver(handlers: RoleHandlers): ProviderResolver {
  return {
    forProfile(profile): AgentProvider {
      const handler = handlers[profile.role];
      return {
        name: profile.name,
        model: "fake",
        capabilities: profile.config.capabilities,
        async complete(request) {
          if (!handler) throw new Error(`No scripted ${profile.role} provider`);
          return handler(request);
        },
      };
    },
  };
}

export function seedProfiles(store: Store, jobId: string, structuredOutput = true): void {
  const config = providerConfig(structuredOutput);
  store.insertProfiles(
    jobId,
    (["planner", "worker", "reviewer"] as const).map((role) => ({
      name: role,
      role,
      providerName: "fake",
      config,
    })),
  );
}

export function plannedTasks(
  tasks: Array<{ id: string; dependencies?: string[]; instructions?: string }>,
): PlannedTaskInput[] {
  return tasks.map((task) => ({
    stableId: task.id,
    title: task.id,
    instructions: task.instructions ?? `Implement ${task.id}`,
    acceptanceCriteria: [`${task.id} is done`],
    dependencies: task.dependencies ?? [],
    fileAreas: [`${task.id}.txt`],
  }));
}

export function planValue(
  tasks: Array<{ id: string; dependencies?: string[] }>,
  questions: string[] = [],
) {
  return {
    goal: "Ship the change",
    completionCriteria: ["The requested files exist"],
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.id,
      instructions: `Implement ${task.id}`,
      acceptanceCriteria: [`${task.id} is done`],
      dependencies: task.dependencies ?? [],
      fileAreas: [`${task.id}.txt`],
    })),
    risks: ["none"],
    assumptions: ["the repo is local"],
    questions,
  };
}

export function doneResult(summary = "done") {
  return { summary, status: "done" as const };
}

export function taskIdFromPrompt(prompt: string): string {
  const match = /Task ([A-Za-z0-9_-]+):/.exec(prompt);
  const id = match?.[1];
  if (!id) throw new Error(`Worker prompt did not name a task: ${prompt.slice(0, 200)}`);
  return id;
}

export function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value?: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value?: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res as (value?: T) => void;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export async function waitUntil(
  predicate: () => boolean,
  label: string,
  ms = 4_000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

export function seedRunning(
  store: Store,
  input: {
    repo: string;
    workerCount: number;
    maxAttempts?: number;
    tasks: Array<{ id: string; dependencies?: string[] }>;
    structuredOutput?: boolean;
  },
): string {
  const job = store.createJob({
    task: "seeded task",
    repoPath: input.repo,
    baseBranch: "main",
    workerCount: input.workerCount,
    configProfile: "default",
    dryRun: false,
    maxAttempts: input.maxAttempts ?? 2,
    maxReviewRounds: 3,
  });
  seedProfiles(store, job.id, input.structuredOutput ?? true);
  store.replacePlan(
    job.id,
    {
      goal: "Ship the change",
      completionCriteria: ["The requested files exist"],
      assumptions: [],
      risks: [],
      questions: [],
      raw: "{}",
    },
    plannedTasks(input.tasks),
    job.maxAttempts,
  );
  store.transitionJob(job.id, "running", { goal: "Ship the change", reviewState: "pending" });
  return job.id;
}

export function memoryHarness(
  dir: string,
  handlers: RoleHandlers,
  patch: Partial<SwarmConfig> = {},
  checks?: (cwd: string) => Promise<{ ok: boolean; summary: string }>,
): { store: Store; orchestrator: Orchestrator; repo: string; config: SwarmConfig } {
  const repo = path.join(dir, "repo");
  const dataDir = path.join(dir, "data");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const config = testConfig(dataDir, patch);
  const { store } = openStore(dir);
  const orchestrator = new Orchestrator(
    store,
    config,
    new MemoryWorkspace(),
    scriptedResolver(handlers),
    {
      recoverOnStart: false,
      checks: checks ?? (async () => ({ ok: true, summary: "No checks configured." })),
    },
  );
  return { store, orchestrator, repo, config };
}

export function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
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
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

export function initRepo(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "core.autocrlf", "false"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["config", "user.name", "Temp User"]);
  git(root, ["config", "user.email", "temp@example.com"]);
  fs.writeFileSync(path.join(root, "README.md"), "base\n", "utf8");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "init"]);
}
