import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { SwarmError } from "../errors.js";
import type { Orchestrator } from "../orchestration/service.js";

type Awaitable<T> = T | Promise<T>;
type Async<F> = F extends (...args: infer A) => infer R
  ? (...args: A) => Awaitable<Awaited<R>>
  : never;

/** Orchestrator methods the MCP server and dashboard RPC may call. */
export const BACKEND_METHODS = [
  "startJob",
  "status",
  "result",
  "jobs",
  "wait",
  "cancel",
  "resume",
  "launchPlan",
  "chat",
  "decisions",
  "vote",
  "resolveDecision",
  "plannerChat",
  "applyProposal",
  "maintenanceTick",
  "delegate",
  "delegateMap",
  "providersView",
] as const;

export type BackendMethod = (typeof BACKEND_METHODS)[number];
export type SwarmBackend = { [K in BackendMethod]: Async<Orchestrator[K]> };

export interface DashboardInfo {
  url: string;
  token: string;
  pid: number;
  startedAt: string;
}

export function dashboardInfoPath(dataDir: string): string {
  return path.join(path.resolve(dataDir), "dashboard.json");
}

export function writeDashboardInfo(dataDir: string, info: DashboardInfo): void {
  const file = dashboardInfoPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(info), { mode: 0o600 });
}

export function removeDashboardInfo(dataDir: string, pid = process.pid): void {
  const info = readDashboardInfo(dataDir);
  if (info?.pid === pid) fs.rmSync(dashboardInfoPath(dataDir), { force: true });
}

export function readDashboardInfo(dataDir: string): DashboardInfo | undefined {
  try {
    const info = JSON.parse(fs.readFileSync(dashboardInfoPath(dataDir), "utf8")) as DashboardInfo;
    return typeof info.url === "string" && typeof info.token === "string" ? info : undefined;
  } catch {
    return undefined;
  }
}

/**
 * POST over node:http rather than fetch: fetch's 5-minute header timeout would cut off long
 * delegations, while this has no client-side deadline beyond the caller's own.
 */
function post(info: DashboardInfo, pathname: string, body: unknown): Promise<unknown> {
  const url = new URL(pathname, info.url);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          "x-swarm-token": info.token,
          origin: info.url,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          let data: { error?: string; code?: string; result?: unknown };
          try {
            data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof data;
          } catch {
            reject(new SwarmError(`Dashboard returned HTTP ${response.statusCode}`, "http", true));
            return;
          }
          if ((response.statusCode ?? 500) >= 400)
            reject(new SwarmError(data.error ?? "Dashboard request failed", data.code ?? "remote"));
          else resolve(data.result);
        });
        response.on("error", reject);
      },
    );
    request.on("error", (error) =>
      reject(
        new SwarmError(`Swarm daemon unreachable at ${info.url}: ${error.message}`, "http", true),
      ),
    );
    request.end(payload);
  });
}

/** A live dashboard owns the scheduler; MCP processes become thin clients of it. */
export function remoteBackend(info: DashboardInfo): SwarmBackend {
  const call = (method: BackendMethod, args: unknown[]): Promise<unknown> =>
    post(info, "/api/rpc", { method, args });
  const backend = Object.fromEntries(
    BACKEND_METHODS.map((method) => [method, (...args: unknown[]) => call(method, args)]),
  ) as unknown as SwarmBackend;
  // Keep each request short of proxy and server idle limits; loop for longer waits.
  backend.wait = async (jobId: string, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const slice = Math.min(240_000, Math.max(0, deadline - Date.now()));
      const result = (await call("wait", [jobId, slice])) as Awaited<
        ReturnType<Orchestrator["wait"]>
      >;
      if (result.done || result.blocked || Date.now() >= deadline) return result;
    }
  };
  return backend;
}

export async function probeDashboard(info: DashboardInfo): Promise<boolean> {
  try {
    await post(info, "/api/rpc", { method: "jobs", args: [1] });
    return true;
  } catch {
    return false;
  }
}
