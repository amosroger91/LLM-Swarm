import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  doneResult,
  jsonResponse,
  memoryHarness,
  planValue,
  tempDir,
  removeTemp,
  waitUntil,
  testConfig,
} from "./helpers.js";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(removeTemp));
const root = (): string => {
  const value = tempDir("swarm-supervision-");
  roots.push(value);
  return value;
};
const approve = () => jsonResponse({ approved: true, summary: "approved", findings: [] });
const maintenance = {
  ...testConfig("unused").maintenance,
  enabled: true,
  intervalMs: 60000,
  maxPlanningRounds: 0,
};

it("diagnoses exhausted retries once, uses a different strategy, and closes the blocker after success", async () => {
  let attempts = 0,
    assists = 0;
  const { orchestrator, store, repo } = memoryHarness(
    root(),
    {
      planner: (request) => {
        if (request.metadata?.role === "recovery") {
          expect(request.cwd).toBe(repo);
          assists++;
          return jsonResponse({
            action: "retry",
            instructions: "Use the source file API instead of another malformed diff",
          });
        }
        return jsonResponse(planValue([{ id: "a" }]));
      },
      worker: (request) => {
        if (++attempts === 1) return jsonResponse({ status: "failed", summary: "corrupt patch" });
        expect(request.prompt).toContain("Use the source file API");
        fs.writeFileSync(path.join(request.cwd!, "a.txt"), "fixed");
        return jsonResponse(doneResult());
      },
      reviewer: approve,
    },
    {
      defaultMaxAttempts: 1,
      recovery: { enabled: true, maxAssistsPerTask: 1, stallWarningMs: 60000 },
    },
  );
  try {
    const job = await orchestrator.startJob({ task: "implement", repoPath: repo });
    await orchestrator.waitFor(job.job_id);
    expect(store.mustJob(job.job_id).status).toBe("completed");
    expect(assists).toBe(1);
    expect(attempts).toBe(2);
    expect(store.listBlockers(job.job_id)).toMatchObject([
      { status: "resolved", assists: 1, occurrences: 1 },
    ]);
    expect(store.listTasks(job.job_id)[0]!.error).toBeNull();
    expect(
      store
        .listMessages(job.job_id, 100)
        .some((message) => message.content.startsWith("[RESOLVED]")),
    ).toBe(true);
  } finally {
    await orchestrator.shutdown();
    store.close();
  }
});

it("escalates a repeatedly failing worker and stops retrying until explicit guidance arrives", async () => {
  let attempts = 0;
  const { orchestrator, store, repo } = memoryHarness(
    root(),
    {
      planner: (request) =>
        request.metadata?.role === "recovery"
          ? jsonResponse({ action: "retry", instructions: "Try a different encoding" })
          : jsonResponse(planValue([{ id: "a" }])),
      worker: () => {
        attempts++;
        return jsonResponse({ status: "failed", summary: "dependency unavailable" });
      },
      reviewer: approve,
    },
    {
      defaultMaxAttempts: 1,
      recovery: { enabled: true, maxAssistsPerTask: 1, stallWarningMs: 60000 },
    },
  );
  try {
    const job = await orchestrator.startJob({ task: "implement", repoPath: repo });
    await waitUntil(
      () => store.mustJob(job.job_id).reviewState === "awaiting_decision",
      "escalation",
    );
    expect(attempts).toBe(2);
    const blocker = store.listBlockers(job.job_id)[0]!;
    expect(blocker.status).toBe("waiting");
    expect(blocker.occurrences).toBe(2);
    expect(blocker.attempts).toHaveLength(2);
    const decision = store.mustDecision(blocker.decisionId!);
    expect(decision.ownerRole).toBe("human");
    orchestrator.resolveDecision({
      jobId: job.job_id,
      decisionId: decision.id,
      option: "stop_job",
      rationale: "Investigate the missing dependency",
    });
    await orchestrator.waitFor(job.job_id);
    expect(store.mustJob(job.job_id).status).toBe("cancelled");
  } finally {
    await orchestrator.shutdown();
    store.close();
  }
});

it("lets the recurring supervisor answer evidence-backed worker questions without human intervention", async () => {
  let attempts = 0;
  let jobId = "";
  const { orchestrator, store, repo } = memoryHarness(
    root(),
    {
      planner: (request) =>
        request.metadata?.role === "planner-supervisor"
          ? jsonResponse({
              answers: [
                {
                  decisionId: store.listDecisions(jobId)[0]!.id,
                  option: "JSON",
                  rationale: "The original human goal explicitly requires JSON",
                  needsHuman: false,
                },
              ],
            })
          : jsonResponse(planValue([{ id: "a" }])),
      worker: (request) => {
        if (++attempts === 1)
          return jsonResponse({
            status: "blocked",
            summary: "Need a format",
            proposals: [{ question: "Which format?", options: ["JSON", "CSV"], blocking: true }],
          });
        expect(request.prompt).toContain("answer: JSON");
        expect(store.mustJob(jobId).reviewState).toBe("pending");
        fs.writeFileSync(path.join(request.cwd!, "a.txt"), "{}");
        return jsonResponse(doneResult());
      },
      reviewer: approve,
    },
    { maintenance },
  );
  try {
    const job = await orchestrator.startJob({ task: "Write JSON", repoPath: repo });
    jobId = job.job_id;
    await waitUntil(() => store.mustJob(jobId).reviewState === "awaiting_decision", "question");
    expect(await orchestrator.maintenanceTick()).toMatchObject({ answered: [jobId] });
    await orchestrator.waitFor(jobId);
    expect(store.mustJob(jobId).status).toBe("completed");
    expect(attempts).toBe(2);
  } finally {
    await orchestrator.shutdown();
    store.close();
  }
});

it.each(["interrupted", "deadline"])(
  "resumes %s work on a maintenance sweep and preserves the immutable human goal",
  async (mode) => {
    const { orchestrator, store, repo } = memoryHarness(
      root(),
      {
        worker: (request) => {
          fs.writeFileSync(path.join(request.cwd!, "a.txt"), "done");
          return jsonResponse(doneResult());
        },
        reviewer: approve,
      },
      { maintenance },
    );
    try {
      const job = await orchestrator.startJob({
        task: "The human's original goal",
        repoPath: repo,
        dryRun: true,
        plan: planValue([{ id: "a" }]),
      });
      await orchestrator.waitFor(job.job_id);
      // Model a stopped scheduler after a committed plan, without running a provider.
      store.transitionJob(job.job_id, "completed");
      const database = (await import("../src/db/connection.js")).openDatabase(
        path.join(roots.at(-1)!, "swarm.db"),
      );
      database
        .prepare("UPDATE jobs SET status=?, error=?, dry_run=0 WHERE id=?")
        .run(
          mode === "deadline" ? "failed" : "interrupted",
          mode === "deadline" ? "Job timed out after 1800000ms" : null,
          job.job_id,
        );
      database.close();
      const result = await orchestrator.maintenanceTick();
      expect(result.resumed).toEqual([job.job_id]);
      await orchestrator.waitFor(job.job_id);
      expect(store.mustJob(job.job_id).status).toBe("completed");
      expect(store.humanGoal(job.job_id)).toBe("The human's original goal");
      expect((await orchestrator.maintenanceTick()).resumed).toEqual([]);
      // A recurring deadline eventually becomes a visible blocker, not an endless loop.
      if (mode === "deadline") {
        const database = (await import("../src/db/connection.js")).openDatabase(
          path.join(roots.at(-1)!, "swarm.db"),
        );
        database
          .prepare(
            "UPDATE jobs SET status='failed', error='Job timed out after 1800000ms' WHERE id=?",
          )
          .run(job.job_id);
        database.close();
        for (let index = 1; index < maintenance.maxAutoResumes; index++)
          store.addEvent(job.job_id, "maintenance.auto_resumed", "job", job.job_id, {
            attempt: index + 1,
          });
        expect((await orchestrator.maintenanceTick()).resumed).toEqual([]);
        expect(store.listBlockers(job.job_id)).toMatchObject([
          { category: "maintenance_stopped", summary: "Automatic recovery budget exhausted" },
        ]);
      }
    } finally {
      await orchestrator.shutdown();
      store.close();
    }
  },
);

it("lets the goal supervisor add a missing prerequisite task while retaining final review", async () => {
  let audits = 0;
  const { orchestrator, store, repo } = memoryHarness(
    root(),
    {
      planner: (request) => {
        if (request.metadata?.role === "goal-supervisor") expect(request.cwd).toBe(repo);
        return request.metadata?.role === "goal-supervisor"
          ? jsonResponse(
              ++audits === 1
                ? {
                    reply: "The requested second output is missing",
                    action: "add_tasks",
                    contracts: [],
                    tasks: planValue([{ id: "b", dependencies: ["a"] }]).tasks,
                  }
                : {
                    reply: "Both requested outputs are present",
                    action: "review",
                    tasks: [],
                    contracts: [],
                  },
            )
          : jsonResponse(planValue([{ id: "a" }]));
      },
      worker: (request) => {
        fs.writeFileSync(path.join(request.cwd!, `${request.metadata!.taskId!}.txt`), "done");
        return jsonResponse(doneResult());
      },
      reviewer: approve,
    },
    { maintenance: { ...maintenance, maxPlanningRounds: 3 } },
  );
  try {
    const job = await orchestrator.startJob({ task: "Produce a and b", repoPath: repo });
    await orchestrator.waitFor(job.job_id);
    expect(store.mustJob(job.job_id).status).toBe("completed");
    expect(store.listTasks(job.job_id).map((task) => task.stableId)).toEqual(["a", "b"]);
    expect(store.listReviews(job.job_id)).toHaveLength(1);
    expect(store.humanGoal(job.job_id)).toBe("Produce a and b");
  } finally {
    await orchestrator.shutdown();
    store.close();
  }
});

it("honors a human decision to verify without repeating the same goal question", async () => {
  let audits = 0;
  const { orchestrator, store, repo } = memoryHarness(
    root(),
    {
      planner: (request) =>
        request.metadata?.role === "goal-supervisor"
          ? (audits++,
            jsonResponse({
              reply: "Please confirm verification",
              action: "ask_human",
              question: "Proceed to verification?",
              tasks: [],
              contracts: [],
            }))
          : jsonResponse(planValue([{ id: "a" }])),
      worker: (request) => {
        fs.writeFileSync(path.join(request.cwd!, "a.txt"), "done");
        return jsonResponse(doneResult());
      },
      reviewer: approve,
    },
    { maintenance: { ...maintenance, maxPlanningRounds: 3 } },
  );
  try {
    const job = await orchestrator.startJob({ task: "Produce a", repoPath: repo });
    await waitUntil(
      () => store.mustJob(job.job_id).reviewState === "awaiting_decision",
      "goal question",
    );
    const question = store.listDecisions(job.job_id)[0]!;
    orchestrator.resolveDecision({
      jobId: job.job_id,
      decisionId: question.id,
      option: "proceed",
      rationale: "Run verification against this implementation",
    });
    await orchestrator.waitFor(job.job_id);
    expect(store.mustJob(job.job_id).status).toBe("completed");
    expect(audits).toBe(1);
    expect(store.listReviews(job.job_id)).toHaveLength(1);
  } finally {
    await orchestrator.shutdown();
    store.close();
  }
});
