import http from "node:http";
import fs from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Store } from "../db/store.js";
import type { SwarmConfig } from "../config/schema.js";
import type { Orchestrator } from "../orchestration/service.js";
import { SwarmError, errorMessage } from "../errors.js";
import { BACKEND_METHODS, writeDashboardInfo, type BackendMethod } from "../mcp/backend.js";

/** Loopback-only control surface. No SQL endpoint, permissive CORS, or remote binding. */
export async function startDashboard(
  store: Store,
  orchestrator: Orchestrator,
  config: SwarmConfig,
  port = 4317,
  options: { anyPort?: boolean; advertise?: boolean } = {},
): Promise<{ server: http.Server; url: string; token: string }> {
  const token = randomBytes(32).toString("hex");
  const assets = new Map([
    ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
    ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
    ["/style.css", { file: "style.css", type: "text/css; charset=utf-8" }],
  ]);
  let origin = "";
  const chats = new Set<string>();
  const json = (response: http.ServerResponse, status: number, data: unknown): void => {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(data));
  };
  const body = async (request: http.IncomingMessage, limit = 100_000): Promise<unknown> => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += (chunk as Buffer).length;
      if (bytes > limit) throw new Error(`Request body exceeds ${Math.round(limit / 1000)} KB`);
      chunks.push(chunk as Buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  };
  const detail = (id: string): Record<string, unknown> => ({
    job: store.mustJob(id),
    humanGoal: store.humanGoal(id),
    status: orchestrator.status(id),
    tasks: store.listTasks(id),
    dependencies: Object.fromEntries(store.dependencyMap(id)),
    runs: store.listRuns(id),
    messages: store.listMessages(id, 150),
    decisions: store.listDecisions(id),
    reviews: store.listReviews(id),
    events: store.listEvents(id, 100),
    artifacts: store.listArtifacts(id),
    worktrees: store.listWorktrees(id),
    proposals: store.proposals(id),
  });
  const server = http.createServer((request, response) => {
    void (async () => {
      response.setHeader("cache-control", "no-store");
      response.setHeader("x-content-type-options", "nosniff");
      response.setHeader("x-frame-options", "DENY");
      response.setHeader(
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
      if (request.headers.host !== new URL(origin).host) {
        json(response, 403, { error: "Invalid dashboard host" });
        return;
      }
      const pathname = new URL(request.url ?? "/", origin).pathname;
      if (request.method === "GET" && assets.has(pathname)) {
        const asset = assets.get(pathname)!;
        const source = fs.readFileSync(
          fileURLToPath(new URL(`../../web/${asset.file}`, import.meta.url)),
          "utf8",
        );
        response.writeHead(200, { "content-type": asset.type });
        response.end(pathname === "/" ? source.replace("__SWARM_TOKEN__", token) : source);
        return;
      }
      if (pathname === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }
      if (!pathname.startsWith("/api/")) {
        json(response, 404, { error: "Not found" });
        return;
      }
      const supplied = request.headers["x-swarm-token"];
      if (
        typeof supplied !== "string" ||
        supplied.length !== token.length ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
      ) {
        json(response, 403, { error: "Dashboard session token required" });
        return;
      }
      if (request.headers.origin && request.headers.origin !== origin) {
        json(response, 403, { error: "Cross-origin requests are not allowed" });
        return;
      }
      if (request.method === "GET" && pathname === "/api/state") {
        json(response, 200, {
          jobs: store.listJobs(100).map((job) => ({
            ...job,
            finalReport: undefined,
            plannerOutput: undefined,
            planJson: undefined,
            counts: store.taskCounts(job.id),
            blockers: store.listBlockers(job.id).filter((blocker) => blocker.status !== "resolved")
              .length,
          })),
          profiles: Object.keys(config.profiles),
          defaultProfile: config.defaultProfile,
          defaultWorkerCount: config.defaultWorkerCount,
          maintenance: config.maintenance,
          requireChecks: config.requireChecks,
          checkCount: config.checks.length,
          serverTime: new Date().toISOString(),
        });
        return;
      }
      if (request.method === "GET" && pathname === "/api/providers") {
        json(response, 200, {
          ...orchestrator.providersView(),
          delegations: store.listDelegations(30),
        });
        return;
      }
      const match = /^\/api\/jobs\/([^/]+)(?:\/([^/]+))?$/.exec(pathname);
      if (request.method === "GET" && match && !match[2]) {
        json(response, 200, detail(decodeURIComponent(match[1]!)));
        return;
      }
      if (request.method !== "POST") {
        json(response, 405, { error: "Method not allowed" });
        return;
      }
      const input = await body(request, pathname === "/api/rpc" ? 4_000_000 : 100_000);
      if (pathname === "/api/rpc") {
        // MCP clients in other processes drive this scheduler through the same methods
        // they would call in-process. Only listed orchestrator methods are reachable.
        const { method, args } = z
          .object({ method: z.string(), args: z.array(z.unknown()).max(10) })
          .parse(input);
        if (!(BACKEND_METHODS as readonly string[]).includes(method)) {
          json(response, 404, { error: `Unknown method ${method}` });
          return;
        }
        const target = orchestrator[method as BackendMethod] as (...values: unknown[]) => unknown;
        json(response, 200, { result: await target.apply(orchestrator, args) });
        return;
      }
      if (pathname === "/api/jobs") {
        const start = z
          .object({
            task: z.string().min(1).max(20000),
            repoPath: z.string().min(1),
            baseBranch: z.string().optional(),
            workerCount: z.number().int().positive().optional(),
            configProfile: z.string().optional(),
            dryRun: z.boolean().optional(),
            plan: z.unknown().optional(),
          })
          .parse(input);
        json(response, 202, await orchestrator.startJob(start));
        return;
      }
      if (pathname === "/api/maintenance") {
        json(response, 200, await orchestrator.maintenanceTick());
        return;
      }
      if (!match) {
        json(response, 404, { error: "Unknown action" });
        return;
      }
      const id = decodeURIComponent(match[1]!);
      store.mustJob(id);
      switch (match[2]) {
        case "launch":
          json(response, 202, await orchestrator.launchPlan(id));
          return;
        case "cancel":
          json(response, 200, orchestrator.cancel(id));
          return;
        case "resume":
          json(response, 202, await orchestrator.resume(id));
          return;
        case "chat": {
          if (chats.has(id)) {
            json(response, 409, {
              error: "The planner is already considering a message for this job",
            });
            return;
          }
          const { message } = z.object({ message: z.string().min(1).max(16000) }).parse(input);
          chats.add(id);
          try {
            json(response, 200, await orchestrator.plannerChat(id, message));
          } finally {
            chats.delete(id);
          }
          return;
        }
        case "apply": {
          const { proposalId } = z.object({ proposalId: z.string().min(1) }).parse(input);
          json(response, 202, await orchestrator.applyProposal(id, proposalId));
          return;
        }
        case "resolve": {
          const answer = z
            .object({
              decisionId: z.string().min(1),
              option: z.string().min(1),
              rationale: z.string().min(1).max(4000),
            })
            .parse(input);
          json(response, 200, orchestrator.resolveDecision({ jobId: id, ...answer }));
          return;
        }
        default:
          json(response, 404, { error: "Unknown action" });
      }
    })().catch((error) => {
      if (!response.headersSent)
        json(response, 400, {
          error: errorMessage(error),
          ...(error instanceof SwarmError ? { code: error.code } : {}),
        });
      else response.end();
    });
  });
  // Delegations and waits can legitimately hold a request open for many minutes.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  const listen = (value: number) =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(value, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  try {
    await listen(port);
  } catch (error) {
    if (!options.anyPort || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    await listen(0);
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Dashboard did not bind");
  origin = `http://127.0.0.1:${address.port}`;
  if (options.advertise !== false)
    writeDashboardInfo(config.dataDir, {
      url: origin,
      token,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
  return { server, url: origin, token };
}
