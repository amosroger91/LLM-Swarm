import { afterEach, describe, expect, it } from "vitest";
import { SwarmConfigSchema } from "../src/config/schema.js";
import { openDatabase } from "../src/db/connection.js";
import { Store } from "../src/db/store.js";
import { validatePlan } from "../src/orchestration/planner.js";
import { plannerSystem, plannerUserPrompt } from "../src/orchestration/prompts.js";
import { openStore, plannedTasks, planValue, removeTemp, tempDir } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) removeTemp(dirs.pop()!);
});

describe("task verification contracts", () => {
  it.each(["checks", "task-checks", "dependency-checks"])(
    "bounds %s diagnostic JSON without losing verification metadata",
    (kind) => {
      const root = tempDir("swarm-check-evidence-");
      dirs.push(root);
      const { store } = openStore(root);
      try {
        const job = store.createJob({
          task: "Verify",
          repoPath: root,
          baseBranch: "main",
          workerCount: 1,
          configProfile: null,
          dryRun: false,
          maxAttempts: 2,
          maxReviewRounds: 3,
        });
        const evidence = {
          status: "failed",
          commit: "a".repeat(40),
          checkIndices: [0, 2],
          taskId: "ancestor-task",
          runId: "failed-attempt",
          summary: '"quoted"\n\\path\t'.repeat(1200),
        };
        const artifact = store.insertArtifact({
          jobId: job.id,
          kind,
          summary: JSON.stringify(evidence),
        });
        const stored = store.listArtifacts(job.id).find((item) => item.id === artifact.id)!;
        expect(stored.summary.length).toBeLessThanOrEqual(8000);
        const parsed = JSON.parse(stored.summary) as typeof evidence & { truncated: boolean };
        expect(parsed).toEqual({ ...evidence, summary: expect.any(String), truncated: true });
        expect(parsed.summary.length).toBeGreaterThan(0);
        expect(parsed.summary.length).toBeLessThan(evidence.summary.length);
        expect(evidence.summary.startsWith(parsed.summary)).toBe(true);
      } finally {
        store.close();
      }
    },
  );

  it("accepts only a nonempty unique selection of configured check indices", () => {
    const plan = planValue([{ id: "a" }]);
    const withSelection = (verificationChecks: unknown) => ({
      ...plan,
      tasks: [{ ...plan.tasks[0], verificationChecks }],
    });
    expect(validatePlan(plan, 2).ok).toBe(true);
    expect(validatePlan(withSelection([1, 0]), 2).ok).toBe(true);
    for (const selection of [[], [0, 0], [-1], [0.5], [2], ["0"]]) {
      expect(validatePlan(withSelection(selection), 2).ok).toBe(false);
    }
    expect(validatePlan(withSelection([0]), 0).ok).toBe(false);
  });

  it("accepts named protected checks and rejects unsafe protected paths", () => {
    expect(
      SwarmConfigSchema.parse({
        checks: [
          {
            name: "API contract",
            command: "node",
            args: ["verify.mjs"],
            protectedPaths: ["verify.mjs", "test/acceptance"],
          },
        ],
      }).checks[0],
    ).toMatchObject({ name: "API contract", protectedPaths: ["verify.mjs", "test/acceptance"] });
    expect(
      SwarmConfigSchema.parse({ checks: [{ command: "node" }] }).checks[0]?.protectedPaths,
    ).toBeUndefined();
    for (const file of ["../verify.mjs", "/verify.mjs", "C:/verify.mjs", "test/*", ".git/config"]) {
      expect(
        SwarmConfigSchema.safeParse({ checks: [{ command: "node", protectedPaths: [file] }] })
          .success,
      ).toBe(false);
    }
  });

  it("persists task selections and pins independent verification across restart", () => {
    const root = tempDir("swarm-verification-contract-");
    dirs.push(root);
    const { store, dbPath } = openStore(root);
    const job = store.createJob({
      task: "Build the change",
      repoPath: root,
      baseBranch: "main",
      workerCount: 1,
      configProfile: null,
      dryRun: false,
      maxAttempts: 2,
      maxReviewRounds: 3,
    });
    expect(job.verification).toBeUndefined();
    const definitions = {
      checks: [
        {
          name: "contract",
          command: "node",
          args: ["acceptance.mjs"],
          protectedPaths: ["acceptance.mjs"],
        },
      ],
      requireChecks: true,
    };
    const pinned = store.pinVerification(job.id, definitions);
    definitions.checks[0]!.args[0] = "weakened.mjs";
    pinned.checks[0]!.args[0] = "mutated-return.mjs";
    expect(store.pinVerification(job.id, { checks: [], requireChecks: false })).toEqual({
      checks: [
        {
          name: "contract",
          command: "node",
          args: ["acceptance.mjs"],
          protectedPaths: ["acceptance.mjs"],
        },
      ],
      requireChecks: true,
    });
    const tasks = plannedTasks([{ id: "a" }, { id: "b", dependencies: ["a"] }]);
    tasks[0]!.verificationChecks = [0];
    store.replacePlan(
      job.id,
      {
        goal: "Build",
        completionCriteria: ["passes"],
        assumptions: [],
        risks: [],
        questions: [],
        raw: "{}",
      },
      tasks,
      2,
    );
    store.transitionJob(job.id, "running");
    const added = [{ ...plannedTasks([{ id: "c" }])[0]!, verificationChecks: [0] }];
    const proposal = store.saveProposal(job.id, "Add c", "Add c", added, []);
    store.appendTasks(job.id, proposal, added, "{}", "Add c");
    expect(
      store.createRevisionTask({
        jobId: job.id,
        title: "Repair",
        instructions: "Repair",
        acceptanceCriteria: ["passes"],
        maxAttempts: 2,
      }).verificationChecks,
    ).toBeUndefined();
    store.close();
    const reopened = new Store(openDatabase(dbPath));
    try {
      expect(reopened.mustJob(job.id).verification?.checks[0]?.args).toEqual(["acceptance.mjs"]);
      expect(
        reopened.listTasks(job.id).find((task) => task.stableId === "a")?.verificationChecks,
      ).toEqual([0]);
      expect(
        reopened.listTasks(job.id).find((task) => task.stableId === "b")?.verificationChecks,
      ).toBeUndefined();
      expect(
        reopened.listTasks(job.id).find((task) => task.stableId === "c")?.verificationChecks,
      ).toEqual([0]);
    } finally {
      reopened.close();
    }
  });

  it("shows the trusted catalog and explains scoped handoff verification to the planner", () => {
    const prompt = plannerUserPrompt({
      task: "Build",
      repo: "repo",
      baseBranch: "main",
      context: "source",
      profiles: "worker",
      checks: [
        { name: "helpers", command: "node", args: ["verify.mjs"], protectedPaths: ["verify.mjs"] },
      ],
    });
    expect(prompt).toContain('"index":0');
    expect(prompt).toContain('"name":"helpers"');
    expect(prompt).toContain('"protectedPaths":["verify.mjs"]');
    expect(plannerSystem()).toContain("Never invent commands or check indices");
    expect(plannerSystem()).toContain("before releasing a task's commit to dependents");
  });
});
