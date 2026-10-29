import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeNewFiles } from "../src/git/workspace.js";
import { safeFileTarget, validateFilePath } from "../src/safety/files.js";
import { removeTemp, tempDir } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(removeTemp));
const patch = (diffPath: string, headerPath = diffPath) =>
  `diff --git a/${diffPath} b/${diffPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${headerPath}\n@@ -0,0 +1 @@\n+marker\n`;

describe("patch containment", () => {
  it.each(["../escaped.txt", ".git/config", "dir/../../escaped", "C:/outside", "a:stream", "dir./file", "dir/NUL.txt", "workspaces/other/file"])("rejects %s before writing any file", (file) => {
    const root = tempDir("swarm-path-"); dirs.push(root);
    const workspace = path.join(root, "workspace"); fs.mkdirSync(workspace);
    expect(() => materializeNewFiles(workspace, patch("ok.txt") + patch(file, "safe.txt"))).toThrow();
    expect(fs.readdirSync(workspace)).toEqual([]);
    expect(fs.existsSync(path.join(root, "escaped.txt"))).toBe(false);
  });

  it("rejects mismatched safe headers and symlink modes", () => {
    const root = tempDir("swarm-headers-"); dirs.push(root);
    expect(() => materializeNewFiles(root, patch("one.txt", "two.txt"))).toThrow(/Mismatched/);
    expect(() => materializeNewFiles(root, patch("link").replace("100644", "120000"))).toThrow(/regular/);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("refuses writes through a directory junction or symlink", () => {
    const root = tempDir("swarm-link-"); dirs.push(root);
    const workspace = path.join(root, "workspace"); fs.mkdirSync(workspace);
    const outside = path.join(root, "outside"); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(workspace, "linked"), process.platform === "win32" ? "junction" : "dir");
    expect(() => materializeNewFiles(workspace, patch("linked/file.txt"))).toThrow(/linked/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("accepts ordinary nested source files", () => {
    const root = tempDir("swarm-safe-"); dirs.push(root);
    materializeNewFiles(root, patch("src/new.ts"));
    expect(fs.readFileSync(safeFileTarget(root, "src/new.ts"), "utf8")).toBe("marker\n");
    expect(validateFilePath("src\\new.ts")).toBe("src/new.ts");
  });
});
