import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CliProviderConfig } from "../config/schema.js";
import { SwarmError, errorMessage } from "../errors.js";
import { allowlistedEnv } from "../safety/redact.js";
import { resolveExecutable, runCommand } from "../safety/process.js";
import { parseProviderOutput } from "./parse.js";
import type { AgentProvider, ProviderRequest, ProviderResponse } from "./types.js";

export class CliProvider implements AgentProvider {
  readonly name: string;
  readonly capabilities: CliProviderConfig["capabilities"];
  private readonly executable: string;

  constructor(
    private readonly config: CliProviderConfig,
    private readonly providerName: string,
    private readonly redact: (text: string) => string = (text) => text,
  ) {
    this.name = providerName;
    this.capabilities = config.capabilities;
    try {
      this.executable = resolveExecutable(config.command);
    } catch (error) {
      throw new SwarmError(
        errorMessage(error),
        error instanceof SwarmError ? error.code : "missing_executable",
      );
    }
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const cwd = request.cwd ?? process.cwd();
    const timeoutMs = request.timeoutMs ?? this.config.timeoutMs;
    const transport = this.config.promptTransport;
    const prompt = request.system
      ? `SYSTEM INSTRUCTIONS:\n${request.system}\n\nUSER REQUEST:\n${request.prompt}`
      : request.prompt;
    let promptFile: string | undefined;
    if (transport === "file" || this.config.args.some((arg) => arg.includes("{promptFile}"))) {
      promptFile = path.join(os.tmpdir(), `llm-swarm-prompt-${randomUUID()}.txt`);
      fs.writeFileSync(promptFile, prompt, { encoding: "utf8", mode: 0o600 });
    }
    const args = buildArgs(this.config.args, {
      prompt: transport === "argv" ? prompt : "",
      promptFile,
      cwd,
    });
    const { env, secrets } = allowlistedEnv(this.config.envPass);
    const redact = (text: string) =>
      this.redact(secrets.reduce((out, secret) => out.split(secret).join("[REDACTED]"), text));
    try {
      const result = await runCommand({
        command: this.executable,
        args,
        cwd,
        env,
        input: transport === "stdin" ? prompt : undefined,
        timeoutMs,
        maxBytes: this.config.maxStdoutBytes,
        signal: request.signal,
      });
      if (result.cancelled || request.signal?.aborted) {
        throw new SwarmError(`CLI provider ${this.providerName} was cancelled`, "cancelled");
      }
      if (result.timedOut) {
        throw new SwarmError(
          `CLI provider ${this.providerName} timed out after ${timeoutMs}ms`,
          "timeout",
          true,
        );
      }
      if (result.truncated) {
        throw new SwarmError(
          `CLI provider ${this.providerName} exceeded the output limit of ${this.config.maxStdoutBytes} bytes`,
          "output_limit",
        );
      }
      if (result.code !== 0) {
        throw new SwarmError(
          `CLI provider ${this.providerName} exited ${result.code}: ${redact(result.stderr).slice(0, 2000)}`,
          "exit",
          true,
        );
      }
      const parsed = parseProviderOutput(this.config.outputParser, result.stdout, result.stderr);
      const response: ProviderResponse = {
        text: parsed.text,
        provider: this.providerName,
        model: this.config.command,
      };
      if (parsed.structured !== undefined) response.structured = parsed.structured;
      return response;
    } catch (error) {
      if (error instanceof SwarmError) {
        throw new SwarmError(redact(error.message), error.code, error.retryable);
      }
      throw new SwarmError(redact(errorMessage(error)), "spawn", true);
    } finally {
      if (promptFile) fs.rmSync(promptFile, { force: true });
    }
  }
}

export function buildArgs(
  template: readonly string[],
  values: { prompt: string; promptFile?: string; cwd: string },
): string[] {
  return template.map((part) => {
    if (part === "{prompt}") return values.prompt;
    if (part === "{promptFile}") {
      if (!values.promptFile) {
        throw new SwarmError("Argument {promptFile} requires promptTransport file", "bad_config");
      }
      return values.promptFile;
    }
    if (part === "{cwd}") return values.cwd;
    if (part.includes("{prompt}") || part.includes("{promptFile}") || part.includes("{cwd}")) {
      return part
        .replaceAll("{promptFile}", values.promptFile ?? "")
        .replaceAll("{prompt}", values.prompt)
        .replaceAll("{cwd}", values.cwd);
    }
    return part;
  });
}
