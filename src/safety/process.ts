import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SwarmError } from "../errors.js";

const SHIMS = new Set([".cmd", ".bat", ".ps1"]);

export function resolveExecutable(command: string): string {
  if (command.includes("\0")) {
    throw new SwarmError("Executable path contains a null byte", "bad_executable");
  }
  if (command.includes("/") || command.includes("\\") || path.isAbsolute(command)) {
    const resolved = path.resolve(command);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new SwarmError(`Executable not found: ${resolved}`, "missing_executable");
    }
    assertDirectExecutable(resolved);
    return resolved;
  }
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter((dir) => dir.length > 0);
  const extensions = process.platform === "win32" ? [".exe", ".com"] : [""];
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${command}${extension}`);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        assertDirectExecutable(candidate);
        return candidate;
      }
    }
  }
  if (process.platform === "win32") {
    for (const dir of dirs) {
      for (const extension of [".cmd", ".bat", ".ps1"]) {
        const candidate = path.join(dir, `${command}${extension}`);
        if (fs.existsSync(candidate)) {
          throw new SwarmError(
            `Found shell shim ${candidate}. This adapter never sets shell:true. Point command at the real executable (often a sibling .exe).`,
            "shell_shim",
          );
        }
      }
    }
  }
  throw new SwarmError(
    `Executable not found on PATH: ${command}. Install it or set the provider command to an absolute path.`,
    "missing_executable",
  );
}

function assertDirectExecutable(filePath: string): void {
  const extension = path.extname(filePath).toLowerCase();
  if (SHIMS.has(extension)) {
    throw new SwarmError(
      `${filePath} is a shell shim. Configure a real executable so it can be spawned with shell:false.`,
      "shell_shim",
    );
  }
}

export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process has already exited.
    }
  }
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
}

export interface CommandRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
}

export function runCommand(request: CommandRequest): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let truncated = false;
    let settled = false;

    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      reject(error);
    };

    const onAbort = (): void => {
      cancelled = true;
      killProcessTree(child);
    };

    if (request.signal?.aborted) {
      cancelled = true;
      killProcessTree(child);
    } else {
      request.signal?.addEventListener("abort", onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, request.timeoutMs);

    const capture = (current: string, chunk: string): { next: string; overflow: boolean } => {
      const next = current + chunk;
      if (Buffer.byteLength(next) > request.maxBytes) {
        return { next: next.slice(0, request.maxBytes), overflow: true };
      }
      return { next, overflow: false };
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      const captured = capture(stdout, chunk);
      stdout = captured.next;
      if (captured.overflow) {
        truncated = true;
        killProcessTree(child);
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      const captured = capture(stderr, chunk);
      stderr = captured.next;
      if (captured.overflow) {
        truncated = true;
        killProcessTree(child);
      }
    });
    child.on("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        fail(
          new SwarmError(
            `Failed to spawn ${request.command}. Check that the executable exists.`,
            "missing_executable",
          ),
        );
        return;
      }
      fail(new SwarmError(`Failed to spawn ${request.command}: ${error.message}`, "spawn", true));
    });
    child.on("close", (code) => {
      finish({ code, stdout, stderr, timedOut, cancelled, truncated });
    });

    if (request.input !== undefined) {
      child.stdin?.write(request.input);
    }
    child.stdin?.end();
  });
}
