import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { validatePlan } from "../src/orchestration/planner.js";
import { workspaceTools } from "../src/orchestration/tools.js";
import { OpenAICompatibleProvider } from "../src/providers/openai.js";
import {
  doneResult,
  jsonResponse,
  memoryHarness,
  planValue,
  providerConfig,
  removeTemp,
  tempDir,
  waitUntil,
} from "./helpers.js";

const dirs: string[] = [];
afterEach(() => {
  dirs.splice(0).forEach(removeTemp);
  vi.unstubAllGlobals();
});
const dir = (): string => {
  const root = tempDir("swarm-reliability-");
  dirs.push(root);
  return root;
};

it("rejects the music app's absolute ownership paths before any worker starts", () => {
  for (const file of [
    "/src/index.css",
    "C:/src/App.tsx",
    "src/../App.tsx",
    "workspaces/app",
    "src/*.ts",
  ]) {
    const plan = planValue([{ id: "ui" }]);
    plan.tasks[0]!.fileAreas = [file];
    expect(validatePlan(plan).ok).toBe(false);
  }
  const plan = planValue([{ id: "ui" }]);
  plan.tasks[0]!.fileAreas = ["./src/components/"];
  const checked = validatePlan(plan);
  expect(checked.ok && checked.plan.tasks[0]!.fileAreas).toEqual(["src/components"]);
});

it("blocks scheduling for a human answer and delivers the resolved option and rationale", async () => {
  let prompt = "";
  const { orchestrator, store, repo } = memoryHarness(dir(), {
    planner: () => jsonResponse(planValue([{ id: "a" }], ["Which format?"])),
    worker: (request) => {
      prompt = request.prompt;
      return jsonResponse(doneResult());
    },
    reviewer: () => jsonResponse({ approved: true, summary: "approved", findings: [] }),
  });
  try {
    const job = await orchestrator.startJob({ task: "implement", repoPath: repo });
    await waitUntil(
      () => store.mustJob(job.job_id).reviewState === "awaiting_decision",
      "waiting for a decision",
    );
    expect(store.listRuns(job.job_id)).toHaveLength(0);
    const question = store.listDecisions(job.job_id)[0]!;
    orchestrator.resolveDecision({
      jobId: job.job_id,
      decisionId: question.id,
      option: "proceed",
      rationale: "Use JSON with version 2",
    });
    await orchestrator.waitFor(job.job_id);
    expect(prompt).toContain("answer: proceed");
    expect(prompt).toContain("Use JSON with version 2");
    expect(store.mustJob(job.job_id).status).toBe("completed");
  } finally {
    await orchestrator.shutdown();
    store.close();
  }
});

it("resumes failed work without rerunning completed prerequisites and keeps attempt identities unique", async () => {
  const counts: Record<string, number> = {};
  let broken = true;
  const { orchestrator, store, repo } = memoryHarness(dir(), {
    planner: () => jsonResponse(planValue([{ id: "a" }, { id: "b", dependencies: ["a"] }])),
    worker: (request) => {
      const id = request.metadata!.taskId!;
      counts[id] = (counts[id] ?? 0) + 1;
      if (id === "b" && broken)
        return jsonResponse({ status: "failed", summary: "temporary failure" });
      fs.writeFileSync(path.join(request.cwd!, `${id}.txt`), "done");
      return jsonResponse(doneResult());
    },
    reviewer: () => jsonResponse({ approved: true, summary: "approved", findings: [] }),
  });
  try {
    const job = await orchestrator.startJob({ task: "implement", repoPath: repo });
    await orchestrator.waitFor(job.job_id);
    expect(store.mustJob(job.job_id).status).toBe("failed");
    broken = false;
    await orchestrator.resume(job.job_id);
    await orchestrator.waitFor(job.job_id);
    expect(store.mustJob(job.job_id).status).toBe("completed");
    expect(counts).toEqual({ a: 1, b: 3 });
    expect(store.listRuns(job.job_id).map((run) => run.attempt)).toEqual([1, 1, 2, 3]);
    expect(store.measurements(job.job_id)).toMatchObject({
      providerCalls: 6,
      totalTokens: null,
      retries: 2,
    });
    await expect(orchestrator.resume(job.job_id)).rejects.toThrow("Cannot resume");
  } finally {
    await orchestrator.shutdown();
    store.close();
  }
});

it("exchanges messages during a run and contains file tools before they write", async () => {
  const { orchestrator, store, repo } = memoryHarness(dir(), {});
  const job = store.createJob({
    task: "tools",
    repoPath: repo,
    baseBranch: "main",
    configProfile: null,
    workerCount: 2,
    dryRun: false,
    maxAttempts: 2,
    maxReviewRounds: 3,
  });
  const tools = workspaceTools({
    root: repo,
    store,
    config: (await import("./helpers.js")).testConfig(dir()),
    jobId: job.id,
    taskId: undefined,
    sender: "worker-a",
    allowedPaths: ["src/a.ts"],
    signal: new AbortController().signal,
  });
  const call = (name: string, args: unknown) =>
    tools.find((tool) => tool.name === name)!.execute(args);
  try {
    await call("post_message", { content: "export function loadTrack(id: number)" });
    expect(JSON.stringify(await call("read_coordination", {}))).toContain("loadTrack");
    for (const file of ["../escape.txt", ".env", "src/b.ts", "workspaces/other/a.ts"])
      await expect(call("write_file", { path: file, content: "bad" })).rejects.toThrow();
    await call("write_file", { path: "src/a.ts", content: "export const a = 1;" });
    expect(fs.readFileSync(path.join(repo, "src/a.ts"), "utf8")).toContain("const a");
    expect(JSON.stringify(await call("search_source", { query: "const a" }))).toContain("src/a.ts");
  } finally {
    await orchestrator.shutdown();
    store.close();
  }
});

it("runs native API tool calls and records each model call's usage", async () => {
  let n = 0;
  const calls: unknown[] = [];
  const execute = vi.fn(async () => ({ content: "source" }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.tools[0].function.name).toBe("read_file");
      expect(body.response_format).toBeUndefined();
      if (n++) expect(body.messages.at(-1).content).toContain("source");
      return new Response(
        JSON.stringify({
          choices: [
            {
              message:
                n === 1
                  ? {
                      content: null,
                      tool_calls: [
                        {
                          id: "call-1",
                          type: "function",
                          function: { name: "read_file", arguments: '{"path":"a.ts"}' },
                        },
                      ],
                    }
                  : { content: '{"status":"done"}' },
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
      );
    }),
  );
  const config = providerConfig();
  if (config.type !== "openai_compatible") throw new Error("fixture");
  config.capabilities.toolCalling = true;
  const provider = new OpenAICompatibleProvider(config, "fake");
  const result = await provider.complete({
    prompt: "implement",
    expectJson: true,
    tools: [{ name: "read_file", description: "read", parameters: { type: "object" }, execute }],
    onCall: (call) => calls.push(call),
  });
  expect(result.structured).toEqual({ status: "done" });
  expect(execute).toHaveBeenCalledWith({ path: "a.ts" });
  expect(calls).toHaveLength(2);
});

it("allows a productive Ollama tool turn to outlast one request deadline and preserves native tool arguments", async () => {
  const options = providerConfig();
  if (options.type !== "openai_compatible") throw new Error("fixture");
  Object.assign(options, { protocol: "ollama", contextTokens: 8192, maxToolRounds: 4 });
  options.capabilities.toolCalling = true;
  const adapter = new OpenAICompatibleProvider(options, "native-test");
  let calls = 0;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    expect(url).toContain("/api/chat");
    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(false);
    expect(body.options.num_ctx).toBe(8192);
    await new Promise((resolve) => setTimeout(resolve, 200));
    calls++;
    const message =
      calls === 1
        ? { content: "", tool_calls: [{ function: { name: "read_coordination", arguments: {} } }] }
        : calls === 2
          ? {
              content: "",
              tool_calls: [
                { function: { name: "write_file", arguments: { path: "a.txt", content: "done" } } },
              ],
            }
          : { content: '{"status":"done","summary":"Implemented"}' };
    return new Response(
      JSON.stringify({ model: "native-test", message, prompt_eval_count: 3, eval_count: 2 }),
    );
  });
  const { orchestrator, store, repo } = memoryHarness(
    dir(),
    {
      worker: (request) => adapter.complete(request),
      reviewer: () => jsonResponse({ approved: true, summary: "accepted", findings: [] }),
    },
    { providers: { ollama: options }, providerTimeoutMs: 400, agentTimeoutMs: 3000 },
  );
  try {
    const started = Date.now();
    const job = await orchestrator.startJob({
      task: "Implement",
      repoPath: repo,
      plan: planValue([{ id: "a" }]),
    });
    await orchestrator.waitFor(job.job_id);
    expect(Date.now() - started).toBeGreaterThan(400);
    expect(store.mustJob(job.job_id).status).toBe("completed");
    expect(calls).toBe(3);
    expect(store.measurements(job.job_id)).toMatchObject({ callsWithUsage: 3, totalTokens: 15 });
  } finally {
    await orchestrator.shutdown();
    store.close();
  }
});

it("repairs malformed reviewer output without discarding verification evidence", async () => {
  let reviews = 0;
  const { orchestrator, store, repo } = memoryHarness(dir(), {
    worker: (request) => {
      fs.writeFileSync(path.join(request.cwd!, "a.txt"), "done");
      return jsonResponse(doneResult());
    },
    reviewer: () =>
      jsonResponse(
        ++reviews === 1
          ? {
              approved: true,
              summary: "Conflicting assessment",
              findings: [
                { severity: "critical", message: "Unresolved defect", instruction: "Fix it" },
              ],
            }
          : { approved: true, summary: "Corrected assessment", findings: [] },
      ),
  });
  try {
    const job = await orchestrator.startJob({
      task: "implement",
      repoPath: repo,
      plan: planValue([{ id: "a" }]),
    });
    await orchestrator.waitFor(job.job_id);
    expect(store.mustJob(job.job_id).status).toBe("completed");
    expect(reviews).toBe(2);
    expect(
      store.listEvents(job.job_id, 1000).some((event) => event.type === "review.output_rejected"),
    ).toBe(true);
    expect(store.listReviews(job.job_id)).toHaveLength(1);
  } finally {
    await orchestrator.shutdown();
    store.close();
  }
});

it("does not approve contradictory critical findings when the reviewer cannot repair its response", async () => {
  const { orchestrator, store, repo } = memoryHarness(dir(), {
    worker: (request) => {
      fs.writeFileSync(path.join(request.cwd!, "a.txt"), "done");
      return jsonResponse(doneResult());
    },
    reviewer: () =>
      jsonResponse({
        approved: true,
        summary: "Contradictory",
        findings: [{ severity: "critical", message: "Unresolved defect", instruction: "Fix it" }],
      }),
  });
  try {
    const job = await orchestrator.startJob({
      task: "implement",
      repoPath: repo,
      plan: planValue([{ id: "a" }]),
    });
    await orchestrator.waitFor(job.job_id);
    expect(store.mustJob(job.job_id).status).toBe("failed");
    expect(store.listReviews(job.job_id)).toHaveLength(0);
  } finally {
    await orchestrator.shutdown();
    store.close();
  }
});

it("keeps long check evidence parseable instead of cutting JSON in the middle of an escape", async () => {
  const { orchestrator, store, repo } = memoryHarness(dir(), {});
  try {
    const job = store.createJob({
      task: "evidence",
      repoPath: repo,
      baseBranch: "main",
      configProfile: null,
      workerCount: 1,
      dryRun: false,
      maxAttempts: 1,
      maxReviewRounds: 1,
    });
    const artifact = store.insertArtifact({
      jobId: job.id,
      kind: "checks",
      summary: JSON.stringify({ status: "failed", summary: '"\n\\'.repeat(8000) }),
    });
    expect(artifact.summary.length).toBeLessThanOrEqual(8000);
    expect(JSON.parse(artifact.summary)).toMatchObject({ status: "failed", truncated: true });
  } finally {
    await orchestrator.shutdown();
    store.close();
  }
});
