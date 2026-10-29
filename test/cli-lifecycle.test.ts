import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/db/store.js";
import { openDatabase } from "../src/db/connection.js";
import { MemoryWorkspace } from "../src/git/workspace.js";
import { Orchestrator } from "../src/orchestration/service.js";
import {
  memoryHarness,
  projectRoot,
  removeTemp,
  seedRunning,
  tempDir,
  waitUntil,
  openStore,
  testConfig,
} from "./helpers.js";

const exec = promisify(execFile);
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(removeTemp));
const noProviders = {
  forProfile() {
    throw new Error("No provider expected");
  },
};

describe("scheduler lifecycle", () => {
  it("keeps status/result read-only and cancels a live worker from another process", async () => {
    const root = tempDir("swarm-cli-state-");
    dirs.push(root);
    let workerAborted = false;
    const { store, orchestrator, repo, config } = memoryHarness(root, {
      worker: (request) =>
        new Promise((_, reject) => {
          request.signal?.addEventListener(
            "abort",
            () => {
              workerAborted = true;
              reject(new Error("cancelled"));
            },
            { once: true },
          );
        }),
    });
    const id = seedRunning(store, { repo, workerCount: 1, tasks: [{ id: "a" }, { id: "b" }] });
    const configPath = path.join(root, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ ...config, database: path.join(root, "swarm.db") }),
    );
    const run = orchestrator.execute(id);
    await waitUntil(() => store.listRuns(id).length === 1, "worker claim");
    for (const command of ["status", "result"]) {
      const result = await exec(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", command, id, "--config", configPath],
        { cwd: projectRoot, windowsHide: true },
      );
      expect(JSON.parse(result.stdout).status).toBe("running");
      expect(store.mustJob(id).status).toBe("running");
      expect(store.listTasks(id)[0]?.status).toBe("running");
    }
    await exec(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "cancel", id, "--config", configPath],
      { cwd: projectRoot, windowsHide: true },
    );
    await run;
    expect(workerAborted).toBe(true);
    expect(store.mustJob(id).status).toBe("cancelled");
    expect(store.listRuns(id)).toHaveLength(1);
    expect(store.listTasks(id).every((task) => task.status === "cancelled")).toBe(true);
    store.close();
  });

  it("refuses a second scheduler without recovering the live owner's jobs", () => {
    const root = tempDir("swarm-owner-");
    dirs.push(root);
    const first = memoryHarness(root, {});
    const id = seedRunning(first.store, { repo: first.repo, workerCount: 1, tasks: [{ id: "a" }] });
    const second = new Store(openDatabase(path.join(root, "swarm.db")));
    expect(
      () => new Orchestrator(second, first.config, new MemoryWorkspace(), noProviders),
    ).toThrow(/already running/);
    try {
      new Orchestrator(second, first.config, new MemoryWorkspace(), noProviders);
    } catch (error) {
      expect(error).toMatchObject({ code: "scheduler_busy" });
    }
    expect(first.store.mustJob(id).status).toBe("running");
    second.close();
    first.store.close();
    const third = openStore(root).store;
    new Orchestrator(third, first.config, new MemoryWorkspace(), noProviders);
    expect(third.mustJob(id).status).toBe("interrupted");
    third.close();
  });

  it("recovers abandoned ownership after the owning process exits", async () => {
    const root = tempDir("swarm-owner-crash-");
    dirs.push(root);
    const result = await exec(
      process.execPath,
      ["--import", "tsx", "test/fixtures/abandon-scheduler.ts", root],
      { cwd: projectRoot, windowsHide: true },
    );
    const id = result.stdout.trim();
    const store = openStore(root).store;
    new Orchestrator(store, testConfig(root), new MemoryWorkspace(), noProviders);
    expect(store.mustJob(id).status).toBe("interrupted");
    expect(store.listRuns(id)[0]?.status).toBe("interrupted");
    store.close();
  });
});
