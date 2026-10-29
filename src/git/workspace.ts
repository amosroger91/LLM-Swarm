import fs from "node:fs";
import path from "node:path";
import type { GitPolicy } from "../safety/policy.js";
import { assertRemoteAllowed } from "../safety/policy.js";
import { SwarmError, errorMessage } from "../errors.js";
import { allowlistedEnv } from "../safety/redact.js";
import { assertOutsideRepository, resolveExistingDirectory } from "../safety/paths.js";
import { runCommand, type CommandResult } from "../safety/process.js";
import { safeFileTarget, validatedPatchPaths } from "../safety/files.js";

export interface RepoContext {
  root: string;
  baseBranch: string;
  baseCommit: string;
  summary: string;
}

export interface RunWorkspace {
  path: string;
  branch: string;
  baseCommit: string;
}

export interface IntegrationResult {
  ok: boolean;
  branch: string;
  path: string;
  headCommit: string | null;
  conflicts: string[];
  diff: string;
  error?: string;
}

export interface WorkspacePort {
  assertRepo(repoPath: string, baseBranch?: string): Promise<RepoContext>;
  createRunWorkspace(input: {
    repoRoot: string;
    dataDir: string;
    jobId: string;
    stableId: string;
    attempt: number;
    baseCommit: string;
  }): Promise<RunWorkspace>;
  finalizeRun(input: {
    repoRoot: string;
    workspace: RunWorkspace;
    message: string;
    patch?: string;
    dropPaths?: string[];
  }): Promise<{ headCommit: string | null; changedFiles: string[] }>;
  commitForBranch(repoPath: string, branch: string): Promise<string | null>;
  integrate(input: {
    repoRoot: string;
    dataDir: string;
    jobId: string;
    baseCommit: string;
    branches: Array<{ branch: string; label: string }>;
    maxDiffChars: number;
  }): Promise<IntegrationResult>;
  cleanup(input: {
    repoRoot: string;
    worktrees: Array<{ path: string; branch: string; preserve: boolean }>;
  }): Promise<void>;
}

export class GitWorkspace implements WorkspacePort {
  constructor(
    private readonly options: {
      authorName: string;
      authorEmail: string;
      timeoutMs: number;
      policy: GitPolicy;
      maxContextChars: number;
    },
  ) {}

  async assertRepo(repoPath: string, baseBranch?: string): Promise<RepoContext> {
    const root = resolveExistingDirectory(repoPath);
    const inside = await this.git(root, ["rev-parse", "--is-inside-work-tree"]);
    if (inside.code !== 0 || inside.stdout.trim() !== "true") {
      throw new SwarmError(`Not a git repository: ${root}`, "bad_repo");
    }
    const toplevel = await this.git(root, ["rev-parse", "--show-toplevel"]);
    if (toplevel.code !== 0) {
      throw new SwarmError(`Cannot resolve git root for ${root}`, "bad_repo");
    }
    const realTop = fs.realpathSync(toplevel.stdout.trim());
    if (realTop !== root) {
      throw new SwarmError(`repo_path must be the repository root (${realTop})`, "bad_repo");
    }
    const branch = await this.resolveBranch(root, baseBranch);
    const commit = await this.git(root, ["rev-parse", branch]);
    if (commit.code !== 0 || !commit.stdout.trim()) {
      throw new SwarmError(`Cannot resolve ${branch}`, "bad_branch");
    }
    const summary = await this.collectSummary(root, branch);
    return { root, baseBranch: branch, baseCommit: commit.stdout.trim(), summary };
  }

  async createRunWorkspace(input: {
    repoRoot: string;
    dataDir: string;
    jobId: string;
    stableId: string;
    attempt: number;
    baseCommit: string;
  }): Promise<RunWorkspace> {
    assertOutsideRepository(input.repoRoot, input.dataDir);
    const branch = taskBranch(input.jobId, input.stableId, input.attempt);
    const workspacePath = path.join(
      input.dataDir,
      "worktrees",
      input.jobId,
      input.stableId,
      String(input.attempt),
    );
    fs.mkdirSync(path.dirname(workspacePath), { recursive: true });
    const created = await this.git(input.repoRoot, [
      "worktree",
      "add",
      "-b",
      branch,
      workspacePath,
      input.baseCommit,
    ]);
    if (created.code !== 0) {
      throw new SwarmError(
        `git worktree add failed for ${branch}: ${created.stderr.trim() || created.stdout.trim()}`,
        "git",
        true,
      );
    }
    return { path: workspacePath, branch, baseCommit: input.baseCommit };
  }

  async commitForBranch(repoPath: string, branch: string): Promise<string | null> {
    validateRef(branch);
    const root = resolveExistingDirectory(repoPath);
    const result = await this.git(root, ["rev-parse", "--verify", "--quiet", branch]);
    if (result.code !== 0) return null;
    const commit = result.stdout.trim();
    return commit || null;
  }

  async finalizeRun(input: {
    repoRoot: string;
    workspace: RunWorkspace;
    message: string;
    patch?: string;
    dropPaths?: string[];
  }): Promise<{ headCommit: string | null; changedFiles: string[] }> {
    const patch = input.patch ? normalizePatch(input.patch) : undefined;
    if (patch) {
      for (const file of validatedPatchPaths(patch)) safeFileTarget(input.workspace.path, file);
    }
    const applyPatch = patch ? materializeNewFiles(input.workspace.path, patch) : undefined;
    if (applyPatch && applyPatch.trim()) {
      assertSafePatch(applyPatch);
      const check = await this.git(
        input.workspace.path,
        ["apply", "--check", "--whitespace=nowarn"],
        applyPatch,
      );
      if (check.code !== 0) {
        throw new SwarmError(`git apply --check failed: ${check.stderr.trim()}`, "bad_patch", true);
      }
      const applied = await this.git(
        input.workspace.path,
        ["apply", "--whitespace=nowarn"],
        applyPatch,
      );
      if (applied.code !== 0) {
        throw new SwarmError(`git apply failed: ${applied.stderr.trim()}`, "bad_patch", true);
      }
    }
    const status = await this.git(input.workspace.path, ["status", "--porcelain"]);
    if (status.code !== 0) {
      throw new SwarmError(`git status failed: ${status.stderr.trim()}`, "git", true);
    }
    const changedFiles = porcelainFiles(status.stdout);
    for (const file of changedFiles) {
      if (file.split(/[\\/]/).includes("..") || path.isAbsolute(file)) {
        await this.git(input.workspace.path, ["reset", "--hard", "HEAD"]);
        await this.git(input.workspace.path, ["clean", "-fd"]);
        throw new SwarmError(`Refusing change outside the worktree: ${file}`, "unsafe_path");
      }
    }
    const dropped = await this.dropOwnedByOthers(input.workspace.path, changedFiles, input.dropPaths ?? []);
    const remainingStatus = dropped.length
      ? await this.git(input.workspace.path, ["status", "--porcelain"])
      : status;
    if (remainingStatus.code !== 0) {
      throw new SwarmError(`git status failed: ${remainingStatus.stderr.trim()}`, "git", true);
    }
    const remaining = dropped.length ? porcelainFiles(remainingStatus.stdout) : changedFiles;
    if (remaining.length === 0) {
      const detail = dropped.length
        ? `The only changes were files owned by other tasks (${dropped.join(", ")}). Return a diff that creates this task's own files.`
        : "No files changed. Return status done and a unified diff that creates or edits the required files. Every added line must start with +.";
      throw new SwarmError(detail, "no_change", true);
    }
    const add = await this.git(input.workspace.path, ["add", "--all"]);
    if (add.code !== 0) throw new SwarmError(`git add failed: ${add.stderr.trim()}`, "git", true);
    const commit = await this.git(input.workspace.path, ["commit", "-m", input.message]);
    if (commit.code !== 0)
      throw new SwarmError(`git commit failed: ${commit.stderr.trim()}`, "git", true);
    const head = await this.git(input.workspace.path, ["rev-parse", "HEAD"]);
    if (head.code !== 0) throw new SwarmError("Cannot read worktree HEAD", "git", true);
    return { headCommit: head.stdout.trim(), changedFiles: remaining };
  }

  private async dropOwnedByOthers(
    workspacePath: string,
    changedFiles: string[],
    dropPaths: string[],
  ): Promise<string[]> {
    if (dropPaths.length === 0) return [];
    const dropped: string[] = [];
    for (const file of changedFiles) {
      if (!dropPaths.some((area) => pathMatchesArea(file, area))) continue;
      dropped.push(file);
      const tracked = await this.git(workspacePath, ["cat-file", "-e", `HEAD:${file}`]);
      if (tracked.code === 0) {
        const restored = await this.git(workspacePath, ["checkout", "HEAD", "--", file]);
        if (restored.code !== 0) {
          throw new SwarmError(`Cannot restore ${file}: ${restored.stderr.trim()}`, "git", true);
        }
      } else {
        fs.rmSync(path.join(workspacePath, file), { recursive: true, force: true });
      }
    }
    return dropped;
  }

  async integrate(input: {
    repoRoot: string;
    dataDir: string;
    jobId: string;
    baseCommit: string;
    branches: Array<{ branch: string; label: string }>;
    maxDiffChars: number;
  }): Promise<IntegrationResult> {
    assertOutsideRepository(input.repoRoot, input.dataDir);
    const branch = integrationBranch(input.jobId);
    const workspacePath = path.join(input.dataDir, "worktrees", input.jobId, "_integration");
    await this.git(input.repoRoot, ["worktree", "remove", "--force", workspacePath]);
    await this.git(input.repoRoot, ["branch", "-D", branch]);
    fs.rmSync(workspacePath, { recursive: true, force: true });
    const created = await this.git(input.repoRoot, [
      "worktree",
      "add",
      "-b",
      branch,
      workspacePath,
      input.baseCommit,
    ]);
    if (created.code !== 0) {
      return {
        ok: false,
        branch,
        path: workspacePath,
        headCommit: null,
        conflicts: [],
        diff: "",
        error: `Cannot create integration worktree: ${created.stderr.trim() || created.stdout.trim()}`,
      };
    }
    const conflicts: string[] = [];
    for (const item of input.branches) {
      let merge = await this.git(workspacePath, ["merge", "--no-ff", "--no-edit", item.branch]);
      if (merge.code !== 0 && item.label.startsWith("revision-")) {
        await this.git(workspacePath, ["merge", "--abort"]);
        merge = await this.git(workspacePath, [
          "merge",
          "--no-ff",
          "--no-edit",
          "-X",
          "theirs",
          item.branch,
        ]);
      }
      if (merge.code !== 0) {
        await this.git(workspacePath, ["merge", "--abort"]);
        conflicts.push(item.label);
        return {
          ok: false,
          branch,
          path: workspacePath,
          headCommit: null,
          conflicts,
          diff: "",
          error: `Merge conflict integrating ${item.label} (${item.branch}). Neither side was overwritten.`,
        };
      }
    }
    const head = await this.git(workspacePath, ["rev-parse", "HEAD"]);
    const diff = await this.git(workspacePath, ["diff", "--stat", `${input.baseCommit}..HEAD`]);
    const full = await this.git(workspacePath, ["diff", `${input.baseCommit}..HEAD`]);
    const text = `${diff.stdout}\n${full.stdout}`.slice(0, input.maxDiffChars);
    return {
      ok: true,
      branch,
      path: workspacePath,
      headCommit: head.stdout.trim(),
      conflicts: [],
      diff: text,
    };
  }

  async cleanup(input: {
    repoRoot: string;
    worktrees: Array<{ path: string; branch: string; preserve: boolean }>;
  }): Promise<void> {
    for (const worktree of input.worktrees) {
      if (worktree.preserve) continue;
      await this.git(input.repoRoot, ["worktree", "remove", "--force", worktree.path]);
      await this.git(input.repoRoot, ["branch", "-D", worktree.branch]);
      fs.rmSync(worktree.path, { recursive: true, force: true });
    }
  }

  refuseRemote(action: "push" | "merge-to-base" | "remote-pr"): void {
    assertRemoteAllowed(this.options.policy, action);
  }

  private async resolveBranch(root: string, requested?: string): Promise<string> {
    if (requested) {
      validateRef(requested);
      const verify = await this.git(root, [
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/heads/${requested}`,
      ]);
      if (verify.code !== 0) {
        throw new SwarmError(`Branch ${requested} does not exist in ${root}`, "bad_branch");
      }
      return requested;
    }
    const current = await this.git(root, ["branch", "--show-current"]);
    const name = current.stdout.trim();
    if (!name) {
      throw new SwarmError("The repository HEAD is detached. Pass base_branch.", "bad_branch");
    }
    validateRef(name);
    return name;
  }

  private async collectSummary(root: string, branch: string): Promise<string> {
    const parts: string[] = [`Repository: ${root}`, `Base branch: ${branch}`];
    const log = await this.git(root, ["log", "-8", "--oneline", branch]);
    if (log.code === 0 && log.stdout.trim()) parts.push(`Recent commits:\n${log.stdout.trim()}`);
    parts.push("Top of tree:");
    parts.push(listTree(root, 2, 80).join("\n"));
    const readme = readLimited(path.join(root, "README.md"), 4000);
    if (readme) parts.push(`README.md:\n${readme}`);
    const pkgPath = path.join(root, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as unknown;
        if (raw && typeof raw === "object") {
          const record = raw as Record<string, unknown>;
          const scripts =
            record.scripts && typeof record.scripts === "object" ? Object.keys(record.scripts) : [];
          parts.push(
            `package.json: name=${String(record.name ?? "")} description=${String(record.description ?? "")} scripts=${scripts.join(",")}`,
          );
        }
      } catch {
        parts.push("package.json could not be parsed");
      }
    }
    return parts.join("\n\n").slice(0, this.options.maxContextChars);
  }

  private async git(cwd: string, args: string[], input?: string): Promise<CommandResult> {
    if (args.some((arg) => arg === "push" || arg.startsWith("push"))) {
      this.refuseRemote("push");
    }
    const { env } = allowlistedEnv([]);
    env.GIT_AUTHOR_NAME = this.options.authorName;
    env.GIT_AUTHOR_EMAIL = this.options.authorEmail;
    env.GIT_COMMITTER_NAME = this.options.authorName;
    env.GIT_COMMITTER_EMAIL = this.options.authorEmail;
    try {
      return await runCommand({
        command: "git",
        args,
        cwd,
        env,
        input,
        timeoutMs: this.options.timeoutMs,
        maxBytes: 2_000_000,
      });
    } catch (error) {
      throw new SwarmError(`git failed: ${errorMessage(error)}`, "git", true);
    }
  }
}

export function taskBranch(jobId: string, stableId: string, attempt: number): string {
  const safe = stableId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40);
  return `swarm/${shortId(jobId)}/${safe}/${attempt}`;
}

export function integrationBranch(jobId: string): string {
  return `swarm/${shortId(jobId)}/integration`;
}

function shortId(jobId: string): string {
  return jobId.replace(/-/g, "").slice(0, 8);
}

function validateRef(name: string): void {
  if (
    !/^[A-Za-z0-9._/-]{1,200}$/.test(name) ||
    name.startsWith("-") ||
    name.includes("..") ||
    name.includes("@{") ||
    name.endsWith("/") ||
    name.includes("//")
  ) {
    throw new SwarmError(`Unsafe git ref: ${name}`, "bad_branch");
  }
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function isDiffBodyLine(line: string): boolean {
  return (
    line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") || line.startsWith("\\")
  );
}

function hunkCounts(body: string[]): { oldCount: number; newCount: number } {
  let oldCount = 0;
  let newCount = 0;
  for (const line of body) {
    if (line.startsWith("\\")) continue;
    if (line.startsWith("+")) newCount += 1;
    else if (line.startsWith("-")) oldCount += 1;
    else if (line.startsWith(" ")) {
      oldCount += 1;
      newCount += 1;
    }
  }
  return { oldCount, newCount };
}

/** Models often emit the file text under a diff header and forget the '+' prefix or the hunk count. */
export function repairPatch(patch: string): string {
  const normalized = patch.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const lines = normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n")
    : normalized.split("\n");
  const out: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const hunk = HUNK_HEADER.exec(line);
    if (!hunk) {
      out.push(line);
      index += 1;
      continue;
    }
    const body: string[] = [];
    let next = index + 1;
    while (next < lines.length) {
      const candidate = lines[next] ?? "";
      if (candidate.startsWith("diff --git ") || HUNK_HEADER.test(candidate)) break;
      body.push(candidate);
      next += 1;
    }
    const broken = body.some((entry) => !isDiffBodyLine(entry));
    const fixed = broken
      ? body.map((entry) => (isDiffBodyLine(entry) ? entry : `+${entry}`))
      : body;
    const counts = hunkCounts(fixed);
    const declaredOld = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const declaredNew = hunk[4] === undefined ? 1 : Number(hunk[4]);
    if (!broken && counts.oldCount === declaredOld && counts.newCount === declaredNew) {
      out.push(line, ...body);
    } else {
      const oldStart = counts.oldCount === 0 ? "0" : hunk[1];
      const newStart = counts.newCount === 0 ? "0" : counts.oldCount === 0 ? "1" : hunk[3];
      out.push(
        `@@ -${oldStart},${counts.oldCount} +${newStart},${counts.newCount} @@${hunk[5] ?? ""}`,
      );
      out.push(...fixed);
    }
    index = next;
  }
  return `${out.join("\n")}\n`;
}

export function normalizePatch(patch: string): string {
  let text = patch.trim();
  const fenced = /^```(?:diff|patch)?\s*\n?([\s\S]*?)\n?```$/.exec(text);
  if (fenced?.[1]) text = fenced[1].trim();
  const start = text.indexOf("diff --git ");
  if (start > 0) text = text.slice(start);
  return repairPatch(text.endsWith("\n") ? text : `${text}\n`);
}

export function assertSafePatch(patch: string): void {
  validatedPatchPaths(patch);
}

/** New-file diffs are written directly so an existing file does not make git apply fail. */
export function materializeNewFiles(workspacePath: string, patch: string): string {
  // Validate the complete patch before the first filesystem mutation.
  for (const file of validatedPatchPaths(patch)) safeFileTarget(workspacePath, file);
  const sections = patch.split(/(?=^diff --git )/m).filter((section) => section.trim());
  const rest: string[] = [];
  for (const section of sections) {
    if (!isNewFileSection(section)) {
      rest.push(section);
      continue;
    }
    const filePath = newFilePath(section);
    if (!filePath) {
      rest.push(section);
      continue;
    }
    assertSafePatch(section);
    const target = safeFileTarget(workspacePath, filePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, newFileContent(section), "utf8");
  }
  return rest.join("");
}

function isNewFileSection(section: string): boolean {
  return /^new file mode /m.test(section) || /^--- \/dev\/null$/m.test(section);
}

function newFilePath(section: string): string | null {
  const match = /^diff --git a\/(\S+) b\/(\S+)/m.exec(section);
  const raw = match?.[2] ?? match?.[1];
  if (!raw) return null;
  return raw.replaceAll("\\", "/").replace(/^\.\//, "");
}

function newFileContent(section: string): string {
  const lines = section.split("\n");
  const body: string[] = [];
  let inHunk = false;
  let newline = true;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("\\")) {
      newline = false;
      continue;
    }
    if (line.startsWith("-")) continue;
    if (line.startsWith("+") || line.startsWith(" ")) body.push(line.slice(1));
    else if (line.length > 0) body.push(line);
  }
  if (body.length === 0) return "";
  const content = body.join("\n");
  return newline ? `${content}\n` : content;
}

export function pathMatchesArea(file: string, area: string): boolean {
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
  const key = area.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase();
  if (!key) return false;
  return normalized === key || normalized.startsWith(`${key}/`);
}

function porcelainFiles(porcelain: string): string[] {
  const files: string[] = [];
  for (const line of porcelain.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const file = line.slice(3).trim();
    const renamed = file.includes(" -> ") ? file.split(" -> ").pop() : file;
    if (renamed) files.push(renamed.trim());
  }
  return files;
}

function listTree(root: string, depth: number, maxEntries: number): string[] {
  const skip = new Set([".git", "node_modules", "dist", ".swarm-data", "coverage"]);
  const lines: string[] = [];
  const walk = (dir: string, remaining: number, prefix: string): void => {
    if (remaining < 0 || lines.length >= maxEntries) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (lines.length >= maxEntries) return;
      if (skip.has(entry.name)) continue;
      const display = `${prefix}${entry.name}${entry.isDirectory() ? "/" : ""}`;
      lines.push(display);
      if (entry.isDirectory()) walk(path.join(dir, entry.name), remaining - 1, `${display}`);
    }
  };
  walk(root, depth, "");
  return lines;
}

function readLimited(filePath: string, maxChars: number): string | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return fs.readFileSync(filePath, "utf8").slice(0, maxChars);
  } catch {
    return null;
  }
}

export class MemoryWorkspace implements WorkspacePort {
  readonly roots = new Map<string, RepoContext>();

  async assertRepo(repoPath: string, baseBranch?: string): Promise<RepoContext> {
    const root = resolveExistingDirectory(repoPath);
    const context: RepoContext = {
      root,
      baseBranch: baseBranch ?? "main",
      baseCommit: "memory-base",
      summary: `Memory repository ${root}`,
    };
    this.roots.set(root, context);
    return context;
  }

  async createRunWorkspace(input: {
    repoRoot: string;
    dataDir: string;
    jobId: string;
    stableId: string;
    attempt: number;
    baseCommit: string;
  }): Promise<RunWorkspace> {
    const workspacePath = path.join(
      input.dataDir,
      "worktrees",
      input.jobId,
      input.stableId,
      String(input.attempt),
    );
    fs.mkdirSync(workspacePath, { recursive: true });
    return {
      path: workspacePath,
      branch: taskBranch(input.jobId, input.stableId, input.attempt),
      baseCommit: input.baseCommit,
    };
  }

  async commitForBranch(): Promise<string | null> {
    return "memory-integration";
  }

  async finalizeRun(input: {
    repoRoot: string;
    workspace: RunWorkspace;
    message: string;
    patch?: string;
    dropPaths?: string[];
  }): Promise<{ headCommit: string | null; changedFiles: string[] }> {
    if (input.patch) {
      assertSafePatch(input.patch);
      fs.writeFileSync(path.join(input.workspace.path, "applied.patch"), input.patch, "utf8");
    }
    let files = fs.readdirSync(input.workspace.path);
    for (const file of files) {
      if ((input.dropPaths ?? []).some((area) => pathMatchesArea(file, area))) {
        fs.rmSync(path.join(input.workspace.path, file), { recursive: true, force: true });
      }
    }
    files = fs.readdirSync(input.workspace.path);
    return { headCommit: files.length > 0 ? `mem-${files.length}` : null, changedFiles: files };
  }

  async integrate(input: {
    repoRoot: string;
    dataDir: string;
    jobId: string;
    baseCommit: string;
    branches: Array<{ branch: string; label: string }>;
    maxDiffChars: number;
  }): Promise<IntegrationResult> {
    return {
      ok: true,
      branch: integrationBranch(input.jobId),
      path: path.join(input.dataDir, "worktrees", input.jobId, "_integration"),
      headCommit: "memory-integration",
      conflicts: [],
      diff: input.branches
        .map((branch) => branch.label)
        .join("\n")
        .slice(0, input.maxDiffChars),
    };
  }

  async cleanup(): Promise<void> {
    return undefined;
  }
}
