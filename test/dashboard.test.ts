import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { startDashboard } from "../src/web/server.js";
import {
  doneResult,
  jsonResponse,
  memoryHarness,
  planValue,
  tempDir,
  removeTemp,
} from "./helpers.js";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(removeTemp));
it("serves live database state, rejects cross-origin control, and applies planner tasks once", async () => {
  const root = tempDir("swarm-dashboard-");
  roots.push(root);
  const { orchestrator, store, repo, config } = memoryHarness(root, {
    planner: (request) => {
      if (request.metadata?.role === "planner-chat") {
        expect(request.prompt).toContain("Verification evidence:");
        expect(request.prompt).toContain('"status":"approved"');
        return jsonResponse({
          reply: "I propose an implementation task",
          tasks: planValue([{ id: "new-output" }]).tasks,
          contracts: [],
        });
      }
      return jsonResponse(planValue([{ id: "a" }]));
    },
    worker: (request) => {
      fs.writeFileSync(path.join(request.cwd!, `${request.metadata!.taskId}.txt`), "done");
      return jsonResponse(doneResult());
    },
    reviewer: () => jsonResponse({ approved: true, summary: "accepted", findings: [] }),
  });
  const { server, url } = await startDashboard(store, orchestrator, config, 0);
  try {
    const page = await (await fetch(url)).text();
    const token = /name="swarm-token" content="([^"]+)"/.exec(page)![1]!;
    expect(page).toContain("Planning room");
    expect((await fetch(`${url}/api/state`)).status).toBe(403);
    const request = (route: string, data?: unknown, origin?: string) =>
      fetch(`${url}${route}`, {
        headers: {
          "x-swarm-token": token,
          "content-type": "application/json",
          ...(origin ? { origin } : {}),
        },
        ...(data ? { method: "POST", body: JSON.stringify(data) } : {}),
      });
    expect((await request("/api/jobs", {}, "https://untrusted.example")).status).toBe(403);
    const started = await request("/api/jobs", { task: "plan only", repoPath: repo, dryRun: true });
    const job = (await started.json()) as { job_id: string };
    await orchestrator.waitFor(job.job_id);
    expect((await request(`/api/jobs/${job.job_id}/launch`, {})).status).toBe(202);
    await orchestrator.waitFor(job.job_id);
    expect(store.listTasks(job.job_id)[0]!.status).toBe("done");
    expect((await request(`/api/jobs/${job.job_id}/launch`, {})).status).toBe(400);
    const chat = await request(`/api/jobs/${job.job_id}/chat`, { message: "Add a new output" });
    const proposal = (await chat.json()) as { proposalId: string };
    expect(chat.status).toBe(200);
    expect(store.listTasks(job.job_id)).toHaveLength(1);
    const applied = await request(`/api/jobs/${job.job_id}/apply`, {
      proposalId: proposal.proposalId,
    });
    expect(applied.status).toBe(202);
    await orchestrator.waitFor(job.job_id);
    expect(store.listTasks(job.job_id).map((task) => task.stableId)).toEqual(["a", "new-output"]);
    expect(store.mustJob(job.job_id).status).toBe("completed");
    expect(store.listTasks(job.job_id)[0]!.attemptCount).toBe(1);
    expect(
      (await request(`/api/jobs/${job.job_id}/apply`, { proposalId: proposal.proposalId })).status,
    ).toBe(400);
    const state = (await (await request(`/api/jobs/${job.job_id}`)).json()) as {
      humanGoal: string;
      status: { blockers: unknown[] };
    };
    expect(state.humanGoal).toBe("plan only");
    expect(state.status.blockers).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await orchestrator.shutdown();
    store.close();
  }
});
