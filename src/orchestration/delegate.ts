import fs from "node:fs";
import path from "node:path";
import type { SwarmConfig } from "../config/schema.js";
import type { Store } from "../db/store.js";
import { SwarmError, errorMessage } from "../errors.js";
import { extractJsonValue } from "../providers/parse.js";
import type { AgentProvider, ProviderResponse } from "../providers/types.js";

export interface DelegateInput {
  task: string;
  /** Directory that file paths and globs resolve against. Files outside it are refused. */
  root: string;
  files?: string[];
  context?: string;
  agent?: string;
  format?: "text" | "json";
  maxOutputChars?: number;
}

export interface DelegateMapInput extends Omit<DelegateInput, "context"> {
  files: string[];
  /** Optional final pass that combines every per-file answer into one. */
  reduce?: string;
}

export interface DelegateResult {
  text: string;
  provider: string;
  model?: string;
  files: number;
  contextChars: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
  failover?: ProviderResponse["failover"];
  truncated: boolean;
}

export interface DelegateDeps {
  config: SwarmConfig;
  store: Store;
  providerFor(agentName: string): AgentProvider;
  signal?: AbortSignal;
}

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "workspaces", ".swarm-data"]);
const GLOB = /[*?[\]{}]/;

export const DELEGATE_SYSTEM = `You are a fast assistant doing one bounded task for a senior engineer who will act on your answer.
Rules:
- Answer only what was asked. No preamble, no restating the task, no closing summary.
- Be dense: bullets, short code blocks, file:line references. Omit pleasantries.
- Use only the provided files and context. If something needed is missing, say exactly what is missing. Never invent code, APIs, or file contents.
- When you write code, write complete, working code for the requested part only.`;

export function delegateAgent(config: SwarmConfig, requested?: string): string {
  const name =
    requested ??
    config.delegate.agent ??
    config.profiles[config.defaultProfile]?.worker ??
    Object.keys(config.agents)[0];
  if (!name || !config.agents[name]) throw new SwarmError(`Unknown agent ${name}`, "bad_config");
  return name;
}

/** Resolve paths, directories, and globs to readable text files under root. */
export function collectFiles(root: string, patterns: readonly string[], limit: number): string[] {
  const base = fs.realpathSync(path.resolve(root));
  const found = new Set<string>();
  const inside = (file: string): boolean => {
    const relative = path.relative(base, file);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  };
  const add = (file: string): void => {
    if (found.size >= limit) {
      throw new SwarmError(
        `More than ${limit} files matched. Narrow the patterns or raise delegate.maxFiles.`,
        "too_many_files",
      );
    }
    found.add(file);
  };
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith("."))
          walk(path.join(dir, entry.name));
      } else if (entry.isFile()) add(path.join(dir, entry.name));
    }
  };
  for (const pattern of patterns) {
    const matches = GLOB.test(pattern)
      ? (fs.globSync(pattern, { cwd: base }) as string[]).map((match) => path.resolve(base, match))
      : [path.resolve(base, pattern)];
    if (!matches.length) throw new SwarmError(`No files match ${pattern}`, "not_found");
    for (const match of matches) {
      let real: string;
      try {
        real = fs.realpathSync(match);
      } catch {
        throw new SwarmError(`File not found: ${pattern}`, "not_found");
      }
      if (!inside(real) && real !== base)
        throw new SwarmError(`${pattern} is outside ${base}`, "path_outside_root");
      const stat = fs.statSync(real);
      if (stat.isDirectory()) walk(real);
      else if (stat.isFile()) add(real);
    }
  }
  return [...found].sort();
}

function readText(file: string): string | undefined {
  const buffer = fs.readFileSync(file);
  if (buffer.subarray(0, 8000).includes(0)) return undefined;
  return buffer.toString("utf8");
}

/** Files with line numbers, so answers can cite file:line. Binary files are listed, not read. */
export function renderFiles(root: string, files: readonly string[]): string {
  const base = fs.realpathSync(path.resolve(root));
  return files
    .map((file) => {
      const name = path.relative(base, file).split(path.sep).join("/");
      const text = readText(file);
      if (text === undefined) return `=== ${name} (binary, not shown) ===`;
      const numbered = text
        .split(/\r?\n/)
        .map((line, index) => `${index + 1}| ${line}`)
        .join("\n");
      return `=== ${name} ===\n${numbered}`;
    })
    .join("\n\n");
}

function clipOutput(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return {
    text: `${text.slice(0, limit)}\n[output clipped at ${limit} chars; ask a narrower question]`,
    truncated: true,
  };
}

async function runOne(
  deps: DelegateDeps,
  agentName: string,
  task: string,
  context: string,
  fileCount: number,
  format: "text" | "json",
  maxOutputChars: number,
): Promise<DelegateResult> {
  const agent = deps.config.agents[agentName]!;
  const provider = deps.providerFor(agentName);
  const prompt = `${context ? `${context}\n\n` : ""}TASK:\n${task}${format === "json" ? "\n\nReturn ONLY a JSON value." : ""}`;
  const started = Date.now();
  const timeout = deps.config.providerTimeoutMs * (provider.maxAttempts ?? 1);
  const signal = deps.signal
    ? AbortSignal.any([deps.signal, AbortSignal.timeout(timeout)])
    : AbortSignal.timeout(timeout);
  const base = {
    agent: agentName,
    promptChars: prompt.length,
    contextChars: context.length,
  };
  try {
    const response = await provider.complete({
      system: agent.systemPrompt ? `${DELEGATE_SYSTEM}\n\n${agent.systemPrompt}` : DELEGATE_SYSTEM,
      prompt,
      signal,
      timeoutMs: deps.config.providerTimeoutMs,
      expectJson: format === "json" && provider.capabilities.structuredOutput,
      metadata: { role: "delegate" },
      maxPromptChars: deps.config.delegate.maxInputChars + 10_000,
    });
    let text = response.text.trim();
    if (format === "json") text = JSON.stringify(response.structured ?? extractJsonValue(text));
    const clipped = clipOutput(text, maxOutputChars);
    const result: DelegateResult = {
      text: clipped.text,
      provider: response.provider,
      model: response.model,
      files: fileCount,
      contextChars: context.length,
      inputTokens: response.usage?.inputTokens,
      outputTokens: response.usage?.outputTokens,
      durationMs: Date.now() - started,
      failover: response.failover,
      truncated: clipped.truncated,
    };
    deps.store.recordDelegation({
      ...base,
      provider: response.provider,
      model: response.model ?? null,
      outputChars: text.length,
      inputTokens: response.usage?.inputTokens ?? null,
      outputTokens: response.usage?.outputTokens ?? null,
      durationMs: result.durationMs,
      failover: response.failover ?? [],
      error: null,
    });
    return result;
  } catch (error) {
    deps.store.recordDelegation({
      ...base,
      provider: null,
      model: null,
      outputChars: 0,
      inputTokens: null,
      outputTokens: null,
      durationMs: Date.now() - started,
      failover: [],
      error: errorMessage(error).slice(0, 2000),
    });
    throw error;
  }
}

export async function delegate(deps: DelegateDeps, input: DelegateInput): Promise<DelegateResult> {
  const agentName = delegateAgent(deps.config, input.agent);
  const files = input.files?.length
    ? collectFiles(input.root, input.files, deps.config.delegate.maxFiles)
    : [];
  const context = [files.length ? renderFiles(input.root, files) : "", input.context ?? ""]
    .filter(Boolean)
    .join("\n\n");
  if (context.length > deps.config.delegate.maxInputChars) {
    throw new SwarmError(
      `Context is ${context.length} chars, above delegate.maxInputChars ${deps.config.delegate.maxInputChars}. Use delegate_map to process files separately, or pass fewer files.`,
      "context_limit",
    );
  }
  return runOne(
    deps,
    agentName,
    input.task,
    context,
    files.length,
    input.format ?? "text",
    input.maxOutputChars ?? deps.config.delegate.maxOutputChars,
  );
}

export interface DelegateMapResult {
  results: Array<{ file: string; ok: boolean; text: string; provider?: string }>;
  reduced?: DelegateResult;
  files: number;
  failed: number;
  contextChars: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export async function delegateMap(
  deps: DelegateDeps,
  input: DelegateMapInput,
): Promise<DelegateMapResult> {
  const started = Date.now();
  const agentName = delegateAgent(deps.config, input.agent);
  const files = collectFiles(input.root, input.files, deps.config.delegate.maxFiles);
  const base = fs.realpathSync(path.resolve(input.root));
  const perFile = Math.max(
    400,
    Math.floor(
      (input.maxOutputChars ?? deps.config.delegate.maxOutputChars) /
        (input.reduce ? 1 : files.length),
    ),
  );
  const results: DelegateMapResult["results"] = new Array(files.length);
  let inputTokens = 0;
  let outputTokens = 0;
  let contextChars = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      const index = next++;
      const file = files[index]!;
      const name = path.relative(base, file).split(path.sep).join("/");
      try {
        const context = renderFiles(input.root, [file]);
        if (context.length > deps.config.delegate.maxInputChars)
          throw new SwarmError(`${name} exceeds delegate.maxInputChars`, "context_limit");
        const result = await runOne(
          deps,
          agentName,
          input.task,
          context,
          1,
          input.format ?? "text",
          perFile,
        );
        inputTokens += result.inputTokens ?? 0;
        outputTokens += result.outputTokens ?? 0;
        contextChars += result.contextChars;
        results[index] = { file: name, ok: true, text: result.text, provider: result.provider };
      } catch (error) {
        if (deps.signal?.aborted) throw error;
        results[index] = { file: name, ok: false, text: errorMessage(error).slice(0, 300) };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(deps.config.delegate.maxConcurrency, files.length) }, worker),
  );
  let reduced: DelegateResult | undefined;
  if (input.reduce) {
    const context = results
      .filter((item) => item.ok)
      .map((item) => `=== ${item.file} ===\n${item.text}`)
      .join("\n\n")
      .slice(0, deps.config.delegate.maxInputChars);
    reduced = await runOne(
      deps,
      agentName,
      input.reduce,
      context,
      files.length,
      input.format ?? "text",
      input.maxOutputChars ?? deps.config.delegate.maxOutputChars,
    );
    inputTokens += reduced.inputTokens ?? 0;
    outputTokens += reduced.outputTokens ?? 0;
  }
  return {
    results,
    reduced,
    files: files.length,
    failed: results.filter((item) => !item.ok).length,
    contextChars,
    inputTokens,
    outputTokens,
    durationMs: Date.now() - started,
  };
}
