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

async function protectedWorkspace() {
  const dir = tempDir("swarm-verification-");
  dirs.push(dir);
  const repo = path.join(dir, "repo");
  initRepo(repo);
  fs.mkdirSync(path.join(repo, "test"));
  fs.writeFileSync(path.join(repo, "test/contract.cjs"), "original verifier\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "generated/\ntest/ignored/\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "trusted verifier"]);
  const manager = workspace();
  const context = await manager.assertRepo(repo);
  const run = await manager.createRunWorkspace({
    repoRoot: repo,
    dataDir: dir,
    jobId: "job-verification",
    stableId: "worker",
    attempt: 1,
    baseCommit: context.baseCommit,
  });
  return { manager, run, repo };
}

describe("git workspace", () => {
  it("rejects every protected patch path before materializing any part of the patch", async () => {
    const { manager, run, repo } = await protectedWorkspace();
    const patch = (file: string) =>
      `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+replacement\n`;
    await expect(
      manager.finalizeRun({
        repoRoot: repo,
        workspace: run,
        message: "tampered",
        patch: patch("allowed.txt") + patch("TEST/contract.cjs"),
        forbiddenPaths: ["test/"],
      }),
    ).rejects.toMatchObject({ code: "protected_verifier", retryable: false });
    expect(fs.existsSync(path.join(run.path, "allowed.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(run.path, "test/contract.cjs"), "utf8")).toBe(
      "original verifier\n",
    );
    expect(git(run.path, ["status", "--porcelain"])).toBe("");
  });

  it.each(["unstaged", "staged", "committed", "deleted", "renamed"])(
    "rejects %s CLI changes to protected verifiers before dropping files or writing a patch",
    async (mode) => {
      const { manager, run, repo } = await protectedWorkspace();
      const verifier = path.join(run.path, "test/contract.cjs");
      if (mode === "deleted") fs.unlinkSync(verifier);
      else if (mode === "renamed") git(run.path, ["mv", "test/contract.cjs", "moved.cjs"]);
      else fs.writeFileSync(verifier, "tampered verifier\n");
      if (mode === "staged" || mode === "committed") git(run.path, ["add", "."]);
      if (mode === "committed") git(run.path, ["commit", "-m", "tampered verifier"]);
      const before = git(run.path, ["status", "--porcelain"]);
      await expect(
        manager.finalizeRun({
          repoRoot: repo,
          workspace: run,
          message: "implementation",
          patch:
            "diff --git a/allowed.txt b/allowed.txt\nnew file mode 100644\n--- /dev/null\n+++ b/allowed.txt\n@@ -0,0 +1 @@\n+allowed\n",
          forbiddenPaths: ["test/contract.cjs"],
          dropPaths: ["test"],
        }),
      ).rejects.toMatchObject({ code: "protected_verifier", retryable: false });
      expect(git(run.path, ["status", "--porcelain"])).toBe(before);
      expect(fs.existsSync(path.join(run.path, "allowed.txt"))).toBe(false);
    },
  );

  it("rejects untracked protected verifier files while accepting unrelated implementation files", async () => {
    const { manager, run, repo } = await protectedWorkspace();
    fs.writeFileSync(path.join(run.path, "test/new.cjs"), "tampered\n");
    fs.writeFileSync(path.join(run.path, "implementation.ts"), "export const answer = 42;\n");
    await expect(
      manager.finalizeRun({
        repoRoot: repo,
        workspace: run,
        message: "implementation",
        forbiddenPaths: ["test"],
      }),
    ).rejects.toMatchObject({ code: "protected_verifier", retryable: false });
    fs.unlinkSync(path.join(run.path, "test/new.cjs"));
    const result = await manager.finalizeRun({
      repoRoot: repo,
      workspace: run,
      message: "implementation",
      forbiddenPaths: ["test"],
    });
    expect(result.changedFiles).toEqual(["implementation.ts"]);
    await expect(manager.verifySnapshot(run.path, result.headCommit!)).resolves.toBeUndefined();
  });

  it.each(["--assume-unchanged", "--skip-worktree"])(
    "rejects protected verifier changes hidden behind %s index flags",
    async (flag) => {
      const { manager, run, repo } = await protectedWorkspace();
      git(run.path, ["update-index", flag, "test/contract.cjs"]);
      fs.writeFileSync(path.join(run.path, "test/contract.cjs"), "bypassed verifier\n");
      fs.writeFileSync(path.join(run.path, "implementation.ts"), "export const answer = 42;\n");
      expect(git(run.path, ["status", "--porcelain"])).not.toContain("contract.cjs");
      await expect(
        manager.finalizeRun({
          repoRoot: repo,
          workspace: run,
          message: "hidden verifier mutation",
          forbiddenPaths: ["test"],
        }),
      ).rejects.toMatchObject({ code: "protected_verifier", retryable: false });
    },
  );

  it.each(["test", "TEST/IGNORED", "test/ignored/contract.cjs"])(
    "rejects ignored untracked additions within protected path %s",
    async (protectedPath) => {
      const { manager, run, repo } = await protectedWorkspace();
      fs.mkdirSync(path.join(run.path, "test/ignored"));
      fs.writeFileSync(path.join(run.path, "test/ignored/contract.cjs"), "bypassed verifier\n");
      fs.writeFileSync(path.join(run.path, "implementation.ts"), "export const answer = 42;\n");
      expect(git(run.path, ["status", "--porcelain"])).not.toContain("contract.cjs");
      await expect(
        manager.finalizeRun({
          repoRoot: repo,
          workspace: run,
          message: "hidden verifier addition",
          forbiddenPaths: [protectedPath],
        }),
      ).rejects.toMatchObject({ code: "protected_verifier", retryable: false });
    },
  );

  it.each(["--assume-unchanged", "--skip-worktree"])(
    "rejects a worktree mutation hidden behind %s even when Git status appears clean",
    async (flag) => {
      const { manager, run } = await protectedWorkspace();
      const expectedCommit = git(run.path, ["rev-parse", "HEAD"]).trim();
      git(run.path, ["update-index", flag, "README.md"]);
      fs.writeFileSync(path.join(run.path, "README.md"), "hidden mutation\n");
      expect(git(run.path, ["status", "--porcelain"])).toBe("");
      await expect(manager.verifySnapshot(run.path, expectedCommit)).rejects.toMatchObject({
        code: "verification_changed",
        retryable: false,
      });
    },
  );

  it.each(["tracked", "staged", "untracked", "head"])(
    "rejects a verifier that changes the %s snapshot",
    async (mode) => {
      const { manager, run } = await protectedWorkspace();
      const expectedCommit = git(run.path, ["rev-parse", "HEAD"]).trim();
      if (mode === "head") git(run.path, ["commit", "--allow-empty", "-m", "checker commit"]);
      else if (mode === "untracked")
        fs.writeFileSync(path.join(run.path, "checker-output.txt"), "output\n");
      else {
        fs.writeFileSync(path.join(run.path, "README.md"), "checker changed source\n");
        if (mode === "staged") git(run.path, ["add", "README.md"]);
      }
      await expect(manager.verifySnapshot(run.path, expectedCommit)).rejects.toMatchObject({
        code: "verification_changed",
        retryable: false,
      });
    },
  );

  it("permits ignored generated outputs when verification leaves the source snapshot intact", async () => {
    const { manager, run, repo } = await protectedWorkspace();
    fs.mkdirSync(path.join(run.path, "generated"));
    fs.writeFileSync(path.join(run.path, "generated/build.js"), "compiled\n");
    fs.writeFileSync(path.join(run.path, "implementation.ts"), "export const answer = 42;\n");
    const result = await manager.finalizeRun({
      repoRoot: repo,
      workspace: run,
      message: "implementation with ignored build output",
      forbiddenPaths: ["test"],
    });
    expect(result.changedFiles).toEqual(["implementation.ts"]);
    await expect(manager.verifySnapshot(run.path, result.headCommit!)).resolves.toBeUndefined();
  });

  it("does not execute repository or worktree-root hooks during coordinator commits", async () => {
    const dir = tempDir("swarm-hooks-");
    dirs.push(dir);
    const repo = path.join(dir, "repo");
    initRepo(repo);
    const workspaceManager = workspace();
    const context = await workspaceManager.assertRepo(repo);
    const run = await workspaceManager.createRunWorkspace({
      repoRoot: repo,
      dataDir: dir,
      jobId: "job-hooks",
      stableId: "a",
      attempt: 1,
      baseCommit: context.baseCommit,
    });
    const hook = "#!/bin/sh\necho executed > hook-ran.txt\nexit 1\n";
    fs.writeFileSync(path.join(repo, ".git/hooks/pre-commit"), hook, { mode: 0o755 });
    fs.writeFileSync(path.join(run.path, "pre-commit"), hook, { mode: 0o755 });
    fs.writeFileSync(path.join(run.path, "a.txt"), "done\n");
    const committed = await workspaceManager.finalizeRun({
      repoRoot: repo,
      workspace: run,
      message: "safe commit",
    });
    expect(committed.headCommit).toBeTruthy();
    expect(fs.existsSync(path.join(run.path, "hook-ran.txt"))).toBe(false);
  });
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
    expect(run.path).toBe(path.join(repo, "workspaces", "job-12345678-aaaa", "agent-alpha-1"));
    expect(git(repo, ["status", "--porcelain"])).toBe("");
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
        jobId: "../invalid-job",
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
        '+<link rel="stylesheet" href="site.css">',
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
