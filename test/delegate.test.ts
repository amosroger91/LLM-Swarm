import fs from "node:fs";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { remoteBackend, readDashboardInfo } from "../src/mcp/backend.js";
import { createSwarmServer } from "../src/mcp/server.js";
import { collectFiles } from "../src/orchestration/delegate.js";
import { startDashboard } from "../src/web/server.js";
import {
  doneResult,
  jsonResponse,
  memoryHarness,
  planValue,
  removeTemp,
  tempDir,
  textResponse,
} from "./helpers.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(removeTemp));

function project(): string {
  const root = tempDir("swarm-delegate-");
  dirs.push(root);
  fs.mkdirSync(path.join(root, "src", "nested"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(root, "src", "nested", "b.ts"), "export const b = 2;\n");
  fs.writeFileSync(path.join(root, "node_modules", "dep", "index.js"), "skip");
  return root;
}

async function connect(server: ReturnType<typeof createSwarmServer>) {
  const handler = createMcpHandler(() => server);
  const client = new Client(
    { name: "delegate-test", version: "0.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://127.0.0.1/mcp"), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    }),
  );
  return client;
}

const textOf = (result: CallToolResult): string => {
  const block = result.content[0];
  return block && block.type === "text" ? block.text : "";
};

describe("file collection", () => {
  it("expands globs and directories, skips dependency folders, and refuses escapes", () => {
    const root = project();
    const names = (files: string[]) => files.map((file) => path.relative(root, file));
    expect(names(collectFiles(root, ["src/**/*.ts"], 10))).toEqual([
      path.join("src", "a.ts"),
      path.join("src", "nested", "b.ts"),
    ]);
    expect(names(collectFiles(root, ["."], 10))).not.toContain(
      path.join("node_modules", "dep", "index.js"),
    );
    expect(() => collectFiles(root, ["../"], 10)).toThrow(/outside/);
    expect(() => collectFiles(root, ["src"], 1)).toThrow(/More than 1 files/);
  });
});

describe("delegate tools", () => {
  it("sends numbered files to the cheap agent, returns only its answer, and records the offload", async () => {
    const root = project();
    const prompts: string[] = [];
    const { orchestrator, store } = memoryHarness(root, {
      worker: (request) => {
        expect(request.metadata?.role).toBe("delegate");
        prompts.push(request.prompt);
        return textResponse(`summary of ${prompts.length}`);
      },
    });
    const client = await connect(createSwarmServer(orchestrator, { tools: "core", cwd: root }));
    try {
      const tools = (await client.listTools()).tools.map((tool) => tool.name);
      expect(tools).toContain("delegate");
      expect(tools).toContain("swarm_wait");
      expect(tools).not.toContain("swarm_vote");

      const single = await client.callTool({
        name: "delegate",
        arguments: { task: "Summarize", files: ["src/a.ts"] },
      });
      expect(textOf(single as CallToolResult)).toMatch(/^summary of 1\n\n\[fake/);
      expect(prompts[0]).toContain("=== src/a.ts ===\n1| export const a = 1;");
      expect(prompts[0]).toContain("TASK:\nSummarize");

      const mapped = await client.callTool({
        name: "delegate_map",
        arguments: { task: "List exports", files: ["src"], reduce: "Combine" },
      });
      const output = textOf(mapped as CallToolResult);
      expect(output).toContain("summary of 4");
      expect(output).toContain("2 files · 0 failed");
      expect(prompts.at(-1)).toContain("TASK:\nCombine");

      const escaped = await client.callTool({
        name: "delegate",
        arguments: { task: "x", files: ["../../etc/passwd"] },
      });
      expect(escaped.isError).toBe(true);
      expect(store.delegationTotals().count).toBe(4);
    } finally {
      await client.close();
      await orchestrator.shutdown();
      store.close();
    }
  });

  it("drives a dashboard-owned scheduler from a remote MCP backend", async () => {
    const root = project();
    const { orchestrator, store, repo, config } = memoryHarness(root, {
      planner: () => jsonResponse(planValue([{ id: "a" }])),
      worker: (request) => {
        if (request.metadata?.role === "delegate") return textResponse("remote answer");
        fs.writeFileSync(path.join(request.cwd!, "a.txt"), "done");
        return jsonResponse(doneResult());
      },
      reviewer: () => jsonResponse({ approved: true, summary: "ok", findings: [] }),
    });
    const { server } = await startDashboard(store, orchestrator, config, 0);
    try {
      const info = readDashboardInfo(config.dataDir)!;
      expect(info.pid).toBe(process.pid);
      const remote = remoteBackend(info);
      const client = await connect(createSwarmServer(remote, { cwd: root }));
      try {
        const started = await client.callTool({
          name: "start_swarm",
          arguments: { task: "make a", repo_path: repo },
        });
        const { job_id } = started.structuredContent as { job_id: string };
        const waited = await client.callTool({
          name: "swarm_wait",
          arguments: { job_id, timeout_s: 20 },
        });
        expect(waited.structuredContent).toMatchObject({ done: true, status: "completed" });
        expect(
          (waited.structuredContent as { measurements: Record<string, unknown> }).measurements,
        ).not.toHaveProperty("calls");
        const delegated = await client.callTool({
          name: "delegate",
          arguments: { task: "hi", files: ["src/a.ts"] },
        });
        expect(textOf(delegated as CallToolResult)).toContain("remote answer");
        await expect(
          (remote as unknown as { jobs: (n: number) => Promise<unknown[]> }).jobs(5),
        ).resolves.toHaveLength(1);
      } finally {
        await client.close();
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await orchestrator.shutdown();
      store.close();
    }
  });
});
