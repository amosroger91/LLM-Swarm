import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { GitWorkspace } from "../src/git/workspace.js";
import { Orchestrator } from "../src/orchestration/service.js";
import {
  doneResult,
  git,
  initRepo,
  jsonResponse,
  openStore,
  plannedTasks,
  planValue,
  removeTemp,
  scriptedResolver,
  seedProfiles,
  taskIdFromPrompt,
  tempDir,
  testConfig,
} from "./helpers.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(removeTemp));

it.each(["broken", "valid"])(
  "reverifies a %s legacy prerequisite before allowing its dependent to run after recovery",
  async (behavior) => {
    const root = tempDir("swarm-legacy-verification-");
    dirs.push(root);
    const repo = path.join(root, "repo");
    initRepo(repo);
    fs.writeFileSync(
      path.join(repo, "verify.cjs"),
      'require("node:assert/strict").equal(require("node:fs").readFileSync("a.txt", "utf8"), "valid\\n", "legacy prerequisite contract");\n',
    );
    git(repo, ["add", "verify.cjs"]);
    git(repo, ["commit", "-m", "independent verifier"]);
    const config = testConfig(path.join(root, "data"), {
      requireChecks: true,
      checks: [{ command: process.execPath, args: ["verify.cjs"], protectedPaths: ["verify.cjs"] }],
    });
    const workspace = new GitWorkspace({
      authorName: config.gitAuthorName,
      authorEmail: config.gitAuthorEmail,
      timeoutMs: 10000,
      maxContextChars: 8000,
      policy: config.git,
    });
    const context = await workspace.assertRepo(repo);
    const store = openStore(root).store;
    const job = store.createJob({
      task: "Resume a job created before task verification existed",
      repoPath: repo,
      baseBranch: "main",
      baseCommit: context.baseCommit,
      workerCount: 1,
      configProfile: "default",
      dryRun: false,
      maxAttempts: 1,
      maxReviewRounds: 1,
    });
    seedProfiles(store, job.id);
    const tasks = [{ id: "a" }, { id: "b", dependencies: ["a"] }];
    const plan = planValue(tasks);
    store.replacePlan(job.id, { ...plan, raw: JSON.stringify(plan) }, plannedTasks(tasks), 1);
    store.transitionJob(job.id, "running");
    const [claim] = store.claimReady(job.id, 1, store.profileForRole(job.id, "worker").id);
    const predecessor = await workspace.createRunWorkspace({
      repoRoot: repo,
      dataDir: config.dataDir,
      jobId: job.id,
      stableId: "a",
      attempt: 1,
      baseCommit: context.baseCommit,
    });
    store.attachWorkspace(claim!.run.id, predecessor);
    fs.writeFileSync(path.join(predecessor.path, "a.txt"), `${behavior}\n`);
    const commit = await workspace.finalizeRun({
      repoRoot: repo,
      workspace: predecessor,
      message: "legacy successful implementation",
      allowedPaths: ["a.txt"],
      forbiddenPaths: ["verify.cjs"],
    });
    store.finishRun({
      runId: claim!.run.id,
      taskId: claim!.task.id,
      runStatus: "succeeded",
      taskStatus: "review",
      headCommit: commit.headCommit,
      requeue: false,
    });
    const launched: string[] = [];
    const orchestrator = new Orchestrator(
      store,
      config,
      workspace,
      scriptedResolver({
        worker: (request) => {
          launched.push(taskIdFromPrompt(request.prompt));
          fs.writeFileSync(path.join(request.cwd!, "b.txt"), "dependent\n");
          return jsonResponse(doneResult());
        },
        reviewer: () => jsonResponse({ approved: true, summary: "verified", findings: [] }),
      }),
    );
    try {
      expect(store.mustJob(job.id).status).toBe("interrupted");
      expect(store.listArtifacts(job.id)).toHaveLength(0);
      await orchestrator.resume(job.id);
      await orchestrator.waitFor(job.id);
      const proof = store
        .listArtifacts(job.id)
        .find((artifact) => artifact.kind === "dependency-checks");
      const child = store.listRuns(job.id).find((run) => run.taskId !== claim!.task.id)!;
      expect(JSON.parse(proof!.summary)).toMatchObject({
        status: behavior === "valid" ? "passed" : "failed",
        checkIndices: [0],
        commit: child.baseCommit,
      });
      expect(launched).toEqual(behavior === "valid" ? ["b"] : []);
      expect(store.mustJob(job.id).status).toBe(behavior === "valid" ? "completed" : "failed");
      if (behavior === "broken") expect(proof!.summary).toContain("legacy prerequisite contract");
    } finally {
      await orchestrator.shutdown();
      store.close();
    }
  },
);
