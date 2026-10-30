import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { databasePath, loadConfig } from "../src/config/load.js";
import { openDatabase } from "../src/db/connection.js";
import { Store } from "../src/db/store.js";
import {
  openStore,
  plannedTasks,
  projectRoot,
  removeTemp,
  seedProfiles,
  tempDir,
} from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) removeTemp(dir);
  }
});

describe("database", () => {
  it("applies the migration once and keeps jobs across a restart", () => {
    const dir = tempDir("swarm-db-");
    dirs.push(dir);
    const { store, dbPath } = openStore(dir);
    const job = store.createJob({
      task: "persist me",
      repoPath: dir,
      baseBranch: "main",
      workerCount: 2,
      configProfile: "default",
      dryRun: false,
      maxAttempts: 2,
      maxReviewRounds: 3,
    });
    store.close();

    const db = openDatabase(dbPath);
    const versions = db.prepare("SELECT version, name FROM schema_migrations").all() as Array<{
      version: number;
      name: string;
    }>;
    expect(versions).toEqual([
      { version: 1, name: "initial" },
      { version: 2, name: "scheduler_ownership_and_pinned_base" },
      { version: 3, name: "coordination_and_measurements" },
      { version: 4, name: "blockers_and_recovery" },
      { version: 5, name: "planner_task_proposals" },
      { version: 6, name: "immutable_human_goal" },
      { version: 7, name: "clear_resolved_task_errors" },
      { version: 8, name: "provider_failover_and_delegations" },
    ]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(String(db.pragma("journal_mode", { simple: true }))).toBe("wal");
    const reopened = new Store(db);
    expect(reopened.mustJob(job.id).task).toBe("persist me");
    expect(reopened.mustJob(job.id).status).toBe("planning");
    reopened.close();
  });

  it("makes a dependent ready only after the predecessor is review, revision, or done", () => {
    const dir = tempDir("swarm-deps-");
    dirs.push(dir);
    const { store } = openStore(dir);
    const job = store.createJob({
      task: "graph",
      repoPath: dir,
      baseBranch: "main",
      workerCount: 2,
      configProfile: null,
      dryRun: false,
      maxAttempts: 2,
      maxReviewRounds: 3,
    });
    seedProfiles(store, job.id);
    store.replacePlan(
      job.id,
      {
        goal: "graph",
        completionCriteria: ["c"],
        assumptions: [],
        risks: [],
        questions: [],
        raw: "{}",
      },
      plannedTasks([
        { id: "a" },
        { id: "b", dependencies: ["a"] },
        { id: "c", dependencies: ["a", "b"] },
      ]),
      2,
    );
    const profile = store.profileForRole(job.id, "worker");
    const first = store.claimReady(job.id, 5, profile.id);
    expect(first.map((claim) => claim.task.stableId)).toEqual(["a"]);
    store.finishRun({
      runId: first[0]!.run.id,
      taskId: first[0]!.task.id,
      runStatus: "succeeded",
      taskStatus: "review",
      summary: "a",
      requeue: false,
    });
    const second = store.claimReady(job.id, 5, profile.id);
    expect(second.map((claim) => claim.task.stableId)).toEqual(["b"]);
    const b = store.listTasks(job.id).find((task) => task.stableId === "b");
    store.finishRun({
      runId: second[0]!.run.id,
      taskId: second[0]!.task.id,
      runStatus: "succeeded",
      taskStatus: "review",
      summary: "b",
      requeue: false,
    });
    expect(b).toBeTruthy();
    const third = store.claimReady(job.id, 5, profile.id);
    expect(third.map((claim) => claim.task.stableId)).toEqual(["c"]);
    store.close();
  });

  it("rejects a second in-process claim of the same ready task", () => {
    const dir = tempDir("swarm-claim-local-");
    dirs.push(dir);
    const { store } = openStore(dir);
    const job = store.createJob({
      task: "one",
      repoPath: dir,
      baseBranch: "main",
      workerCount: 2,
      configProfile: null,
      dryRun: false,
      maxAttempts: 2,
      maxReviewRounds: 3,
    });
    seedProfiles(store, job.id);
    store.replacePlan(
      job.id,
      {
        goal: "one",
        completionCriteria: ["a"],
        assumptions: [],
        risks: [],
        questions: [],
        raw: "{}",
      },
      plannedTasks([{ id: "a" }]),
      2,
    );
    const profile = store.profileForRole(job.id, "worker");
    expect(store.claimReady(job.id, 1, profile.id)).toHaveLength(1);
    expect(store.claimReady(job.id, 1, profile.id)).toHaveLength(0);
    expect(store.listTasks(job.id)[0]?.status).toBe("running");
    store.close();
  });

  it("loads the example config and resolves paths from the config file", () => {
    const file = path.join(projectRoot, "config", "swarm.example.yaml");
    const config = loadConfig(file);
    expect(config.defaultProfile).toBe("default");
    expect(config.profiles.default?.worker).toBe("ollama-worker");
    expect(config.providers.ollama?.type).toBe("openai_compatible");
    expect(config.providers.grok?.type).toBe("cli");
    expect(config.git.allowPush).toBe(false);
    expect(config.dataDir).toBe(path.resolve(path.dirname(file), ".swarm-data"));
    expect(databasePath(config)).toBe(path.join(config.dataDir, "swarm.db"));
    expect(fs.existsSync(file)).toBe(true);
  });
});
