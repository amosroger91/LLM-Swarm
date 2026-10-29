import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SwarmError } from "../src/errors.js";
import { Orchestrator } from "../src/orchestration/service.js";
import { MemoryWorkspace } from "../src/git/workspace.js";
import { openDatabase } from "../src/db/connection.js";
import { Store } from "../src/db/store.js";
import {
  deferred,
  doneResult,
  jsonResponse,
  memoryHarness,
  planValue,
  removeTemp,
  seedRunning,
  taskIdFromPrompt,
  tempDir,
  waitUntil,
} from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) removeTemp(dir);
  }
});

function approvingReviewer() {
  return jsonResponse({ approved: true, summary: "accepted", findings: [] });
}

describe("scheduler", () => {
  it("returns a job id before the planner finishes", async () => {
    const dir = tempDir("swarm-early-");
    dirs.push(dir);
    const gate = deferred();
    let entered = false;
    const { store, orchestrator, repo } = memoryHarness(dir, {
      planner: async () => {
        entered = true;
        await gate.promise;
        return jsonResponse(planValue([{ id: "a" }]));
      },
    });
    const started = await orchestrator.startJob({ task: "early", repoPath: repo, dryRun: true });
    expect(entered).toBe(true);
    expect(started.status).toBe("planning");
    expect(orchestrator.result(started.job_id).ready).toBe(false);
    gate.resolve();
    await orchestrator.waitFor(started.job_id);
    expect(store.mustJob(started.job_id).status).toBe("completed");
    store.close();
  });

  it("rejects a worker count above the cap instead of clamping it", async () => {
    const dir = tempDir("swarm-cap-");
    dirs.push(dir);
    const { orchestrator, repo, store } = memoryHarness(dir, {});
    await expect(
      orchestrator.startJob({ task: "too many", repoPath: repo, workerCount: 6 }),
    ).rejects.toThrow(SwarmError);
    expect(store.listJobs()).toHaveLength(0);
    store.close();
  });

  it("runs one task at a time when workerCount is 1 and overlaps two of three when it is 2", async () => {
    const dir = tempDir("swarm-conc-");
    dirs.push(dir);
    const started: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred<void>>>();
    const { store, orchestrator, repo } = memoryHarness(dir, {
      worker: async (request) => {
        const id = taskIdFromPrompt(request.prompt);
        started.push(id);
        const gate = deferred();
        gates.set(id, gate);
        await gate.promise;
        return jsonResponse(doneResult(id));
      },
      reviewer: () => approvingReviewer(),
    });
    const serial = seedRunning(store, { repo, workerCount: 1, tasks: [{ id: "a" }, { id: "b" }] });
    const serialRun = orchestrator.execute(serial);
    await waitUntil(() => started.includes("a"), "task a");
    expect(started).not.toContain("b");
    gates.get("a")?.resolve();
    await waitUntil(() => started.includes("b"), "task b");
    gates.get("b")?.resolve();
    await serialRun;
    expect(store.mustJob(serial).status).toBe("completed");

    started.length = 0;
    gates.clear();
    const parallel = seedRunning(store, {
      repo,
      workerCount: 2,
      tasks: [{ id: "a" }, { id: "b" }, { id: "c" }],
    });
    const parallelRun = orchestrator.execute(parallel);
    await waitUntil(() => started.includes("a") && started.includes("b"), "a and b");
    expect(started).not.toContain("c");
    gates.get("a")?.resolve();
    await waitUntil(() => started.includes("c"), "task c");
    gates.get("b")?.resolve();
    gates.get("c")?.resolve();
    await parallelRun;
    expect(store.mustJob(parallel).status).toBe("completed");
    expect(store.listTasks(parallel).every((task) => task.status === "done")).toBe(true);
    store.close();
  });

  it("retries a failed worker result and a provider timeout", async () => {
    const dir = tempDir("swarm-retry-");
    dirs.push(dir);
    let calls = 0;
    const { store, orchestrator, repo } = memoryHarness(dir, {
      worker: () => {
        calls += 1;
        if (calls === 1) return jsonResponse({ summary: "compile failed", status: "failed" });
        return jsonResponse(doneResult("recovered"));
      },
      reviewer: () => approvingReviewer(),
    });
    const jobId = seedRunning(store, {
      repo,
      workerCount: 1,
      maxAttempts: 2,
      tasks: [{ id: "a" }],
    });
    await orchestrator.execute(jobId);
    expect(store.listRuns(jobId).map((run) => run.status)).toEqual(["failed", "succeeded"]);
    expect(store.mustJob(jobId).status).toBe("completed");
    store.close();

    const dirTimeout = tempDir("swarm-timeout-retry-");
    dirs.push(dirTimeout);
    let timed = 0;
    const first = deferred<ReturnType<typeof jsonResponse>>();
    const timeoutHarness = memoryHarness(
      dirTimeout,
      {
        worker: () => {
          timed += 1;
          if (timed === 1) return first.promise;
          return jsonResponse(doneResult("after timeout"));
        },
        reviewer: () => approvingReviewer(),
      },
      { providerTimeoutMs: 80 },
    );
    const timeoutJob = seedRunning(timeoutHarness.store, {
      repo: timeoutHarness.repo,
      workerCount: 1,
      maxAttempts: 2,
      tasks: [{ id: "a" }],
    });
    await timeoutHarness.orchestrator.execute(timeoutJob);
    first.resolve(jsonResponse(doneResult("late")));
    expect(timeoutHarness.store.listRuns(timeoutJob).map((run) => run.status)).toEqual([
      "timed_out",
      "succeeded",
    ]);
    expect(timeoutHarness.store.mustJob(timeoutJob).status).toBe("completed");
    timeoutHarness.store.close();
  });

  it("does not retry a blocked result and fails the job", async () => {
    const dir = tempDir("swarm-blocked-");
    dirs.push(dir);
    let calls = 0;
    const { store, orchestrator, repo } = memoryHarness(dir, {
      worker: () => {
        calls += 1;
        return jsonResponse({ summary: "need a human", status: "blocked" });
      },
    });
    const jobId = seedRunning(store, {
      repo,
      workerCount: 1,
      maxAttempts: 2,
      tasks: [{ id: "a" }],
    });
    await orchestrator.execute(jobId);
    expect(calls).toBe(1);
    expect(store.listTasks(jobId)[0]?.status).toBe("failed");
    expect(store.mustJob(jobId).status).toBe("failed");
    expect(store.mustJob(jobId).error ?? "").toContain("failed");
    store.close();
  });

  it("retries a blocked result that does not ask for a human", async () => {
    const dir = tempDir("swarm-blocked-retry-");
    dirs.push(dir);
    let calls = 0;
    const { store, orchestrator, repo } = memoryHarness(dir, {
      worker: () => {
        calls += 1;
        if (calls === 1) {
          return jsonResponse({ summary: "Task 1: Create index.html", status: "blocked" });
        }
        return jsonResponse(doneResult("wrote the file"));
      },
      reviewer: () => jsonResponse({ approved: true, summary: "ok", findings: [] }),
    });
    const jobId = seedRunning(store, {
      repo,
      workerCount: 1,
      maxAttempts: 2,
      tasks: [{ id: "a" }],
    });
    await orchestrator.execute(jobId);
    expect(calls).toBe(2);
    expect(store.listTasks(jobId)[0]?.status).not.toBe("failed");
    store.close();
  });

  it("cancels in-flight work and does not launch anything new", async () => {
    const dir = tempDir("swarm-cancel-");
    dirs.push(dir);
    const entered = deferred();
    const { store, orchestrator, repo } = memoryHarness(dir, {
      worker: (request) =>
        new Promise((_resolve, reject) => {
          entered.resolve();
          request.signal?.addEventListener("abort", () =>
            reject(new SwarmError("cancelled", "cancelled")),
          );
        }),
    });
    const jobId = seedRunning(store, {
      repo,
      workerCount: 1,
      tasks: [{ id: "a" }, { id: "b", dependencies: ["a"] }],
    });
    const pending = orchestrator.execute(jobId);
    await entered.promise;
    expect(orchestrator.cancel(jobId).status).toBe("cancel_requested");
    await pending;
    expect(store.mustJob(jobId).status).toBe("cancelled");
    const tasks = store.listTasks(jobId);
    expect(tasks.find((task) => task.stableId === "a")?.status).toBe("cancelled");
    expect(tasks.find((task) => task.stableId === "b")?.status).not.toBe("running");
    expect(store.listRuns(jobId).every((run) => run.status !== "running")).toBe(true);
    store.close();
  });

  it("fails the job on the job timeout instead of marking it cancelled", async () => {
    const dir = tempDir("swarm-job-timeout-");
    dirs.push(dir);
    const { store, orchestrator, repo } = memoryHarness(
      dir,
      {
        worker: (request) =>
          new Promise((_resolve, reject) => {
            request.signal?.addEventListener("abort", () =>
              reject(new SwarmError("aborted", "aborted")),
            );
          }),
      },
      { jobTimeoutMs: 120, providerTimeoutMs: 10_000 },
    );
    const jobId = seedRunning(store, { repo, workerCount: 1, tasks: [{ id: "a" }] });
    await orchestrator.execute(jobId);
    const job = store.mustJob(jobId);
    expect(job.status).toBe("failed");
    expect(job.error ?? "").toContain("timed out");
    store.close();
  });

  it("recovers a crashed run on restart and leaves the task claimable", () => {
    const dir = tempDir("swarm-interrupt-");
    dirs.push(dir);
    const { store, repo, config } = memoryHarness(dir, {});
    const jobId = seedRunning(store, {
      repo,
      workerCount: 1,
      maxAttempts: 2,
      tasks: [{ id: "a" }],
    });
    const profile = store.profileForRole(jobId, "worker");
    expect(store.claimReady(jobId, 1, profile.id)).toHaveLength(1);
    store.close();

    const reopened = new Store(openDatabase(path.join(dir, "swarm.db")));
    const restarted = new Orchestrator(reopened, config, new MemoryWorkspace(), {
      forProfile() {
        throw new Error("restart recovery does not call a provider");
      },
    });
    expect(reopened.mustJob(jobId).status).toBe("interrupted");
    expect(reopened.listRuns(jobId)[0]?.status).toBe("interrupted");
    expect(reopened.listTasks(jobId)[0]?.status).toBe("ready");
    expect(reopened.claimReady(jobId, 1, profile.id)).toHaveLength(1);
    expect(reopened.recoverInterrupted()).toEqual({ jobs: 0, runs: 1, tasks: 1 });
    void restarted;
    reopened.close();

    const dir2 = tempDir("swarm-interrupt-max-");
    dirs.push(dir2);
    const second = memoryHarness(dir2, {});
    const job2 = seedRunning(second.store, {
      repo: second.repo,
      workerCount: 1,
      maxAttempts: 1,
      tasks: [{ id: "a" }],
    });
    const profile2 = second.store.profileForRole(job2, "worker");
    second.store.claimReady(job2, 1, profile2.id);
    second.store.close();
    const exhausted = new Store(openDatabase(path.join(dir2, "swarm.db")));
    exhausted.recoverInterrupted();
    expect(exhausted.listTasks(job2)[0]?.status).toBe("failed");
    expect(exhausted.mustJob(job2).status).toBe("interrupted");
    exhausted.close();
  });

  it("fails a dependency cycle as a deadlock and opens one revision after a check failure", async () => {
    const dir = tempDir("swarm-dead-");
    dirs.push(dir);
    const { store, orchestrator, repo } = memoryHarness(dir, {});
    const jobId = seedRunning(store, {
      repo,
      workerCount: 1,
      tasks: [
        { id: "a", dependencies: ["b"] },
        { id: "b", dependencies: ["a"] },
      ],
    });
    await orchestrator.execute(jobId);
    expect(store.mustJob(jobId).status).toBe("failed");
    expect(store.mustJob(jobId).error ?? "").toContain("blocked");
    store.close();

    const dir2 = tempDir("swarm-checks-");
    dirs.push(dir2);
    let checks = 0;
    let reviews = 0;
    const second = memoryHarness(
      dir2,
      {
        worker: (request) => {
          const id = taskIdFromPrompt(request.prompt);
          if (request.cwd) fs.writeFileSync(path.join(request.cwd, `${id}.txt`), id, "utf8");
          return jsonResponse(doneResult(id));
        },
        reviewer: () => {
          reviews += 1;
          return approvingReviewer();
        },
      },
      {},
      async () => {
        checks += 1;
        if (checks === 1) return { ok: false, summary: "npm test failed" };
        return { ok: true, summary: "ok" };
      },
    );
    const checkJob = seedRunning(second.store, {
      repo: second.repo,
      workerCount: 1,
      tasks: [{ id: "a" }],
    });
    await second.orchestrator.execute(checkJob);
    expect(second.store.mustJob(checkJob).status).toBe("completed");
    expect(reviews).toBe(1);
    const revision = second.store.listTasks(checkJob).find((task) => task.kind === "revision");
    expect(revision?.stableId).toBe("revision-2");
    expect(revision?.status).toBe("done");
    second.store.close();
  });
});
