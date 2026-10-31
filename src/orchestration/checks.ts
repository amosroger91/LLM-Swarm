import type { SwarmConfig } from "../config/schema.js";
import { errorMessage } from "../errors.js";
import { allowlistedEnv } from "../safety/redact.js";
import { resolveExecutable, runCommand } from "../safety/process.js";
import { stripVTControlCharacters } from "node:util";

function evidence(text: string): string {
  const clean = stripVTControlCharacters(text);
  return clean.length > 5500
    ? `${clean.slice(0, 1000)}\n[Middle output omitted]\n${clean.slice(-4300)}`
    : clean;
}
function summary(pieces: string[]): string {
  const text = pieces.join("\n");
  return text.length > 7800 ? `[Earlier check output omitted]\n${text.slice(-7700)}` : text;
}

export interface CheckRunResult {
  ok: boolean;
  status?: "passed" | "failed" | "not_run";
  summary: string;
}

export type ChecksRunner = (cwd: string, signal?: AbortSignal) => Promise<CheckRunResult>;
export type TaskChecksRunner = (
  cwd: string,
  checkIndices: number[],
  signal?: AbortSignal,
) => Promise<CheckRunResult>;

export function createChecksRunner(config: SwarmConfig): ChecksRunner {
  const run = createTaskChecksRunner(config);
  return (cwd, signal) =>
    run(
      cwd,
      config.checks.map((_, index) => index),
      signal,
    );
}

/** Commands always come from trusted configuration, never from an agent response. */
export function createTaskChecksRunner(config: SwarmConfig): TaskChecksRunner {
  return async (cwd, checkIndices, signal) => {
    if (
      new Set(checkIndices).size !== checkIndices.length ||
      checkIndices.some((index) => !Number.isInteger(index) || index < 0 || !config.checks[index])
    ) {
      return { ok: false, status: "failed", summary: "Invalid configured check selection." };
    }
    if (checkIndices.length === 0)
      return {
        ok: true,
        status: "not_run",
        summary: "NOT RUN: No checks configured. This is not a passing test result.",
      };
    const pieces: string[] = [];
    for (const index of checkIndices) {
      const check = config.checks[index]!;
      try {
        signal?.throwIfAborted();
        const executable = resolveExecutable(check.command);
        const { env } = allowlistedEnv([]);
        const result = await runCommand({
          command: executable,
          args: check.args,
          cwd,
          env,
          timeoutMs: config.providerTimeoutMs,
          maxBytes: 200_000,
          signal,
        });
        pieces.push(
          `Check ${index}${check.name ? ` (${check.name})` : ""}: $ ${check.command} ${check.args.join(" ")} -> ${result.code ?? "null"}\n${evidence(result.stdout)}\n${evidence(result.stderr)}`,
        );
        if (result.code !== 0 || result.timedOut || result.cancelled || result.truncated) {
          return { ok: false, status: "failed", summary: summary(pieces) };
        }
      } catch (error) {
        pieces.push(`${check.command} failed to start: ${errorMessage(error)}`);
        return { ok: false, status: "failed", summary: summary(pieces) };
      }
    }
    return { ok: true, status: "passed", summary: summary(pieces) };
  };
}
