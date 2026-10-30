import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitWorkspace } from "../src/git/workspace.js";
import { Orchestrator } from "../src/orchestration/service.js";
import type { SwarmConfig } from "../src/config/schema.js";
import { createChecksRunner } from "../src/orchestration/checks.js";
import { validatePlan } from "../src/orchestration/planner.js";
import { SwarmError } from "../src/errors.js";
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
  type RoleHandlers,
} from "./helpers.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(removeTemp));
function fixture(handlers: RoleHandlers, patch: Partial<SwarmConfig> = {}) {
  const root = tempDir("swarm-integration-");
  dirs.push(root);
  const repo = path.join(root, "repo");
  initRepo(repo);
  const config = testConfig(path.join(root, "data"), {
    providerTimeoutMs: 20000,
    jobTimeoutMs: 60000,
    ...patch,
  });
  const store = openStore(root).store;
  const workspace = new GitWorkspace({
    authorName: config.gitAuthorName,
    authorEmail: config.gitAuthorEmail,
    timeoutMs: 20000,
    policy: config.git,
    maxContextChars: 20000,
  });
  const orchestrator = new Orchestrator(store, config, workspace, scriptedResolver(handlers), {
    recoverOnStart: false,
  });
  return { root, repo, config, store, workspace, orchestrator };
}
const approve = () => jsonResponse({ approved: true, summary: "verified fixture", findings: [] });

describe("nested agent integration", () => {
  it("applies a read-only CLI worker's patch without requiring direct filesystem edits", async () => {
    const { repo, store, orchestrator } = fixture(
      {
        planner: (request) => {
          expect(request.tools).toEqual([]);
          return jsonResponse(planValue([{ id: "a" }]));
        },
        worker: (request) => {
          expect(request.system).toContain("You have no shell and no editor");
          expect(request.prompt).toContain("patch field as a unified diff");
          expect(fs.existsSync(path.join(request.cwd!, "a.txt"))).toBe(false);
          return jsonResponse({
            ...doneResult(),
            patch:
              "diff --git a/a.txt b/a.txt\nnew file mode 100644\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1 @@\n+checked patch\n",
          });
        },
        reviewer: approve,
      },
      {
        providers: {
          ollama: {
            type: "cli",
            command: process.execPath,
            args: [],
            fileEditing: false,
            promptTransport: "stdin",
            outputParser: "fenced-json",
            timeoutMs: 5000,
            capabilities: {
              structuredOutput: true,
              toolCalling: false,
              streaming: false,
              nonInteractive: true,
            },
            envPass: [],
            maxStdoutBytes: 100000,
            documentedStatus: "help-checked",
            notes: "Read-only fixture",
          },
        },
      },
    );
    try {
      const job = await orchestrator.startJob({ task: "Create a", repoPath: repo });
      await orchestrator.waitFor(job.job_id);
      expect(store.mustJob(job.job_id).status).toBe("completed");
      expect(
        fs.readFileSync(path.join(repo, "workspaces", job.job_id, "integration/a.txt"), "utf8"),
      ).toBe("checked patch\n");
    } finally {
      await orchestrator.shutdown();
      store.close();
    }
  });
  it.each([false, true])(
    "retries from a scoped checkpoint without approving the failed attempt (already finished: %s)",
    async (alreadyFinished) => {
      let attempts = 0;
      const { repo, store, orchestrator } = fixture({
        planner: () => jsonResponse(planValue([{ id: "a" }])),
        worker: (request) => {
          const file = path.join(request.cwd!, "a.txt");
          if (++attempts === 1) {
            fs.writeFileSync(file, "first\n");
            throw new SwarmError("request timeout", "timeout", true);
          }
          expect(fs.readFileSync(file, "utf8")).toBe("first\n");
          if (!alreadyFinished) fs.appendFileSync(file, "second\n");
          return jsonResponse(doneResult());
        },
        reviewer: approve,
      });
      try {
        const job = await orchestrator.startJob({ task: "checkpoint progress", repoPath: repo });
        await orchestrator.waitFor(job.job_id);
        expect(store.mustJob(job.job_id).status).toBe("completed");
        const runs = store.listRuns(job.job_id);
        expect(runs[0]!.status).toBe("timed_out");
        expect(runs[1]!.baseCommit).toBe(runs[0]!.headCommit);
        expect(
          fs.readFileSync(path.join(repo, "workspaces", job.job_id, "integration/a.txt"), "utf8"),
        ).toBe(alreadyFinished ? "first\n" : "first\nsecond\n");
        expect(
          store.listArtifacts(job.job_id).some((artifact) => artifact.kind === "checkpoint"),
        ).toBe(true);
      } finally {
        await orchestrator.shutdown();
        store.close();
      }
    },
  );
  it("cleans successful agent worktrees when requested and reports their final state", async () => {
    const { repo, store, orchestrator } = fixture(
      {
        planner: () => jsonResponse(planValue([{ id: "a" }])),
        worker: (request) => {
          fs.writeFileSync(path.join(request.cwd!, "a.txt"), "done\n");
          return jsonResponse(doneResult());
        },
        reviewer: approve,
      },
      { git: { ...testConfig("unused").git, cleanupWorktrees: true } },
    );
    const job = await orchestrator.startJob({ task: "clean on success", repoPath: repo });
    await orchestrator.waitFor(job.job_id);
    expect(store.mustJob(job.job_id).status).toBe("completed");
    const worktrees = store.listWorktrees(job.job_id);
    expect(
      worktrees.every((item) => item.cleanupState === "removed" && !fs.existsSync(item.path)),
    ).toBe(true);
    const report = JSON.parse(store.mustJob(job.job_id).finalReport!) as {
      workspaces: Array<{ state: string }>;
    };
    expect(report.workspaces.every((item) => item.state === "removed")).toBe(true);
    expect(fs.existsSync(path.join(repo, "workspaces", job.job_id, "integration/a.txt"))).toBe(
      true,
    );
    store.close();
  });

  it("refuses a linked workspace root and never cleans an unrelated directory", async () => {
    const { root, repo, store, workspace } = fixture({});
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "keep.txt"), "keep");
    const linked = path.join(repo, "workspaces");
    fs.symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir");
    const baseCommit = git(repo, ["rev-parse", "HEAD"]).trim();
    await expect(
      workspace.createRunWorkspace({
        repoRoot: repo,
        dataDir: root,
        jobId: "job-linked",
        stableId: "a",
        attempt: 1,
        baseCommit,
      }),
    ).rejects.toThrow(/symbolic link|junction/);
    await expect(
      workspace.cleanup({
        repoRoot: repo,
        worktrees: [{ path: outside, branch: "main", preserve: false }],
      }),
    ).rejects.toThrow(/Workspace must/);
    expect(fs.readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
    store.close();
  });

  it("lets dependent agents edit the same file and preserves their own commits", async () => {
    const plan = planValue([{ id: "first" }, { id: "second", dependencies: ["first"] }]);
    plan.tasks.forEach((task) => {
      task.fileAreas = ["src/shared.txt"];
    });
    expect(validatePlan(plan).ok).toBe(true);
    const fixtureState = fixture({
      planner: () => jsonResponse(plan),
      worker: (request) => {
        const id = taskIdFromPrompt(request.prompt);
        const file = path.join(request.cwd!, "src", "shared.txt");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (id === "second") {
          expect(fs.readFileSync(file, "utf8")).toBe("first\n");
          expect(request.prompt).toContain("first\n");
          fs.appendFileSync(file, "second\n");
        } else fs.writeFileSync(file, "first\n");
        git(request.cwd!, ["add", "src/shared.txt"]);
        git(request.cwd!, ["commit", "-m", `agent ${id} owns this commit`]);
        return jsonResponse(doneResult(id));
      },
      reviewer: approve,
    });
    const { repo, store, orchestrator } = fixtureState;
    const started = await orchestrator.startJob({
      task: "Two sequential edits",
      repoPath: repo,
      workerCount: 2,
    });
    await orchestrator.waitFor(started.job_id);
    expect(store.mustJob(started.job_id).status).toBe("completed");
    const integration = path.join(repo, "workspaces", started.job_id, "integration");
    expect(fs.readFileSync(path.join(integration, "src/shared.txt"), "utf8")).toBe(
      "first\nsecond\n",
    );
    expect(store.listWorktrees(started.job_id).map((w) => path.basename(w.path))).toEqual([
      "agent-first-1",
      "agent-second-1",
    ]);
    expect(store.listWorktrees(started.job_id).every((w) => fs.existsSync(w.path))).toBe(true);
    const report = JSON.parse(store.mustJob(started.job_id).finalReport!) as {
      workspaces: Array<{ state: string }>;
    };
    expect(report.workspaces.every((item) => item.state === "preserved")).toBe(true);
    expect(git(repo, ["status", "--porcelain"])).toBe("");
    expect(git(integration, ["log", "--format=%s"])).toContain("agent second owns this commit");
    store.close();
  });

  it("pins the starting commit even when main advances during planning", async () => {
    let repoPath = "";
    let original = "";
    const { repo, store, orchestrator } = fixture({
      planner: () => {
        fs.writeFileSync(path.join(repoPath, "README.md"), "later-main\n");
        git(repoPath, ["add", "README.md"]);
        git(repoPath, ["commit", "-m", "main advances"]);
        return jsonResponse(planValue([{ id: "a" }]));
      },
      worker: (request) => {
        expect(fs.readFileSync(path.join(request.cwd!, "README.md"), "utf8")).toBe("base\n");
        expect(request.prompt).not.toContain("later-main");
        fs.writeFileSync(path.join(request.cwd!, "a.txt"), "done\n");
        return jsonResponse(doneResult());
      },
      reviewer: approve,
    });
    repoPath = repo;
    original = git(repo, ["rev-parse", "main"]).trim();
    const started = await orchestrator.startJob({ task: "Pinned snapshot", repoPath: repo });
    await orchestrator.waitFor(started.job_id);
    expect(store.mustJob(started.job_id).status).toBe("completed");
    expect(store.mustJob(started.job_id).baseCommit).toBe(original);
    expect(fs.readFileSync(path.join(repo, "README.md"), "utf8")).toBe("later-main\n");
    store.close();
  });

  it("keeps simultaneous jobs in separate directories and leaves a dry run unchanged", async () => {
    const { repo, store, orchestrator } = fixture({
      planner: () => jsonResponse(planValue([{ id: "a" }])),
      worker: (request) => {
        fs.writeFileSync(path.join(request.cwd!, "a.txt"), request.metadata!.jobId!);
        return jsonResponse(doneResult());
      },
      reviewer: approve,
    });
    const exclude = path.join(repo, ".git/info/exclude");
    const before = fs.readFileSync(exclude, "utf8");
    const dry = await orchestrator.startJob({ task: "plan only", repoPath: repo, dryRun: true });
    await orchestrator.waitFor(dry.job_id);
    expect(fs.existsSync(path.join(repo, "workspaces"))).toBe(false);
    expect(fs.readFileSync(exclude, "utf8")).toBe(before);
    const jobs = await Promise.all([
      orchestrator.startJob({ task: "one", repoPath: repo }),
      orchestrator.startJob({ task: "two", repoPath: repo }),
    ]);
    await Promise.all(jobs.map((job) => orchestrator.waitFor(job.job_id)));
    for (const job of jobs) {
      expect(store.mustJob(job.job_id).status).toBe("completed");
      expect(
        fs.readFileSync(path.join(repo, "workspaces", job.job_id, "integration/a.txt"), "utf8"),
      ).toBe(job.job_id);
    }
    expect(git(repo, ["status", "--porcelain"])).toBe("");
    store.close();
  });

  it.each(["missing checks", "truncated diff", "truncated prompt"])(
    "refuses approval with %s",
    async (scenario) => {
      let reviews = 0;
      const patch: Partial<SwarmConfig> =
        scenario === "missing checks"
          ? { requireChecks: true }
          : scenario === "truncated diff"
            ? { maxDiffChars: 20 }
            : { maxPromptChars: 1500 };
      const { repo, store, orchestrator } = fixture(
        {
          planner: () => jsonResponse(planValue([{ id: "a" }])),
          worker: (request) => {
            fs.writeFileSync(path.join(request.cwd!, "a.txt"), "meaningful line\n".repeat(200));
            return jsonResponse(doneResult());
          },
          reviewer: () => {
            reviews++;
            return approve();
          },
        },
        patch,
      );
      const started = await orchestrator.startJob({ task: "Review evidence", repoPath: repo });
      await orchestrator.waitFor(started.job_id);
      expect(store.mustJob(started.job_id).status).toBe("failed");
      expect(store.mustJob(started.job_id).error).toMatch(/No checks|truncated|missing evidence/);
      expect(reviews).toBe(0);
      store.close();
    },
  );

  it("reports missing, passing, failing and cancelled checks distinctly", async () => {
    const root = tempDir("swarm-check-evidence-");
    dirs.push(root);
    const config = testConfig(root);
    expect((await createChecksRunner(config)(root)).status).toBe("not_run");
    for (const code of [0, 1]) {
      const checks = createChecksRunner({
        ...config,
        checks: [{ command: process.execPath, args: ["-e", `process.exit(${code})`] }],
      });
      expect((await checks(root)).status).toBe(code === 0 ? "passed" : "failed");
    }
    const controller = new AbortController();
    const long = createChecksRunner({
      ...config,
      checks: [{ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] }],
    });
    const pending = long(root, controller.signal);
    setTimeout(() => controller.abort(), 100);
    expect((await pending).ok).toBe(false);
  });

  it("reads committed source while excluding credentials and unrelated workspaces", async () => {
    const { repo, store, workspace } = fixture({});
    fs.mkdirSync(path.join(repo, "src"));
    fs.writeFileSync(path.join(repo, "src/feature.ts"), "export const answer = 42;\n");
    fs.writeFileSync(path.join(repo, ".env.secret"), "fixture-secret-marker\n");
    git(repo, ["add", "src/feature.ts", ".env.secret"]);
    git(repo, ["commit", "-m", "context fixtures"]);
    const ref = git(repo, ["rev-parse", "HEAD"]).trim();
    fs.writeFileSync(path.join(repo, "src/feature.ts"), "uncommitted-other-work\n");
    fs.mkdirSync(path.join(repo, "workspaces/other"), { recursive: true });
    fs.writeFileSync(path.join(repo, "workspaces/other/example.ts"), "sibling-workspace-marker\n");
    const context = await workspace.readContext(repo, ref, ["src/feature.ts"], 8000);
    expect(context).toContain("export const answer = 42");
    expect(context).not.toMatch(
      /fixture-secret-marker|uncommitted-other-work|sibling-workspace-marker/,
    );
    store.close();
  });
});
