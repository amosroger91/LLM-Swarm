import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { stringify } from "yaml";
import { openDatabase } from "../src/db/connection.js";
import { Store } from "../src/db/store.js";
import {
  initRepo,
  planValue,
  projectRoot,
  removeTemp,
  tempDir,
  testConfig,
  waitUntil,
} from "./helpers.js";

it("recovers a dead scheduler through the cron CLI and reuses the successful predecessor commit", async () => {
  const root = tempDir("swarm-cron-cli-");
  const repo = path.join(root, "repo");
  initRepo(repo);
  let secondStarted = false;
  let recovering = false;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        messages: Array<{ content: string }>;
      };
      const system = body.messages[0]!.content;
      const prompt = body.messages.at(-1)!.content;
      let result: unknown;
      if (system.includes("You are the planner"))
        result = planValue([{ id: "a" }, { id: "b", dependencies: ["a"] }]);
      else if (system.includes("You are the reviewer"))
        result = { approved: true, summary: "Both files verified", findings: [] };
      else {
        const task = /Task ([ab]):/.exec(prompt)![1]!;
        if (task === "b" && !recovering) {
          secondStarted = true;
          return;
        }
        result = {
          status: "done",
          summary: `Created ${task}`,
          files: [{ path: `${task}.txt`, content: `${task}\n` }],
        };
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const config = testConfig(path.join(root, "data"), {
    providerTimeoutMs: 20000,
    jobTimeoutMs: 60000,
    checks: [
      {
        command: process.execPath,
        args: [
          "-e",
          "const f=require('node:fs');if(f.readFileSync('a.txt','utf8')!=='a\\n'||f.readFileSync('b.txt','utf8')!=='b\\n')process.exit(1)",
        ],
      },
    ],
    requireChecks: true,
  });
  const provider = config.providers.ollama!;
  if (provider.type !== "openai_compatible") throw new Error("fixture");
  provider.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const configPath = path.join(root, "config.yaml");
  fs.writeFileSync(configPath, stringify(config));
  const marker = path.join(root, "job-id");
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(projectRoot, "test/fixtures/start-recoverable-job.ts"),
      configPath,
      repo,
      marker,
    ],
    { cwd: projectRoot, stdio: "ignore", windowsHide: true },
  );
  let store: Store | undefined;
  try {
    await waitUntil(
      () => fs.existsSync(marker) && secondStarted,
      "dependent worker waiting",
      15000,
    );
    const jobId = fs.readFileSync(marker, "utf8");
    child.kill("SIGKILL");
    await once(child, "exit");
    recovering = true;
    const cron = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(projectRoot, "src/cli.ts"),
        "maintenance",
        "--config",
        configPath,
      ],
      { cwd: projectRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    cron.stdout.on("data", (chunk) => (output += chunk));
    cron.stderr.on("data", (chunk) => (output += chunk));
    const [exit] = await once(cron, "exit");
    expect(exit, output).toBe(0);
    store = new Store(openDatabase(path.join(root, "data/swarm.db")));
    expect(store.mustJob(jobId).status).toBe("completed");
    const tasks = store.listTasks(jobId);
    expect(tasks.find((task) => task.stableId === "a")?.attemptCount).toBe(1);
    expect(tasks.find((task) => task.stableId === "b")?.attemptCount).toBe(2);
    expect(fs.readFileSync(path.join(repo, "workspaces", jobId, "integration/a.txt"), "utf8")).toBe(
      "a\n",
    );
    expect(fs.readFileSync(path.join(repo, "workspaces", jobId, "integration/b.txt"), "utf8")).toBe(
      "b\n",
    );
    expect(
      store.listEvents(jobId, 1000).some((event) => event.type === "maintenance.auto_resumed"),
    ).toBe(true);
  } finally {
    child.kill("SIGKILL");
    store?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    removeTemp(root);
  }
}, 30000);
