import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  coerceReviewResult,
  coerceWorkerResult,
  ReviewResultSchema,
  validatePlan,
  widenSingleTaskFiles,
  WorkerResultSchema,
} from "../src/orchestration/planner.js";
import { jsonResponse, memoryHarness, planValue, removeTemp, tempDir } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) removeTemp(dir);
  }
});

const validTask = {
  id: "alpha",
  title: "Alpha",
  instructions: "Write the file",
  acceptanceCriteria: ["file exists"],
  dependencies: [],
  fileAreas: ["src/alpha.ts"],
};

describe("validatePlan", () => {
  it("accepts a plan with unique ids and an acyclic graph", () => {
    const result = validatePlan({
      goal: "Add a command",
      completionCriteria: ["tests pass"],
      tasks: [
        validTask,
        {
          ...validTask,
          id: "beta",
          title: "Beta",
          dependencies: ["alpha"],
          fileAreas: ["src/beta.ts"],
        },
      ],
      risks: [],
      assumptions: [],
      questions: [],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects duplicate ids, missing dependencies, self-dependencies, and cycles", () => {
    expect(
      validatePlan({
        goal: "g",
        completionCriteria: ["c"],
        tasks: [validTask, { ...validTask, title: "Again" }],
      }).ok,
    ).toBe(false);
    const missing = validatePlan({
      goal: "g",
      completionCriteria: ["c"],
      tasks: [{ ...validTask, dependencies: ["missing"] }],
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors.join(" ")).toContain("missing");
    const self = validatePlan({
      goal: "g",
      completionCriteria: ["c"],
      tasks: [{ ...validTask, dependencies: ["alpha"] }],
    });
    expect(self.ok).toBe(false);
    const cycle = validatePlan({
      goal: "g",
      completionCriteria: ["c"],
      tasks: [
        { ...validTask, id: "a", dependencies: ["b"] },
        { ...validTask, id: "b", title: "B", dependencies: ["a"] },
      ],
    });
    expect(cycle.ok).toBe(false);
    if (!cycle.ok) expect(cycle.errors.join(" ")).toContain("cycle");
  });

  it("rejects a plan that is not an object", () => {
    const result = validatePlan("ship it");
    expect(result.ok).toBe(false);
  });

  it("wraps a single string criterion into a one-item list", () => {
    const result = validatePlan({
      goal: "Add hello.txt",
      completionCriteria: "hello.txt contains hello-from-swarm",
      tasks: [
        {
          ...validTask,
          acceptanceCriteria: "hello.txt contains hello-from-swarm",
          dependencies: "",
          fileAreas: "hello.txt",
        },
      ],
      risks: "",
      assumptions: "",
      questions: "",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.completionCriteria).toEqual(["hello.txt contains hello-from-swarm"]);
    expect(result.plan.tasks[0]?.acceptanceCriteria).toEqual([
      "hello.txt contains hello-from-swarm",
    ]);
    expect(result.plan.tasks[0]?.dependencies).toEqual([]);
    expect(result.plan.tasks[0]?.fileAreas).toEqual(["hello.txt"]);
  });

  it("rejects two tasks that list the same file", () => {
    const result = validatePlan({
      goal: "Build the site",
      completionCriteria: ["the site greets a visitor"],
      tasks: [
        validTask,
        { ...validTask, id: "beta", title: "Beta", fileAreas: ["src/alpha.ts"] },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toContain("both list");
  });

  it("rejects multiple tasks that list no files and splits a comma-separated file list", () => {
    const missing = validatePlan({
      goal: "Build the site",
      completionCriteria: ["the site greets a visitor"],
      tasks: [
        { ...validTask, fileAreas: [] },
        { ...validTask, id: "beta", title: "Beta", fileAreas: [] },
      ],
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors.join(" ")).toContain("lists no files");
    const split = validatePlan({
      goal: "Build the site",
      completionCriteria: ["files exist"],
      tasks: [{ ...validTask, fileAreas: "index.html, site.css, site.js" }],
    });
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(split.plan.tasks[0]?.fileAreas).toEqual(["index.html", "site.css", "site.js"]);
  });

  it("adds every file named by a one-task request except files the request says not to change", () => {
    const accepted = validatePlan({
      goal: "Build the site",
      completionCriteria: ["the site greets a visitor"],
      tasks: [{ ...validTask, fileAreas: ["index.html"] }],
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    const widened = widenSingleTaskFiles(
      "Create index.html, site.css, and site.js. Do not change README.md.",
      accepted.plan,
    );
    expect(widened.tasks[0]?.fileAreas).toEqual(["index.html", "site.css", "site.js"]);
    expect(widened.tasks[0]?.instructions).toContain("site.css, site.js");
  });
});

describe("coerceWorkerResult", () => {
  it("accepts status synonyms, a missing summary, and file contents", () => {
    const parsed = WorkerResultSchema.safeParse(
      coerceWorkerResult({
        status: "completed",
        files: [{ path: "hello.txt", content: "hello-from-swarm\n" }],
        messages: "not-an-array",
      }),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.status).toBe("done");
    expect(parsed.data.summary.length).toBeGreaterThan(0);
    expect(parsed.data.patch).toContain("diff --git a/hello.txt b/hello.txt");
    expect(parsed.data.patch).toContain("+hello-from-swarm");
  });

  it("accepts a yes approval and a rejection that forgot its findings", () => {
    const approved = ReviewResultSchema.safeParse(
      coerceReviewResult({ approved: "yes", summary: "looks good" }),
    );
    expect(approved.success).toBe(true);
    if (approved.success) expect(approved.data.approved).toBe(true);
    const rejected = ReviewResultSchema.safeParse(
      coerceReviewResult({ approved: "no", summary: "greeting is wrong" }),
    );
    expect(rejected.success).toBe(true);
    if (!rejected.success) return;
    expect(rejected.data.approved).toBe(false);
    expect(rejected.data.findings[0]?.instruction).toContain("greeting is wrong");
  });
});

describe("planner repair", () => {
  it("stores the plan after one rejected attempt", async () => {
    const dir = tempDir("swarm-plan-repair-");
    dirs.push(dir);
    let attempt = 0;
    const { store, orchestrator, repo } = memoryHarness(dir, {
      planner: () => {
        attempt += 1;
        if (attempt === 1) {
          return jsonResponse(
            planValue([
              { id: "a", dependencies: ["b"] },
              { id: "b", dependencies: ["a"] },
            ]),
          );
        }
        return jsonResponse(planValue([{ id: "a" }], ["Which file should change?"]));
      },
    });
    const started = await orchestrator.startJob({
      task: "plan this",
      repoPath: repo,
      dryRun: true,
    });
    await orchestrator.waitFor(started.job_id);
    const job = store.mustJob(started.job_id);
    expect(attempt).toBe(2);
    expect(job.status).toBe("completed");
    expect(job.reviewState).toBe("skipped_dry_run");
    expect(store.listTasks(job.id).map((task) => task.stableId)).toEqual(["a"]);
    expect(store.listDecisions(job.id)).toHaveLength(1);
    expect(store.listDecisions(job.id)[0]?.status).toBe("open");
    const result = orchestrator.result(job.id);
    expect(result.ready).toBe(true);
    expect(result.status).toBe("completed");
    expect(JSON.stringify(result.report)).toContain("Dry run stored the plan");
    store.close();
  });

  it("fails the job when both planner attempts are invalid", async () => {
    const dir = tempDir("swarm-plan-fail-");
    dirs.push(dir);
    const { store, orchestrator, repo } = memoryHarness(dir, {
      planner: () => jsonResponse({ goal: "nope" }),
    });
    const started = await orchestrator.startJob({
      task: "bad plan",
      repoPath: repo,
      dryRun: true,
    });
    await orchestrator.waitFor(started.job_id);
    const job = store.mustJob(started.job_id);
    expect(job.status).toBe("failed");
    expect(job.reviewState).toBe("planning_failed");
    expect(job.error ?? "").toContain("Planning failed");
    expect(store.listTasks(job.id)).toHaveLength(0);
    store.close();
  });

  it("uses the repair prompt after malformed JSON", async () => {
    const dir = tempDir("swarm-plan-json-");
    dirs.push(dir);
    const prompts: string[] = [];
    const { store, orchestrator, repo } = memoryHarness(dir, {
      planner: (request) => {
        prompts.push(request.prompt);
        if (prompts.length === 1) return { text: "not json", provider: "fake" };
        return jsonResponse(planValue([{ id: "a" }]));
      },
    });
    const started = await orchestrator.startJob({
      task: "repair json",
      repoPath: repo,
      dryRun: true,
    });
    await orchestrator.waitFor(started.job_id);
    expect(store.mustJob(started.job_id).status).toBe("completed");
    expect(prompts[1]).toContain("previous plan was rejected");
    expect(path.basename(repo)).not.toBe("");
    store.close();
  });
});
