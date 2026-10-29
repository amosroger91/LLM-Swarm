import type { SwarmConfig } from "../config/schema.js";
import { errorMessage } from "../errors.js";
import { allowlistedEnv } from "../safety/redact.js";
import { resolveExecutable, runCommand } from "../safety/process.js";

export interface CheckRunResult {
  ok: boolean;
  summary: string;
}

export type ChecksRunner = (cwd: string) => Promise<CheckRunResult>;

export function createChecksRunner(config: SwarmConfig): ChecksRunner {
  return async (cwd: string) => {
    if (config.checks.length === 0) return { ok: true, summary: "No checks configured." };
    const pieces: string[] = [];
    for (const check of config.checks) {
      try {
        const executable = resolveExecutable(check.command);
        const { env } = allowlistedEnv([]);
        const result = await runCommand({
          command: executable,
          args: check.args,
          cwd,
          env,
          timeoutMs: config.providerTimeoutMs,
          maxBytes: 200_000,
        });
        pieces.push(
          `$ ${check.command} ${check.args.join(" ")} -> ${result.code ?? "null"}\n${result.stdout}\n${result.stderr}`,
        );
        if (result.code !== 0 || result.timedOut || result.cancelled) {
          return { ok: false, summary: pieces.join("\n").slice(0, 8000) };
        }
      } catch (error) {
        pieces.push(`${check.command} failed to start: ${errorMessage(error)}`);
        return { ok: false, summary: pieces.join("\n").slice(0, 8000) };
      }
    }
    return { ok: true, summary: pieces.join("\n").slice(0, 8000) };
  };
}
