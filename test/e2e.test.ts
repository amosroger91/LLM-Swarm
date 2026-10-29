import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitWorkspace } from "../src/git/workspace.js";
import { Orchestrator } from "../src/orchestration/service.js";
import { openDatabase } from "../src/db/connection.js";
import { Store } from "../src/db/store.js";
import {
  doneResult,
  git,
  initRepo,
  jsonResponse,
  planValue,
  removeTemp,
  scriptedResolver,
  taskIdFromPrompt,
  tempDir,
  testConfig,
} from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) removeTemp(dir);
  }
});

function gitWorkspace(): GitWorkspace {
  return new GitWorkspace({
    authorName: "LLM Swarm",
    authorEmail: "swarm@localhost",
    timeoutMs: 20_000,
    maxContextChars: 20_000,
    policy: {
      cleanupWorktrees: true,
      preserveOnFailure: true,
      allowPush: false,
      allowMergeToBase: false,
      allowRemotePr: false,
    },
  });
}

describe("end to end", () => {
  it("plans, runs isolated workers, reviews, and keeps status after the snapshot is deleted", async () => {
    const dir = tempDir("swarm-e2e-");
    dirs.push(dir);
    const repo = path.join(dir, "repo");
    const dataDir = path.join(dir, "data");
    initRepo(repo);
    const config = testConfig(dataDir, {
      writeSnapshot: true,
      providerTimeoutMs: 20_000,
      jobTimeoutMs: 30_000,
    });
    const store = new Store(openDatabase(path.join(dir, "swarm.db")));
    const orchestrator = new Orchestrator(
      store,
      config,
      gitWorkspace(),
      scriptedResolver({
        planner: () =>
          jsonResponse(
            planValue([{ id: "a" }, { id: "b" }, { id: "c", dependencies: ["a", "b"] }]),
          ),
        worker: (request) => {
          const id = taskIdFromPrompt(request.prompt);
          if (!request.cwd) throw new Error("worker was not given a worktree");
          if (id === "c") {
            expect(fs.readFileSync(path.join(request.cwd, "a.txt"), "utf8")).toBe("a\n");
            expect(fs.readFileSync(path.join(request.cwd, "b.txt"), "utf8")).toBe("b\n");
            expect(request.prompt).toContain('FILE "a.txt"');
          }
          fs.writeFileSync(path.join(request.cwd, `${id}.txt`), `${id}\n`, "utf8");
          return jsonResponse(doneResult(`wrote ${id}`));
        },
        reviewer: () =>
          jsonResponse({ approved: true, summary: "all files present", findings: [] }),
      }),
      { recoverOnStart: false },
    );
    const started = await orchestrator.startJob({
      task: "write three files",
      repoPath: repo,
      workerCount: 2,
    });
    expect(started.job_id).toBeTruthy();
    await orchestrator.waitFor(started.job_id);
    const job = store.mustJob(started.job_id);
    expect(job.status).toBe("completed");
    expect(job.reviewState).toBe("approved");
    expect(store.listTasks(job.id).every((task) => task.status === "done")).toBe(true);
    const snapshot = job.snapshotPath;
    expect(snapshot).toBeTruthy();
    expect(fs.readFileSync(String(snapshot), "utf8")).toContain("GENERATED FILE");
    const integration = path.join(repo, "workspaces", job.id, "integration");
    expect(fs.readFileSync(path.join(integration, "a.txt"), "utf8")).toBe("a\n");
    expect(fs.readFileSync(path.join(integration, "b.txt"), "utf8")).toBe("b\n");
    expect(fs.readFileSync(path.join(integration, "c.txt"), "utf8")).toBe("c\n");
    expect(git(repo, ["show", "main:README.md"])).toBe("base\n");
    fs.rmSync(String(snapshot), { force: true });
    store.close();

    const reopened = new Store(openDatabase(path.join(dir, "swarm.db")));
    const restarted = new Orchestrator(reopened, config, gitWorkspace(), scriptedResolver({}), {
      recoverOnStart: true,
    });
    void restarted;
    expect(reopened.mustJob(job.id).status).toBe("completed");
    expect(reopened.mustJob(job.id).finalReport ?? "").toContain("all files present");
    reopened.close();
  });

  it("creates one revision after rejection and then accepts it", async () => {
    const dir = tempDir("swarm-e2e-rev-");
    dirs.push(dir);
    const repo = path.join(dir, "repo");
    const dataDir = path.join(dir, "data");
    initRepo(repo);
    const config = testConfig(dataDir, { writeSnapshot: true, providerTimeoutMs: 20_000 });
    const store = new Store(openDatabase(path.join(dir, "swarm.db")));
    let reviews = 0;
    const orchestrator = new Orchestrator(
      store,
      config,
      gitWorkspace(),
      scriptedResolver({
        planner: () => jsonResponse(planValue([{ id: "a" }])),
        worker: (request) => {
          const id = taskIdFromPrompt(request.prompt);
          if (!request.cwd) throw new Error("missing worktree");
          fs.writeFileSync(path.join(request.cwd, `${id}.txt`), `${id}\n`, "utf8");
          return jsonResponse(doneResult(id));
        },
        reviewer: () => {
          reviews += 1;
          if (reviews === 1) {
            return jsonResponse({
              approved: false,
              summary: "missing the note",
              findings: [
                {
                  severity: "major",
                  file: "a.txt",
                  line: 1,
                  message: "The note is incomplete",
                  instruction: "Add the revision file",
                },
              ],
            });
          }
          return jsonResponse({ approved: true, summary: "revision accepted", findings: [] });
        },
      }),
      { recoverOnStart: false },
    );
    const started = await orchestrator.startJob({
      task: "needs a revision",
      repoPath: repo,
      workerCount: 1,
    });
    await orchestrator.waitFor(started.job_id);
    expect(store.mustJob(started.job_id).status).toBe("completed");
    const revision = store.listTasks(started.job_id).find((task) => task.kind === "revision");
    expect(revision?.stableId).toBe("revision-2");
    expect(revision?.status).toBe("done");
    const integration = path.join(repo, "workspaces", started.job_id, "integration");
    expect(fs.existsSync(path.join(integration, "revision-2.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(integration, "a.txt"), "utf8")).toBe("a\n");
    expect(store.listReviews(started.job_id).map((review) => review.status)).toEqual([
      "rejected",
      "approved",
    ]);
    store.close();
  });

  it("rejects worker changes outside assigned files before integration", async () => {
    const dir = tempDir("swarm-e2e-conflict-");
    dirs.push(dir);
    const repo = path.join(dir, "repo");
    const dataDir = path.join(dir, "data");
    initRepo(repo);
    const config = testConfig(dataDir, { writeSnapshot: false, providerTimeoutMs: 20_000 });
    const store = new Store(openDatabase(path.join(dir, "swarm.db")));
    let reviews = 0;
    const orchestrator = new Orchestrator(
      store,
      config,
      gitWorkspace(),
      scriptedResolver({
        planner: () => jsonResponse(planValue([{ id: "a" }, { id: "b" }])),
        worker: (request) => {
          const id = taskIdFromPrompt(request.prompt);
          if (!request.cwd) throw new Error("missing worktree");
          fs.writeFileSync(path.join(request.cwd, "README.md"), `from-${id}\n`, "utf8");
          return jsonResponse(doneResult(id));
        },
        reviewer: () => {
          reviews += 1;
          return jsonResponse({ approved: true, summary: "should not run", findings: [] });
        },
      }),
      { recoverOnStart: false },
    );
    const started = await orchestrator.startJob({
      task: "conflict on purpose",
      repoPath: repo,
      workerCount: 2,
    });
    await orchestrator.waitFor(started.job_id);
    const job = store.mustJob(started.job_id);
    expect(job.status).toBe("failed");
    expect(job.error ?? "").toContain("tasks failed");
    expect(store.listTasks(job.id).every((task) => task.error?.includes("unowned file"))).toBe(
      true,
    );
    expect(reviews).toBe(0);
    expect(git(repo, ["show", "main:README.md"])).toBe("base\n");
    const worktrees = store.listWorktrees(job.id);
    expect(worktrees.length).toBeGreaterThanOrEqual(2);
    expect(worktrees.every((item) => item.cleanupState === "preserved")).toBe(true);
    const contents = worktrees.map((item) =>
      fs.readFileSync(path.join(item.path, "README.md"), "utf8"),
    );
    expect(contents).toContain("from-a\n");
    expect(contents).toContain("from-b\n");
    store.close();
  });
});
