import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import {
  doneResult,
  jsonResponse,
  memoryHarness,
  planValue,
  removeTemp,
  tempDir,
} from "./helpers.js";

it("keeps the full human goal accessible while tool workers use bounded source pages", async () => {
  const root = tempDir("swarm-budget-");
  const humanGoal = "Immutable human requirement. ".repeat(250);
  const { store, orchestrator, repo } = memoryHarness(
    root,
    {
      planner: () => jsonResponse(planValue([{ id: "a" }])),
      worker: async (request) => {
        expect(request.prompt).toContain(
          "full immutable human request is available through read_goal",
        );
        expect(request.prompt).not.toContain(humanGoal);
        const readGoal = request.tools!.find((tool) => tool.name === "read_goal")!;
        let collected = "",
          offset: number | null = 0;
        while (offset !== null) {
          const page = (await readGoal.execute({ offset, limit: 2000 })) as {
            content: string;
            nextOffset: number | null;
          };
          expect(page.content.length).toBeLessThanOrEqual(2000);
          collected += page.content;
          offset = page.nextOffset;
        }
        expect(collected).toBe(humanGoal);
        fs.writeFileSync(path.join(request.cwd!, "a.txt"), "x".repeat(6000));
        const read = request.tools!.find((tool) => tool.name === "read_file")!;
        const first = (await read.execute({ path: "a.txt" })) as {
          content: string;
          nextOffset: number;
        };
        expect(first.content).toHaveLength(4000);
        expect(first.nextOffset).toBe(4000);
        await expect(read.execute({ path: "a.txt", limit: 4001 })).rejects.toBeDefined();
        return jsonResponse(doneResult());
      },
      reviewer: () => jsonResponse({ approved: true, summary: "fixture reviewed", findings: [] }),
    },
    {
      costPolicy: "local_or_free",
      providers: {
        ollama: {
          type: "openai_compatible",
          baseUrl: "http://127.0.0.1:9/v1",
          model: "fixture",
          apiKeyOptional: true,
          timeoutMs: 1000,
          jsonMode: "json_object",
          capabilities: {
            toolCalling: true,
            structuredOutput: true,
            streaming: false,
            nonInteractive: true,
          },
        },
      },
    },
  );
  try {
    const started = await orchestrator.startJob({ repoPath: repo, task: humanGoal });
    await orchestrator.waitFor(started.job_id);
    expect(store.mustJob(started.job_id).status).toBe("completed");
    expect(store.humanGoal(started.job_id)).toBe(humanGoal);
  } finally {
    await orchestrator.shutdown();
    store.close();
    removeTemp(root);
  }
});
