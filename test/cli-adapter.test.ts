import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CliProviderConfig } from "../src/config/schema.js";
import { SwarmError } from "../src/errors.js";
import { CliProvider, buildArgs } from "../src/providers/cli.js";
import { parseProviderOutput } from "../src/providers/parse.js";
import { resolveExecutable } from "../src/safety/process.js";
import { removeTemp, tempDir, waitUntil } from "./helpers.js";

const dirs: string[] = [];
const pids: number[] = [];

afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid);
    } catch {
      // Already gone.
    }
  }
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) removeTemp(dir);
  }
  delete process.env.SECRET_LEAK;
  delete process.env.API_TOKEN;
});

const capabilities = {
  structuredOutput: false,
  toolCalling: false,
  streaming: false,
  nonInteractive: true,
};

function config(
  command: string,
  args: string[],
  patch: Partial<CliProviderConfig> = {},
): CliProviderConfig {
  return {
    type: "cli",
    command,
    args,
    promptTransport: "argv",
    outputParser: "text",
    timeoutMs: 2_000,
    capabilities,
    envPass: [],
    maxStdoutBytes: 1_000_000,
    documentedStatus: "unverified",
    notes: "",
    ...patch,
  };
}

function writeScript(dir: string): string {
  const file = path.join(dir, "fake-agent.js");
  fs.writeFileSync(
    file,
    `const fs = require("node:fs");
const mode = process.argv[2];
const out = process.argv[3];
if (mode === "args") {
  fs.writeFileSync(out, JSON.stringify({
    argv: process.argv.slice(4),
    secret: process.env.SECRET_LEAK || null,
    passed: process.env.SWARM_TEST_TOKEN || null,
    path: Boolean(process.env.PATH)
  }));
  process.stdout.write("ok");
} else if (mode === "sleep") {
  fs.writeFileSync(out, String(process.pid));
  setInterval(() => {}, 1000);
} else if (mode === "flood") {
  process.stdout.write("x".repeat(200000));
} else if (mode === "fail") {
  process.stderr.write(process.env.API_TOKEN || "no-token");
  process.exit(2);
} else if (mode === "stdin") {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { data += chunk; });
  process.stdin.on("end", () => fs.writeFileSync(out, data));
} else if (mode === "file") {
  const promptFile = process.argv[4];
  fs.writeFileSync(out, JSON.stringify({ text: fs.readFileSync(promptFile, "utf8"), file: promptFile }));
  process.stdout.write("ok");
} else {
  process.stderr.write("unknown mode");
  process.exit(3);
}
`,
    "utf8",
  );
  return file;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("CLI provider", () => {
  it.each(["argv", "stdin", "file"] as const)(
    "delivers system instructions through %s",
    async (transport) => {
      const dir = tempDir("swarm-cli-system-");
      dirs.push(dir);
      const script = writeScript(dir);
      const out = path.join(dir, "recorded.txt");
      const args =
        transport === "argv"
          ? [script, "args", out, "{prompt}"]
          : transport === "file"
            ? [script, "file", out, "{promptFile}"]
            : [script, "stdin", out];
      const provider = new CliProvider(
        config(process.execPath, args, { promptTransport: transport }),
        "echo",
      );
      await provider.complete({
        prompt: "user-marker",
        system: "system-contract-marker",
        cwd: dir,
      });
      const recorded = fs.readFileSync(out, "utf8");
      expect(recorded).toContain("system-contract-marker");
      expect(recorded).toContain("user-marker");
      expect(recorded.indexOf("system-contract-marker")).toBeLessThan(
        recorded.indexOf("user-marker"),
      );
    },
  );
  it("passes one argv element, drops secrets, and keeps PATH", async () => {
    const dir = tempDir("swarm-cli-");
    dirs.push(dir);
    const script = writeScript(dir);
    const out = path.join(dir, "out.json");
    process.env.SECRET_LEAK = "super-secret-leak-value";
    process.env.SWARM_TEST_TOKEN = "token-value-123456";
    const provider = new CliProvider(
      config(process.execPath, [script, "args", out, "{prompt}"], {
        envPass: ["SWARM_TEST_TOKEN"],
      }),
      "fake-cli",
    );
    const response = await provider.complete({ prompt: "hello & world | >", cwd: dir });
    expect(response.text.trim()).toBe("ok");
    const recorded = JSON.parse(fs.readFileSync(out, "utf8")) as {
      argv: string[];
      secret: string | null;
      passed: string | null;
      path: boolean;
    };
    expect(recorded.argv).toEqual(["hello & world | >"]);
    expect(recorded.secret).toBeNull();
    expect(recorded.passed).toBe("token-value-123456");
    expect(recorded.path).toBe(true);
  });

  it("reads stdin and a prompt file, then deletes the prompt file", async () => {
    const dir = tempDir("swarm-cli-io-");
    dirs.push(dir);
    const script = writeScript(dir);
    const stdinOut = path.join(dir, "stdin.txt");
    const stdinProvider = new CliProvider(
      config(process.execPath, [script, "stdin", stdinOut], { promptTransport: "stdin" }),
      "fake-cli",
    );
    await stdinProvider.complete({ prompt: "hello & world | >", cwd: dir });
    expect(fs.readFileSync(stdinOut, "utf8")).toBe("hello & world | >");

    const fileOut = path.join(dir, "file.json");
    const fileProvider = new CliProvider(
      config(process.execPath, [script, "file", fileOut, "{promptFile}"], {
        promptTransport: "file",
      }),
      "fake-cli",
    );
    await fileProvider.complete({ prompt: "from-file", cwd: dir });
    const recorded = JSON.parse(fs.readFileSync(fileOut, "utf8")) as { text: string; file: string };
    expect(recorded.text).toBe("from-file");
    expect(fs.existsSync(recorded.file)).toBe(false);
  });

  it("times out, cancels the process tree, and reports a non-zero exit without the secret", async () => {
    const dir = tempDir("swarm-cli-life-");
    dirs.push(dir);
    const script = writeScript(dir);
    const pidFile = path.join(dir, "pid.txt");
    const sleeper = new CliProvider(
      config(process.execPath, [script, "sleep", pidFile], { timeoutMs: 200 }),
      "fake-cli",
    );
    await expect(sleeper.complete({ prompt: "sleep", cwd: dir })).rejects.toMatchObject({
      code: "timeout",
      retryable: true,
    });
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    pids.push(pid);
    await waitUntil(() => !alive(pid), "child exit", 2_000);
    expect(alive(pid)).toBe(false);

    const cancelPid = path.join(dir, "cancel-pid.txt");
    const controller = new AbortController();
    const cancellable = new CliProvider(
      config(process.execPath, [script, "sleep", cancelPid], { timeoutMs: 10_000 }),
      "fake-cli",
    );
    const pending = cancellable.complete({ prompt: "sleep", cwd: dir, signal: controller.signal });
    await waitUntil(() => fs.existsSync(cancelPid), "pid file");
    const second = Number(fs.readFileSync(cancelPid, "utf8"));
    pids.push(second);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    await waitUntil(() => !alive(second), "cancelled child", 2_000);

    const token = "ghp-secretvalue123456";
    process.env.API_TOKEN = token;
    const failing = new CliProvider(
      config(process.execPath, [script, "fail", path.join(dir, "unused")], {
        envPass: ["API_TOKEN"],
      }),
      "fake-cli",
    );
    try {
      await failing.complete({ prompt: "fail", cwd: dir });
      throw new Error("expected a non-zero exit");
    } catch (error) {
      expect(error).toBeInstanceOf(SwarmError);
      const message = error instanceof Error ? error.message : "";
      expect(message).toContain("exited 2");
      expect(message).not.toContain(token);
      expect(message).toContain("[REDACTED]");
    }
  });

  it("stops a process that exceeds the output limit", async () => {
    const dir = tempDir("swarm-cli-flood-");
    dirs.push(dir);
    const script = writeScript(dir);
    const provider = new CliProvider(
      config(process.execPath, [script, "flood", path.join(dir, "unused")], {
        maxStdoutBytes: 1024,
      }),
      "fake-cli",
    );
    await expect(provider.complete({ prompt: "flood", cwd: dir })).rejects.toMatchObject({
      code: "output_limit",
    });
  });

  it("rejects a missing executable and a Windows shell shim", () => {
    const dir = tempDir("swarm-cli-missing-");
    dirs.push(dir);
    expect(() => new CliProvider(config(path.join(dir, "missing.exe"), []), "fake-cli")).toThrow(
      /not found/i,
    );
    const shim = path.join(dir, "agent.cmd");
    fs.writeFileSync(shim, "@echo off\r\n", "utf8");
    expect(() => resolveExecutable(shim)).toThrow(/shell shim/i);
    expect(() => new CliProvider(config(shim, []), "fake-cli")).toThrow(SwarmError);
    const ps1 = path.join(dir, "agent.ps1");
    fs.writeFileSync(ps1, "Write-Output hi\r\n", "utf8");
    expect(() => resolveExecutable(ps1)).toThrow(/shell shim/i);
  });

  it("keeps placeholder substitution inside a single argument", () => {
    expect(
      buildArgs(["--prompt", "{prompt}", "{cwd}"], { prompt: "a b", cwd: "C:\\work" }),
    ).toEqual(["--prompt", "a b", "C:\\work"]);
  });

  it("parses the help-checked CLI envelopes without calling the CLIs", () => {
    const grok = parseProviderOutput(
      "grok-json",
      JSON.stringify({ response: '{"summary":"grok"}' }),
      "",
    );
    expect(grok.structured).toEqual({ summary: "grok" });
    const gemini = parseProviderOutput(
      "gemini-json",
      JSON.stringify({ response: "plain gemini text" }),
      "",
    );
    expect(gemini.text).toContain("plain gemini text");
    const events = parseProviderOutput(
      "opencode-events",
      `${JSON.stringify({ part: { text: '{"status":"done"}' } })}\n${JSON.stringify({ part: { text: "tail" } })}\n`,
      "",
    );
    expect(events.text).toContain("done");
    expect(events.text).toContain("tail");
  });
});
