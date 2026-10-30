import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AgentTool } from "../providers/types.js";
import type { Store } from "../db/store.js";
import type { SwarmConfig } from "../config/schema.js";
import { safeFileTarget } from "../safety/files.js";
import { allowlistedEnv } from "../safety/redact.js";
import { resolveExecutable, runCommand } from "../safety/process.js";

const excluded =
  /(?:^|\/)(?:\.git|\.swarm-data|workspaces|node_modules|dist|coverage|secrets?|credentials?|certs?|\.ssh|\.aws|\.azure|\.npmrc|\.netrc|\.pypirc|\.env[^/]*)(?:\/|$)|(?:secret|credential|token)[^/]*\.(?:json|ya?ml|txt)$|\.(?:pem|key|pfx|p12|crt|db|sqlite)$/i;
const matches = (file: string, area: string): boolean =>
  file === area || file.startsWith(`${area}/`);

/** All operations are bounded and scoped to an assigned checkout. No agent-supplied shell. */
export function workspaceTools(input: {
  root: string;
  ref?: string;
  allowedPaths?: string[];
  readOnly?: boolean;
  store: Store;
  config: SwarmConfig;
  jobId: string;
  taskId?: string;
  sender: string;
  signal: AbortSignal;
}): AgentTool[] {
  const { root, store, config, jobId, signal } = input;
  const readLimit = config.costPolicy === "local_or_free" ? 4000 : 16000;
  const tool = (
    name: string,
    description: string,
    schema: z.ZodObject,
    execute: (args: Record<string, unknown>) => Promise<unknown>,
  ): AgentTool => ({
    name,
    description,
    parameters: z.toJSONSchema(schema) as Record<string, unknown>,
    async execute(args) {
      signal.throwIfAborted();
      const result = await execute(schema.parse(args) as Record<string, unknown>);
      store.addEvent(jobId, "tool.completed", "task", input.taskId ?? null, { name });
      return result;
    },
  });
  const target = (file: string): string => {
    if (excluded.test(file)) throw new Error("Sensitive or generated path is excluded");
    return safeFileTarget(root, file);
  };
  const git = async (args: string[]): Promise<string> => {
    const { env } = allowlistedEnv([]);
    const result = await runCommand({
      command: "git",
      args: ["-c", "core.hooksPath=", ...args],
      cwd: root,
      env,
      signal,
      timeoutMs: 10000,
      maxBytes: 500000,
    });
    if (result.code !== 0 || result.truncated) throw new Error("Cannot read source snapshot");
    return result.stdout;
  };
  const list = async (): Promise<string[]> => {
    if (input.ref)
      return (await git(["ls-tree", "-r", "--name-only", "-z", input.ref]))
        .split("\0")
        .filter((file) => file && !excluded.test(file));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.relative(root, path.join(dir, entry.name)).replaceAll("\\", "/");
        if (excluded.test(file) || entry.isSymbolicLink() || files.length >= 2000) continue;
        if (entry.isDirectory()) walk(path.join(dir, entry.name));
        else files.push(file);
      }
    };
    walk(root);
    return files.sort();
  };
  const read = async (file: string): Promise<string> => {
    const destination = target(file);
    if (input.ref) return await git(["show", `${input.ref}:${file}`]);
    if (fs.statSync(destination).size > 200000)
      throw new Error("File too large; request a smaller source file");
    return fs.readFileSync(destination, "utf8");
  };
  const tools = [
    tool(
      "list_files",
      "List repository source files, optionally by prefix.",
      z.object({ prefix: z.string().default("") }),
      async (args) =>
        (await list()).filter((file) => file.startsWith(args.prefix as string)).slice(0, 200),
    ),
    tool(
      "read_file",
      "Read a source file. Paths are repository-relative. Use nextOffset to read the rest of a long file before replacing it.",
      z.object({
        path: z.string(),
        offset: z.number().int().nonnegative().default(0),
        limit: z.number().int().min(1).max(readLimit).default(readLimit),
      }),
      async (args) => {
        const text = await read(args.path as string);
        const offset = args.offset as number;
        const end = offset + (args.limit as number);
        return {
          path: args.path,
          content: text.slice(offset, end),
          offset,
          nextOffset: end < text.length ? end : null,
          truncated: end < text.length,
        };
      },
    ),
    tool(
      "search_source",
      "Find literal text in up to 100 source files. Use a prefix to narrow results.",
      z.object({ query: z.string().min(1), prefix: z.string().default("") }),
      async (args) => {
        const hits: unknown[] = [];
        for (const file of (await list())
          .filter((file) => file.startsWith(args.prefix as string))
          .slice(0, 100)) {
          try {
            const content = await read(file);
            content.split("\n").forEach((line, index) => {
              if (line.includes(args.query as string) && hits.length < 50)
                hits.push({ path: file, line: index + 1, text: line.slice(0, 300) });
            });
          } catch {
            /* Non-text or unavailable source. */
          }
        }
        return { hits };
      },
    ),
    tool(
      "read_coordination",
      "Read current shared messages and decisions, including resolved answers. Poll between implementation steps.",
      z.object({ decisionId: z.string().optional(), channel: z.string().optional() }),
      async (args) => ({
        messages: store
          .listMessages(jobId, 30)
          .filter((message) => !args.channel || message.channel === args.channel)
          .slice(-10),
        decisions: store
          .listDecisions(jobId)
          .filter((decision) => !args.decisionId || decision.id === args.decisionId),
      }),
    ),
  ];
  if (config.costPolicy === "local_or_free")
    tools.push(
      tool(
        "read_goal",
        "Read the immutable human goal in pages before making product or scope decisions.",
        z.object({
          offset: z.number().int().nonnegative().default(0),
          limit: z.number().int().min(1).max(4000).default(2000),
        }),
        async (args) => {
          const goal = store.humanGoal(jobId),
            offset = args.offset as number,
            end = Math.min(goal.length, offset + (args.limit as number));
          return {
            content: goal.slice(offset, end),
            totalCharacters: goal.length,
            nextOffset: end < goal.length ? end : null,
          };
        },
      ),
    );
  if (input.readOnly) return tools;
  tools.push(
    tool(
      "request_help",
      "Report a blocker with evidence and attempted fixes. Set needsHuman for missing requirements, credentials, permissions, or unavailable services. Never bypass checks or file ownership.",
      z.object({
        category: z.enum(["interface", "checks", "dependency", "environment", "requirements"]),
        summary: z.string().min(1).max(1000),
        details: z.string().min(1).max(4000),
        attempted: z.array(z.string().max(1000)).max(10),
        needsHuman: z.boolean(),
      }),
      async (args) => {
        const blocker = store.reportBlocker({
          jobId,
          taskId: input.taskId,
          category: args.category as string,
          summary: args.summary as string,
          details: args.details as string,
          attempted: (args.attempted as string[]).join("; "),
          nextAction: args.needsHuman
            ? "Await caller guidance"
            : "Try a different bounded approach or return blocked for coordinator diagnosis",
        });
        if (args.needsHuman) {
          const decision = store.createDecision({
            jobId,
            question: args.summary as string,
            context: args.details as string,
            options: ["retry_with_guidance", "stop_job"],
            proposer: input.sender,
            policy: "owner",
            quorum: 1,
            ownerRole: "human",
            blocking: true,
          });
          store.updateBlocker(blocker.id, {
            status: "waiting",
            nextAction: `Answer decision ${decision.id} or cancel the job`,
            decisionId: decision.id,
          });
        }
        return store.listBlockers(jobId).find((item) => item.id === blocker.id);
      },
    ),
    tool(
      "write_file",
      "Create or replace a file in your assigned file areas. Read existing files before replacing them.",
      z.object({ path: z.string(), content: z.string().max(100000) }),
      async (args) => {
        const file = args.path as string;
        const destination = target(file);
        if (input.allowedPaths?.length && !input.allowedPaths.some((area) => matches(file, area)))
          throw new Error(`Unowned file: ${file}`);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, args.content as string, "utf8");
        store.addEvent(jobId, "tool.file_written", "task", input.taskId ?? null, { path: file });
        return { written: file };
      },
    ),
    tool(
      "run_check",
      "Run one configured verification command by zero-based index. No arbitrary commands.",
      z.object({ index: z.number().int().nonnegative() }),
      async (args) => {
        const check = config.checks[args.index as number];
        if (!check) throw new Error("No configured check at that index");
        const { env } = allowlistedEnv([]);
        return runCommand({
          command: resolveExecutable(check.command),
          args: check.args,
          cwd: root,
          env,
          signal,
          timeoutMs: config.providerTimeoutMs,
          maxBytes: 12000,
        });
      },
    ),
    tool(
      "post_message",
      "Share an interface contract, discovery, or progress with other running workers immediately.",
      z.object({ content: z.string().min(1).max(8000) }),
      async (args) =>
        store.postMessage({
          jobId,
          sender: input.sender,
          role: "worker",
          taskId: input.taskId,
          messageType: "handoff",
          content: args.content as string,
          maxChars: config.maxMessageChars,
        }),
    ),
    tool(
      "ask_decision",
      "Ask a question that must be answered before more tasks are launched. Only ask for genuinely missing requirements.",
      z.object({
        question: z.string().min(1).max(1000),
        options: z.array(z.string().min(1).max(200)).min(2).max(8),
      }),
      async (args) =>
        store.createDecision({
          jobId,
          question: args.question as string,
          options: args.options as string[],
          proposer: input.sender,
          policy: config.decision.policy,
          quorum: config.decision.quorum,
          ownerRole: config.decision.ownerRole,
          blocking: true,
        }),
    ),
  );
  return tools;
}
