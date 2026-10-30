import { expect, it } from "vitest";
import { SwarmError } from "../src/errors.js";
import { Store } from "../src/db/store.js";
import { openDatabase } from "../src/db/connection.js";
import { startDashboard } from "../src/web/server.js";
import type { ProviderResponse } from "../src/providers/types.js";
import {
  jsonResponse,
  memoryHarness,
  openStore,
  planValue,
  removeTemp,
  tempDir,
} from "./helpers.js";

it("accepts chat immediately, exposes pending state, persists replies and failures, and permits retry", async () => {
  const root = tempDir("swarm-planner-chat-");
  let reply: ((value: ProviderResponse) => void) | undefined;
  let fail = false;
  let chatCalls = 0;
  const { store, orchestrator, repo, config } = memoryHarness(root, {
    planner: (request) => {
      if (request.metadata?.role !== "planner-chat") {
        const plan = planValue([{ id: "a" }]);
        plan.tasks[0]!.instructions = "verbose instructions ".repeat(250);
        return jsonResponse(plan);
      }
      chatCalls++;
      expect(request.totalTimeoutMs).toBeLessThanOrEqual(90000);
      expect(request.prompt).toContain("Original immutable request:");
      expect(request.prompt).toContain("Verification evidence:");
      expect(request.prompt).not.toContain("verbose instructions ".repeat(100));
      if (fail) throw new SwarmError("free provider unavailable", "timeout", true);
      return new Promise<ProviderResponse>((resolve) => {
        reply = resolve;
      });
    },
  });
  const { server, url } = await startDashboard(store, orchestrator, config, 0);
  try {
    const started = await orchestrator.startJob({
      task: "Build a lounge",
      repoPath: repo,
      dryRun: true,
    });
    const id = started.job_id;
    await orchestrator.waitFor(id);
    const page = await (await fetch(url)).text();
    const token = /name="swarm-token" content="([^"]+)"/.exec(page)![1]!;
    const post = (message: string) =>
      fetch(`${url}/api/jobs/${id}/chat`, {
        method: "POST",
        headers: { "x-swarm-token": token, "content-type": "application/json" },
        body: JSON.stringify({ message, background: true }),
      });
    const accepted = await post("What is the project status?");
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({ status: "pending" });
    expect(store.latestPlannerChat(id)?.status).toBe("pending");
    expect((await post("Duplicate while thinking")).status).toBe(409);
    expect(store.planningMessages(id).filter((item) => item.role === "caller")).toHaveLength(1);
    const detail = (await (
      await fetch(`${url}/api/jobs/${id}`, { headers: { "x-swarm-token": token } })
    ).json()) as { plannerChat: { status: string } };
    expect(detail.plannerChat.status).toBe("pending");
    await expect.poll(() => !!reply).toBe(true);
    reply!(
      jsonResponse({
        reply: "The project is planned; implementation has not started.",
        tasks: [],
        contracts: [],
      }),
    );
    await expect.poll(() => store.latestPlannerChat(id)?.status).toBe("completed");
    expect(store.planningMessages(id).at(-1)?.content).toContain("implementation has not started");
    fail = true;
    expect((await post("Why is this stalled?")).status).toBe(202);
    await expect.poll(() => store.latestPlannerChat(id)?.status).toBe("failed");
    expect(store.planningMessages(id).at(-1)?.content).toContain("free provider unavailable");
    expect(store.planningMessages(id).at(-1)?.role).toBe("system");
    fail = false;
    reply = undefined;
    expect((await post("Please retry my status question")).status).toBe(202);
    await expect.poll(() => !!reply).toBe(true);
    reply!(jsonResponse({ reply: "The planner is responding again.", tasks: [], contracts: [] }));
    await expect.poll(() => store.latestPlannerChat(id)?.status).toBe("completed");
    for (let index = 0; index < 120; index++)
      store.postMessage({
        jobId: id,
        sender: "worker",
        role: "worker",
        messageType: "status",
        content: "progress",
        maxChars: 100,
      });
    expect(
      store
        .planningMessages(id)
        .some((item) => item.content === "The planner is responding again."),
    ).toBe(true);
    expect(chatCalls).toBe(3);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await orchestrator.shutdown();
    store.close();
    removeTemp(root);
  }
});

it("marks unfinished chat failed after a restart and keeps the human message available", () => {
  const root = tempDir("swarm-chat-restart-");
  const { store, dbPath } = openStore(root);
  const job = store.createJob({
    task: "Build a lounge",
    repoPath: root,
    baseBranch: "main",
    workerCount: 1,
    configProfile: "default",
    dryRun: true,
    maxAttempts: 1,
    maxReviewRounds: 1,
  });
  store.beginPlannerChat(job.id, "Can you explain the project?", 16000);
  store.close();
  const reopened = new Store(openDatabase(dbPath));
  try {
    reopened.recoverInterrupted();
    expect(reopened.latestPlannerChat(job.id)?.status).toBe("failed");
    expect(reopened.planningMessages(job.id).at(-1)?.content).toContain("service restarted");
    expect(reopened.planningMessages(job.id)[0]?.content).toBe("Can you explain the project?");
    expect(() => reopened.beginPlannerChat(job.id, "Retry", 16000)).not.toThrow();
  } finally {
    reopened.close();
    removeTemp(root);
  }
});
