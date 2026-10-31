import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SwarmConfig } from "../src/config/schema.js";
import { GitWorkspace } from "../src/git/workspace.js";
import { Orchestrator } from "../src/orchestration/service.js";
import { validatePlan } from "../src/orchestration/planner.js";
import {
  doneResult,
  git,
  initRepo,
  jsonResponse,
  openStore,
  planValue,
  removeTemp,
  scriptedResolver,
  taskIdFromPrompt,
  tempDir,
  testConfig,
  waitUntil,
  type RoleHandlers,
} from "./helpers.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(removeTemp));
const approve = () => jsonResponse({ approved: true, summary: "checked", findings: [] });

function fixture(handlers: RoleHandlers, patch: Partial<SwarmConfig> = {}) {
  const root = tempDir("swarm-task-verification-");
  dirs.push(root);
  const repo = path.join(root, "repo");
  initRepo(repo);
  const config = testConfig(path.join(root, "data"), {
    requireChecks: true,
    defaultMaxAttempts: 1,
    providerTimeoutMs: 10000,
    jobTimeoutMs: 60000,
    ...patch,
  });
  const store = openStore(root).store;
  const workspace = new GitWorkspace({
    authorName: config.gitAuthorName,
    authorEmail: config.gitAuthorEmail,
    timeoutMs: 10000,
    policy: config.git,
    maxContextChars: 20000,
  });
  const orchestrator = new Orchestrator(store, config, workspace, scriptedResolver(handlers), {
    recoverOnStart: false,
  });
  return { root, repo, config, store, orchestrator };
}

type Fixture = ReturnType<typeof fixture>;
interface TaskCheckEvidence {
  status: "passed" | "failed" | "not_run";
  summary: string;
  commit: string;
  checkIndices: number[];
}

function taskChecks(state: Fixture, jobId: string) {
  return state.store
    .listArtifacts(jobId)
    .filter((artifact) => artifact.kind === "task-checks")
    .map((artifact) => ({
      ...artifact,
      evidence: JSON.parse(artifact.summary) as TaskCheckEvidence,
    }));
}

function addCheck(state: Fixture, file: string, body: string) {
  const source = [
    'import assert from "node:assert/strict";',
    'import fs from "node:fs";',
    'import path from "node:path";',
    'import { spawnSync } from "node:child_process";',
    "const cwd = process.cwd();",
    'const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", windowsHide: true });',
    "assert.equal(revision.status, 0);",
    "const commit = revision.stdout.trim();",
    'console.log("checked-commit:" + commit);',
    body,
    "",
  ].join("\n");
  fs.mkdirSync(path.dirname(path.join(state.repo, file)), { recursive: true });
  fs.writeFileSync(path.join(state.repo, file), source);
  git(state.repo, ["add", file]);
  git(state.repo, ["commit", "-m", `trusted checker ${file}`]);
  state.config.checks.push({
    command: process.execPath,
    args: [file],
    protectedPaths: [file],
  });
  return source;
}

describe("coordinator task verification", () => {
  it("withholds a dependency until its selected check passes and reruns every check on integration", async () => {
    const seen: string[] = [];
    const state = fixture({
      worker: (request) => {
        const id = taskIdFromPrompt(request.prompt);
        seen.push(id);
        if (id === "b") {
          expect(fs.readFileSync(path.join(request.cwd!, "a.txt"), "utf8")).toBe("a\n");
          expect(taskChecks(state, request.metadata!.jobId!)[0]!.evidence.status).toBe("passed");
        }
        fs.writeFileSync(path.join(request.cwd!, `${id}.txt`), `${id}\n`);
        return jsonResponse(doneResult(id));
      },
      reviewer: approve,
    });
    const entered = path.join(state.root, "checker-entered");
    const release = path.join(state.root, "release-checker");
    const log = path.join(state.root, "check-runs.jsonl");
    addCheck(
      state,
      "verify-a.mjs",
      `assert.equal(fs.readFileSync("a.txt", "utf8"), "a\\n");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({check: 0, cwd, commit}) + "\\n");
if (path.basename(cwd) === "agent-a-1") {
  fs.writeFileSync(${JSON.stringify(entered)}, commit);
  while (!fs.existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 15));
}`,
    );
    addCheck(
      state,
      "verify-b.mjs",
      `assert.equal(fs.readFileSync("b.txt", "utf8"), "b\\n");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({check: 1, cwd, commit}) + "\\n");`,
    );
    const plan = planValue([{ id: "a" }, { id: "b", dependencies: ["a"] }]);
    const selected = {
      ...plan,
      tasks: plan.tasks.map((task, index) => ({ ...task, verificationChecks: [index] })),
    };
    try {
      const job = await state.orchestrator.startJob({
        task: "Implement dependent outputs",
        repoPath: state.repo,
        workerCount: 2,
        plan: selected,
      });
      await waitUntil(() => fs.existsSync(entered), "the prerequisite checker to start", 10000);
      expect(seen).toEqual(["a"]);
      expect(state.store.listTasks(job.job_id).find((task) => task.stableId === "a")!.status).toBe(
        "running",
      );
      expect(state.store.listRuns(job.job_id)).toHaveLength(1);
      fs.writeFileSync(release, "continue");
      await state.orchestrator.waitFor(job.job_id);
      expect(state.store.mustJob(job.job_id).status).toBe("completed");
      expect(seen).toEqual(["a", "b"]);
      const evidence = taskChecks(state, job.job_id);
      expect(evidence).toHaveLength(2);
      for (const [index, artifact] of evidence.entries()) {
        const run = state.store.listRuns(job.job_id).find((item) => item.id === artifact.runId)!;
        expect(artifact.taskId).toBe(run.taskId);
        expect(artifact.evidence).toMatchObject({
          status: "passed",
          checkIndices: index === 0 ? [0] : [0, 1],
          commit: run.headCommit,
        });
        expect(artifact.evidence.commit).toMatch(/^[a-f0-9]{40}$/);
        expect(artifact.evidence.summary).toContain(`checked-commit:${run.headCommit}`);
      }
      const executions = fs
        .readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { check: number; cwd: string });
      expect(executions.map((entry) => [entry.check, path.basename(entry.cwd)])).toEqual([
        [0, "agent-a-1"],
        [0, "agent-b-1"],
        [1, "agent-b-1"],
        [0, "integration"],
        [1, "integration"],
      ]);
      expect(
        state.store.listArtifacts(job.job_id).filter((item) => item.kind === "checks"),
      ).toHaveLength(1);
    } finally {
      fs.writeFileSync(release, "continue");
      await state.orchestrator.shutdown();
      state.store.close();
    }
  });

  it("rechecks ancestor contracts when a dependent edits shared code and withholds downstream work on regression", async () => {
    const launched: string[] = [];
    const state = fixture({
      worker: (request) => {
        const id = taskIdFromPrompt(request.prompt);
        launched.push(id);
        if (id === "a") fs.writeFileSync(path.join(request.cwd!, "shared.txt"), "ancestor\n");
        else if (id === "b") {
          expect(fs.readFileSync(path.join(request.cwd!, "shared.txt"), "utf8")).toBe("ancestor\n");
          fs.writeFileSync(path.join(request.cwd!, "shared.txt"), "descendant\n");
        } else fs.writeFileSync(path.join(request.cwd!, "c.txt"), "should not run\n");
        return jsonResponse(doneResult(id));
      },
      reviewer: approve,
    });
    addCheck(
      state,
      "verify-ancestor.mjs",
      'assert.match(fs.readFileSync("shared.txt", "utf8"), /ancestor/, "ancestor contract regressed");',
    );
    addCheck(
      state,
      "verify-descendant.mjs",
      'assert.match(fs.readFileSync("shared.txt", "utf8"), /descendant/);',
    );
    const plan = planValue([
      { id: "a" },
      { id: "b", dependencies: ["a"] },
      { id: "c", dependencies: ["b"] },
    ]);
    const selected = {
      ...plan,
      tasks: plan.tasks.map((task, index) => ({
        ...task,
        fileAreas: index < 2 ? ["shared.txt"] : ["c.txt"],
        verificationChecks: [index === 0 ? 0 : 1],
      })),
    };
    try {
      const job = await state.orchestrator.startJob({
        task: "Extend shared behavior while preserving the ancestor contract",
        repoPath: state.repo,
        plan: selected,
      });
      await state.orchestrator.waitFor(job.job_id);
      expect(state.store.mustJob(job.job_id).status).toBe("failed");
      expect(launched).toEqual(["a", "b"]);
      const evidence = taskChecks(state, job.job_id);
      expect(evidence.map((item) => item.evidence.status)).toEqual(["passed", "failed"]);
      expect(evidence[1]!.evidence.checkIndices).toEqual([0, 1]);
      expect(evidence[1]!.evidence.summary).toContain("ancestor contract regressed");
      expect(state.store.listReviews(job.job_id)).toHaveLength(0);
    } finally {
      await state.orchestrator.shutdown();
      state.store.close();
    }
  });

  it("checks every configured verifier by default and repairs a failed committed checkpoint with its evidence", async () => {
    let attempts = 0;
    let reviews = 0;
    const state = fixture(
      {
        worker: (request) => {
          const file = path.join(request.cwd!, "a.txt");
          if (++attempts === 1) fs.writeFileSync(file, "broken\n");
          else {
            expect(fs.readFileSync(file, "utf8")).toBe("broken\n");
            expect(request.prompt).toContain("repair-evidence:broken");
            fs.writeFileSync(file, "fixed\n");
          }
          return jsonResponse(doneResult());
        },
        reviewer: () => {
          reviews++;
          return approve();
        },
      },
      { defaultMaxAttempts: 2 },
    );
    addCheck(state, "verify-exists.mjs", 'assert.ok(fs.existsSync("a.txt"));');
    addCheck(
      state,
      "verify-value.mjs",
      'const value = fs.readFileSync("a.txt", "utf8"); console.log("repair-evidence:" + value.trim()); assert.equal(value, "fixed\\n");',
    );
    try {
      const job = await state.orchestrator.startJob({
        task: "Implement verified output",
        repoPath: state.repo,
        plan: planValue([{ id: "a" }]),
      });
      await state.orchestrator.waitFor(job.job_id);
      expect(state.store.mustJob(job.job_id).status).toBe("completed");
      expect(attempts).toBe(2);
      expect(reviews).toBe(1);
      const runs = state.store.listRuns(job.job_id).filter((run) => run.role === "worker");
      expect(runs.map((run) => run.status)).toEqual(["failed", "succeeded"]);
      expect(runs[0]!.headCommit).toMatch(/^[a-f0-9]{40}$/);
      expect(runs[1]!.baseCommit).toBe(runs[0]!.headCommit);
      expect(runs[1]!.headCommit).not.toBe(runs[0]!.headCommit);
      const evidence = taskChecks(state, job.job_id);
      expect(evidence.map((item) => item.evidence.status)).toEqual(["failed", "passed"]);
      evidence.forEach((item, index) => {
        expect(item.runId).toBe(runs[index]!.id);
        expect(item.evidence.checkIndices).toEqual([0, 1]);
        expect(item.evidence.commit).toBe(runs[index]!.headCommit);
      });
      expect(evidence[0]!.evidence.summary).toContain("repair-evidence:broken");
      expect(
        fs.readFileSync(
          path.join(state.repo, "workspaces", job.job_id, "integration/a.txt"),
          "utf8",
        ),
      ).toBe("fixed\n");
    } finally {
      await state.orchestrator.shutdown();
      state.store.close();
    }
  });

  it("retains a finalized checkpoint when verification is cancelled and verifies it after resume", async () => {
    let attempts = 0;
    const state = fixture({
      worker: (request) => {
        const file = path.join(request.cwd!, "a.txt");
        if (++attempts === 1) fs.writeFileSync(file, "persisted before verification\n");
        else expect(fs.readFileSync(file, "utf8")).toBe("persisted before verification\n");
        return jsonResponse(doneResult());
      },
      reviewer: approve,
    });
    const entered = path.join(state.root, "checker-entered");
    const release = path.join(state.root, "release-checker");
    addCheck(
      state,
      "verify.mjs",
      `assert.equal(fs.readFileSync("a.txt", "utf8"), "persisted before verification\\n");
if (path.basename(cwd) === "agent-a-1") {
  fs.writeFileSync(${JSON.stringify(entered)}, commit);
  while (!fs.existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 15));
}`,
    );
    try {
      const job = await state.orchestrator.startJob({
        task: "Preserve finalized implementation during interrupted verification",
        repoPath: state.repo,
        plan: planValue([{ id: "a" }]),
      });
      await waitUntil(() => fs.existsSync(entered), "verification before cancellation", 10000);
      const checkpoint = fs.readFileSync(entered, "utf8");
      expect(state.store.listRuns(job.job_id)[0]).toMatchObject({
        status: "running",
        headCommit: checkpoint,
      });
      expect(state.store.listWorktrees(job.job_id)[0]!.headCommit).toBe(checkpoint);
      state.orchestrator.cancel(job.job_id);
      await state.orchestrator.waitFor(job.job_id);
      expect(state.store.mustJob(job.job_id).status).toBe("cancelled");
      await state.orchestrator.resume(job.job_id);
      await state.orchestrator.waitFor(job.job_id);
      expect(state.store.mustJob(job.job_id).status).toBe("completed");
      expect(attempts).toBe(2);
      const runs = state.store.listRuns(job.job_id);
      expect(runs.map((run) => run.status)).toEqual(["cancelled", "succeeded"]);
      expect(runs[1]!.baseCommit).toBe(checkpoint);
      expect(runs[1]!.headCommit).toBe(checkpoint);
      expect(taskChecks(state, job.job_id).at(-1)!.evidence).toMatchObject({
        status: "passed",
        commit: checkpoint,
      });
    } finally {
      fs.writeFileSync(release, "continue");
      await state.orchestrator.shutdown();
      state.store.close();
    }
  });

  it("preserves parseable task evidence and terminal reports when escaped output exceeds the artifact limit", async () => {
    const state = fixture({
      worker: (request) => {
        fs.writeFileSync(path.join(request.cwd!, "a.txt"), "verified\n");
        return jsonResponse(doneResult());
      },
      reviewer: approve,
    });
    addCheck(state, "verify.mjs", "console.log(String.fromCharCode(34).repeat(5000));");
    try {
      const job = await state.orchestrator.startJob({
        task: "Retain structured verification evidence",
        repoPath: state.repo,
        plan: planValue([{ id: "a" }]),
      });
      await state.orchestrator.waitFor(job.job_id);
      expect(state.store.mustJob(job.job_id).status).toBe("completed");
      const evidence = taskChecks(state, job.job_id);
      expect(evidence).toHaveLength(1);
      expect(evidence[0]!.summary.length).toBeLessThanOrEqual(8000);
      expect(evidence[0]!.evidence).toMatchObject({
        status: "passed",
        checkIndices: [0],
        commit: state.store.listRuns(job.job_id)[0]!.headCommit,
      });
      const report = JSON.parse(state.store.mustJob(job.job_id).finalReport!) as {
        taskChecks: TaskCheckEvidence[];
      };
      expect(report.taskChecks[0]!.commit).toBe(evidence[0]!.evidence.commit);
    } finally {
      await state.orchestrator.shutdown();
      state.store.close();
    }
  });

  it("refuses approval if the integration changes while the reviewer is assessing it", async () => {
    let reviews = 0;
    const state = fixture({
      worker: (request) => {
        fs.writeFileSync(path.join(request.cwd!, "a.txt"), "verified\n");
        return jsonResponse(doneResult());
      },
      reviewer: (request) => {
        reviews++;
        fs.writeFileSync(path.join(request.cwd!, "a.txt"), "changed after checks\n");
        return approve();
      },
    });
    addCheck(state, "verify.mjs", 'assert.equal(fs.readFileSync("a.txt", "utf8"), "verified\\n");');
    try {
      const job = await state.orchestrator.startJob({
        task: "Accept only the verified integration snapshot",
        repoPath: state.repo,
        plan: planValue([{ id: "a" }]),
      });
      await state.orchestrator.waitFor(job.job_id);
      expect(reviews).toBe(1);
      expect(state.store.mustJob(job.job_id).status).toBe("failed");
      expect(state.store.mustJob(job.job_id).error).toMatch(
        /verification|repository files|changed/i,
      );
      expect(
        state.store.listReviews(job.job_id).some((review) => review.status === "approved"),
      ).toBe(false);
    } finally {
      await state.orchestrator.shutdown();
      state.store.close();
    }
  });

  it("protects trusted verifier files from native write tools even inside an owned directory", async () => {
    const state = fixture({
      worker: async (request) => {
        const write = request.tools!.find((tool) => tool.name === "write_file")!;
        await expect(
          write.execute({ path: "src/verify.mjs", content: "process.exit(0);\n" }),
        ).rejects.toThrow(/protect|verif|forbidden/i);
        await write.execute({ path: "src/output.txt", content: "verified\n" });
        return jsonResponse(doneResult());
      },
      reviewer: approve,
    });
    const original = addCheck(
      state,
      "src/verify.mjs",
      'assert.equal(fs.readFileSync("src/output.txt", "utf8"), "verified\\n");',
    );
    const plan = planValue([{ id: "a" }]);
    plan.tasks[0]!.fileAreas = ["src"];
    try {
      const job = await state.orchestrator.startJob({
        task: "Implement output",
        repoPath: state.repo,
        plan,
      });
      await state.orchestrator.waitFor(job.job_id);
      expect(state.store.mustJob(job.job_id).status).toBe("completed");
      expect(
        fs.readFileSync(
          path.join(state.repo, "workspaces", job.job_id, "integration/src/verify.mjs"),
          "utf8",
        ),
      ).toBe(original);
    } finally {
      await state.orchestrator.shutdown();
      state.store.close();
    }
  });

  it("rejects direct verifier edits before a forged passing check can release a dependent", async () => {
    const launched: string[] = [];
    const state = fixture({
      worker: (request) => {
        const id = taskIdFromPrompt(request.prompt);
        launched.push(id);
        fs.writeFileSync(path.join(request.cwd!, "src/output.txt"), "incorrect\n");
        fs.writeFileSync(path.join(request.cwd!, "src/verify.mjs"), "process.exit(0);\n");
        return jsonResponse(doneResult());
      },
      reviewer: approve,
    });
    const original = addCheck(
      state,
      "src/verify.mjs",
      'assert.equal(fs.readFileSync("src/output.txt", "utf8"), "correct\\n");',
    );
    const plan = planValue([{ id: "a" }, { id: "b", dependencies: ["a"] }]);
    plan.tasks[0]!.fileAreas = ["src"];
    try {
      const job = await state.orchestrator.startJob({
        task: "Implement verified output",
        repoPath: state.repo,
        plan,
      });
      await state.orchestrator.waitFor(job.job_id);
      expect(state.store.mustJob(job.job_id).status).toBe("failed");
      expect(launched).toEqual(["a"]);
      expect(state.store.listRuns(job.job_id)[0]!.status).toBe("failed");
      expect(state.store.listRuns(job.job_id)[0]!.error).toMatch(/protect|verif|forbidden/i);
      expect(taskChecks(state, job.job_id).some((item) => item.evidence.status === "passed")).toBe(
        false,
      );
      expect(fs.readFileSync(path.join(state.repo, "src/verify.mjs"), "utf8")).toBe(original);
    } finally {
      await state.orchestrator.shutdown();
      state.store.close();
    }
  });

  it.each([
    { mutation: "tracked file", body: 'fs.writeFileSync("a.txt", "after-check\\n");' },
    { mutation: "untracked file", body: 'fs.writeFileSync("unchecked.txt", "unverified\\n");' },
    {
      mutation: "HEAD commit",
      body: `fs.writeFileSync("a.txt", "after-check\\n");
assert.equal(spawnSync("git", ["add", "a.txt"], { cwd, windowsHide: true }).status, 0);
assert.equal(spawnSync("git", ["-c", "user.name=Checker", "-c", "user.email=checker@localhost", "-c", "commit.gpgsign=false", "commit", "-m", "checker changes HEAD"], { cwd, windowsHide: true }).status, 0);`,
    },
  ])("refuses a passing checker that changes a $mutation", async ({ body }) => {
    const state = fixture({
      worker: (request) => {
        fs.writeFileSync(path.join(request.cwd!, "a.txt"), "before-check\n");
        return jsonResponse(doneResult());
      },
      reviewer: approve,
    });
    addCheck(state, "verify-mutates.mjs", body);
    try {
      const job = await state.orchestrator.startJob({
        task: "Implement output with a stable verifier",
        repoPath: state.repo,
        plan: planValue([{ id: "a" }]),
      });
      await state.orchestrator.waitFor(job.job_id);
      expect(state.store.mustJob(job.job_id).status).toBe("failed");
      const evidence = taskChecks(state, job.job_id);
      expect(evidence).toHaveLength(1);
      expect(evidence[0]!.evidence.status).toBe("failed");
      expect(evidence[0]!.evidence.summary).toMatch(/chang|dirty|mutat/i);
      expect(state.store.listReviews(job.job_id)).toHaveLength(0);
      expect(state.store.listRuns(job.job_id)[0]!.status).toBe("failed");
    } finally {
      await state.orchestrator.shutdown();
      state.store.close();
    }
  });

  it.each([true, false])(
    "records missing task checks explicitly (required: %s)",
    async (required) => {
      const launched: string[] = [];
      const state = fixture(
        {
          worker: (request) => {
            const id = taskIdFromPrompt(request.prompt);
            launched.push(id);
            fs.writeFileSync(path.join(request.cwd!, `${id}.txt`), "experimental\n");
            return jsonResponse(doneResult());
          },
          reviewer: approve,
        },
        { requireChecks: required },
      );
      try {
        const job = await state.orchestrator.startJob({
          task: "Create outputs",
          repoPath: state.repo,
          plan: planValue([{ id: "a" }, { id: "b", dependencies: ["a"] }]),
        });
        await state.orchestrator.waitFor(job.job_id);
        expect(state.store.mustJob(job.job_id).status).toBe(required ? "failed" : "completed");
        expect(launched).toEqual(required ? ["a"] : ["a", "b"]);
        const evidence = taskChecks(state, job.job_id);
        expect(evidence).toHaveLength(required ? 1 : 2);
        evidence.forEach((item) => {
          expect(item.evidence.status).toBe("not_run");
          expect(item.evidence.checkIndices).toEqual([]);
          expect(item.evidence.summary).toMatch(/not run|no checks/i);
        });
        if (required) expect(state.store.listReviews(job.job_id)).toHaveLength(0);
      } finally {
        await state.orchestrator.shutdown();
        state.store.close();
      }
    },
  );

  it.each([[], [0, 0], [-1], [0.5], ["0"], "0"].map((selection) => ({ selection })))(
    "rejects malformed or empty task verification selections: $selection",
    ({ selection: verificationChecks }) => {
      const plan = planValue([{ id: "a" }]);
      const invalid = { ...plan, tasks: [{ ...plan.tasks[0]!, verificationChecks }] };
      expect(validatePlan(invalid).ok).toBe(false);
    },
  );

  it("rejects an out-of-range check index before launching any worker", async () => {
    let workers = 0;
    const state = fixture({
      worker: () => {
        workers++;
        return jsonResponse(doneResult());
      },
      reviewer: approve,
    });
    addCheck(state, "verify.mjs", "assert.ok(true);");
    const plan = planValue([{ id: "a" }]);
    try {
      await expect(
        state.orchestrator.startJob({
          task: "Invalid verifier selection",
          repoPath: state.repo,
          plan: { ...plan, tasks: [{ ...plan.tasks[0]!, verificationChecks: [1] }] },
        }),
      ).rejects.toThrow(/check|index|verif/i);
      expect(workers).toBe(0);
    } finally {
      await state.orchestrator.shutdown();
      state.store.close();
    }
  });
});
