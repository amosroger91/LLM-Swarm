import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitWorkspace, assertSafePatch, normalizePatch, taskBranch } from "../src/git/workspace.js";
import { SwarmError } from "../src/errors.js";
import { git, initRepo, removeTemp, tempDir } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) removeTemp(dir);
  }
});

function workspace(): GitWorkspace {
  return new GitWorkspace({
    authorName: "LLM Swarm",
    authorEmail: "swarm@localhost",
    timeoutMs: 20_000,
    maxContextChars: 8_000,
    policy: {
      cleanupWorktrees: true,
      preserveOnFailure: true,
      allowPush: false,
      allowMergeToBase: false,
      allowRemotePr: false,
    },
  });
}

describe("git workspace", () => {
  it("creates an isolated worktree, commits with the swarm author, and refuses a remote push", async () => {
    const dir = tempDir("swarm-git-");
    dirs.push(dir);
    const repo = path.join(dir, "repo");
    const data = path.join(dir, "data");
    initRepo(repo);
    const gitWorkspace = workspace();
    const context = await gitWorkspace.assertRepo(repo);
    expect(context.baseBranch).toBe("main");
    const run = await gitWorkspace.createRunWorkspace({
      repoRoot: repo,
      dataDir: data,
      jobId: "job-12345678-aaaa",
      stableId: "alpha",
      attempt: 1,
      baseCommit: context.baseCommit,
    });
    expect(run.path.startsWith(data)).toBe(true);
    expect(fs.existsSync(path.join(run.path, "README.md"))).toBe(true);
    const finalized = await gitWorkspace.finalizeRun({
      repoRoot: repo,
      workspace: run,
      message: "swarm: alpha",
      patch: [
        "diff --git a/hello.txt b/hello.txt",
        "new file mode 100644",
        "index 0000000..ce01362",
        "--- /dev/null",
        "+++ b/hello.txt",
        "@@ -0,0 +1 @@",
        "+hello",
        "",
      ].join("\n"),
    });
    expect(finalized.changedFiles).toContain("hello.txt");
    expect(finalized.headCommit).toBeTruthy();
    const author = git(repo, ["log", "-1", "--format=%an%n%ae", run.branch]);
    expect(author).toBe("LLM Swarm\nswarm@localhost\n");
    expect(() => gitWorkspace.refuseRemote("push")).toThrow(/local-only/);
    await expect(
      gitWorkspace.createRunWorkspace({
        repoRoot: repo,
        dataDir: repo,
        jobId: "job-12345678-aaaa",
        stableId: "inside",
        attempt: 1,
        baseCommit: context.baseCommit,
      }),
    ).rejects.toBeInstanceOf(SwarmError);
    await gitWorkspace.cleanup({
      repoRoot: repo,
      worktrees: [{ path: run.path, branch: run.branch, preserve: false }],
    });
    expect(fs.existsSync(run.path)).toBe(false);
  });

  it("repairs a new-file diff that omitted the plus prefix and the hunk count", async () => {
    const dir = tempDir("swarm-git-repair-");
    dirs.push(dir);
    const repo = path.join(dir, "repo");
    const data = path.join(dir, "data");
    initRepo(repo);
    const gitWorkspace = workspace();
    const context = await gitWorkspace.assertRepo(repo);
    const run = await gitWorkspace.createRunWorkspace({
      repoRoot: repo,
      dataDir: data,
      jobId: "job-repair01",
      stableId: "page",
      attempt: 1,
      baseCommit: context.baseCommit,
    });
    const raw = [
      "diff --git a/index.html b/index.html",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/index.html",
      "@@ -0,0 +1,2 @@",
      "<h1>Swarm Test Site</h1>",
      '<button id="greet">Greet</button>',
      "",
    ].join("\n");
    const repaired = normalizePatch(raw);
    expect(repaired).toContain("+<h1>Swarm Test Site</h1>");
    expect(repaired).toContain("@@ -0,0 +1,2 @@");
    const finalized = await gitWorkspace.finalizeRun({
      repoRoot: repo,
      workspace: run,
      message: "swarm: page",
      patch: raw,
    });
    expect(finalized.changedFiles).toContain("index.html");
    expect(fs.readFileSync(path.join(run.path, "index.html"), "utf8")).toBe(
      '<h1>Swarm Test Site</h1>\n<button id="greet">Greet</button>\n',
    );
  });

  it("rejects a done run that does not change the worktree", async () => {
    const dir = tempDir("swarm-git-empty-");
    dirs.push(dir);
    const repo = path.join(dir, "repo");
    const data = path.join(dir, "data");
    initRepo(repo);
    const gitWorkspace = workspace();
    const context = await gitWorkspace.assertRepo(repo);
    const run = await gitWorkspace.createRunWorkspace({
      repoRoot: repo,
      dataDir: data,
      jobId: "job-empty001",
      stableId: "noop",
      attempt: 1,
      baseCommit: context.baseCommit,
    });
    await expect(
      gitWorkspace.finalizeRun({ repoRoot: repo, workspace: run, message: "nothing" }),
    ).rejects.toMatchObject({ code: "no_change", retryable: true });
  });

  it("drops a file owned by another task and commits the file this task owns", async () => {
    const dir = tempDir("swarm-git-drop-");
    dirs.push(dir);
    const repo = path.join(dir, "repo");
    const data = path.join(dir, "data");
    initRepo(repo);
    const gitWorkspace = workspace();
    const context = await gitWorkspace.assertRepo(repo);
    const run = await gitWorkspace.createRunWorkspace({
      repoRoot: repo,
      dataDir: data,
      jobId: "job-drop0001",
      stableId: "css",
      attempt: 1,
      baseCommit: context.baseCommit,
    });
    fs.writeFileSync(path.join(run.path, "site.css"), "body { background: #eee; }\n", "utf8");
    fs.writeFileSync(path.join(run.path, "index.html"), "<h1>Swarm Test Site</h1>\n", "utf8");
    const finalized = await gitWorkspace.finalizeRun({
      repoRoot: repo,
      workspace: run,
      message: "swarm: css",
      dropPaths: ["index.html"],
    });
    expect(finalized.changedFiles).toContain("site.css");
    expect(finalized.changedFiles).not.toContain("index.html");
    expect(git(repo, ["show", `${run.branch}:site.css`])).toContain("background");
    expect(() => git(repo, ["show", `${run.branch}:index.html`])).toThrow();
  });

  it("replaces an existing file when the model sends a new-file diff", async () => {
    const dir = tempDir("swarm-git-replace-");
    dirs.push(dir);
    const repo = path.join(dir, "repo");
    const data = path.join(dir, "data");
    initRepo(repo);
    const gitWorkspace = workspace();
    const context = await gitWorkspace.assertRepo(repo);
    const run = await gitWorkspace.createRunWorkspace({
      repoRoot: repo,
      dataDir: data,
      jobId: "job-replace1",
      stableId: "page",
      attempt: 1,
      baseCommit: context.baseCommit,
    });
    fs.writeFileSync(path.join(run.path, "index.html"), "old\n", "utf8");
    git(run.path, ["add", "index.html"]);
    git(run.path, ["commit", "-m", "old page"]);
    const finalized = await gitWorkspace.finalizeRun({
      repoRoot: repo,
      workspace: run,
      message: "swarm: page",
      patch: [
        "diff --git a/index.html b/index.html",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/index.html",
        "@@ -1,1 +1,2 @@",
        "+<h1>Swarm Test Site</h1>",
        "+<link rel=\"stylesheet\" href=\"site.css\">",
        "",
      ].join("\n"),
    });
    expect(finalized.changedFiles).toContain("index.html");
    const written = fs.readFileSync(path.join(run.path, "index.html"), "utf8");
    expect(written).toContain("<h1>Swarm Test Site</h1>");
    expect(written).not.toContain("old");
  });

  it("aborts a conflicting merge and leaves both branches intact", async () => {
    const dir = tempDir("swarm-git-conflict-");
    dirs.push(dir);
    const repo = path.join(dir, "repo");
    const data = path.join(dir, "data");
    initRepo(repo);
    const gitWorkspace = workspace();
    const context = await gitWorkspace.assertRepo(repo);
    const left = await gitWorkspace.createRunWorkspace({
      repoRoot: repo,
      dataDir: data,
      jobId: "job-conflict1",
      stableId: "left",
      attempt: 1,
      baseCommit: context.baseCommit,
    });
    const right = await gitWorkspace.createRunWorkspace({
      repoRoot: repo,
      dataDir: data,
      jobId: "job-conflict1",
      stableId: "right",
      attempt: 1,
      baseCommit: context.baseCommit,
    });
    fs.writeFileSync(path.join(left.path, "README.md"), "from-left\n", "utf8");
    fs.writeFileSync(path.join(right.path, "README.md"), "from-right\n", "utf8");
    await gitWorkspace.finalizeRun({ repoRoot: repo, workspace: left, message: "left" });
    await gitWorkspace.finalizeRun({ repoRoot: repo, workspace: right, message: "right" });
    const integrated = await gitWorkspace.integrate({
      repoRoot: repo,
      dataDir: data,
      jobId: "job-conflict1",
      baseCommit: context.baseCommit,
      branches: [
        { branch: left.branch, label: "left" },
        { branch: right.branch, label: "right" },
      ],
      maxDiffChars: 4_000,
    });
    expect(integrated.ok).toBe(false);
    expect(integrated.conflicts).toContain("right");
    expect(git(repo, ["show", "main:README.md"])).toBe("base\n");
    expect(git(repo, ["show", `${left.branch}:README.md`])).toBe("from-left\n");
    expect(git(repo, ["show", `${right.branch}:README.md`])).toBe("from-right\n");
    expect(taskBranch("job-conflict1", "left", 1)).toBe(left.branch);
  });

  it("rejects a patch that escapes the worktree", () => {
    expect(() => assertSafePatch("--- a/../secret\n+++ b/../secret\n")).toThrow(
      /outside the worktree/,
    );
    expect(() => assertSafePatch("--- /dev/null\n+++ b/ok.txt\n")).not.toThrow();
  });
});
