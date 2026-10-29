import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { createSwarmServer } from "../src/mcp/server.js";
import type { CallToolResult } from "@modelcontextprotocol/client";
import {
  deferred,
  jsonResponse,
  memoryHarness,
  planValue,
  removeTemp,
  tempDir,
} from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) removeTemp(dir);
  }
});

function textOf(result: CallToolResult): string {
  const block = result.content[0];
  return block && block.type === "text" ? block.text : "";
}

describe("MCP tools", () => {
  it("validates input, returns a job id immediately, and serves chat, votes, and results", async () => {
    const dir = tempDir("swarm-mcp-");
    dirs.push(dir);
    const gate = deferred();
    let plannerEntered = false;
    const { store, orchestrator, repo } = memoryHarness(dir, {
      planner: async () => {
        plannerEntered = true;
        await gate.promise;
        return jsonResponse(planValue([{ id: "a" }], ["Which file?"]));
      },
    });
    const handler = createMcpHandler(() => createSwarmServer(orchestrator));
    const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1/mcp"), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    });
    const client = new Client(
      { name: "swarm-test", version: "0.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(transport);
    try {
      let invalid = false;
      try {
        const rejected = await client.callTool({
          name: "start_swarm",
          arguments: { task: "", repo_path: repo },
        });
        invalid = rejected.isError === true;
      } catch {
        invalid = true;
      }
      expect(invalid).toBe(true);

      const started = await client.callTool({
        name: "start_swarm",
        arguments: { task: "plan only", repo_path: repo, dry_run: true },
      });
      expect(started.isError).not.toBe(true);
      const startedBody = started.structuredContent as { job_id: string; status: string };
      expect(plannerEntered).toBe(true);
      expect(startedBody.status).toBe("planning");
      expect(textOf(started)).toContain(startedBody.job_id);

      const early = await client.callTool({
        name: "swarm_result",
        arguments: { job_id: startedBody.job_id },
      });
      expect(early.structuredContent).toMatchObject({ ready: false, status: "planning" });

      const tooMany = await client.callTool({
        name: "start_swarm",
        arguments: { task: "too many", repo_path: repo, worker_count: 9 },
      });
      expect(tooMany.isError).toBe(true);
      expect(textOf(tooMany)).toContain("cap");

      gate.resolve();
      await orchestrator.waitFor(startedBody.job_id);

      const status = await client.callTool({
        name: "swarm_status",
        arguments: { job_id: startedBody.job_id },
      });
      expect(status.structuredContent).toMatchObject({
        status: "completed",
        review_state: "skipped_dry_run",
        dry_run: true,
      });

      const chat = await client.callTool({
        name: "swarm_chat",
        arguments: {
          job_id: startedBody.job_id,
          message: "hello from the client",
          channel: "general",
        },
      });
      expect(chat.isError).not.toBe(true);
      const chatBody = chat.structuredContent as { id: string; channel: string };
      expect(chatBody.channel).toBe("general");
      expect(
        store.listMessages(startedBody.job_id).some((message) => message.id === chatBody.id),
      ).toBe(true);
      expect(
        store.listMessages(startedBody.job_id).find((message) => message.id === chatBody.id)
          ?.messageType,
      ).toBe("chat");

      const listed = await client.callTool({
        name: "swarm_decisions",
        arguments: { job_id: startedBody.job_id },
      });
      const decisions = (
        listed.structuredContent as { decisions: Array<{ id: string; status: string }> }
      ).decisions;
      expect(decisions).toHaveLength(1);
      const decisionId = decisions[0]?.id;
      expect(decisionId).toBeTruthy();
      await client.callTool({
        name: "swarm_vote",
        arguments: { job_id: startedBody.job_id, decision_id: decisionId, option: "proceed" },
      });
      await client.callTool({
        name: "swarm_vote",
        arguments: {
          job_id: startedBody.job_id,
          decision_id: decisionId,
          option: "needs human answer",
          voter: "mcp-client",
          rationale: "changed",
        },
      });
      const decision = store.mustDecision(String(decisionId));
      expect(decision.status).toBe("open");
      expect(decision.votes).toHaveLength(1);
      expect(decision.votes[0]?.option).toBe("needs human answer");

      const result = await client.callTool({
        name: "swarm_result",
        arguments: { job_id: startedBody.job_id },
      });
      expect(result.structuredContent).toMatchObject({ ready: true, status: "completed" });

      const cancelled = await client.callTool({
        name: "cancel_swarm",
        arguments: { job_id: startedBody.job_id },
      });
      expect(cancelled.structuredContent).toMatchObject({ status: "completed" });

      const missing = await client.callTool({
        name: "swarm_status",
        arguments: { job_id: "missing-job" },
      });
      expect(missing.isError).toBe(true);
    } finally {
      await client.close();
      await handler.close();
      store.close();
    }
  });
});
