import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Resolve dependencies up the worktree's ancestor chain; do not install during a check.
function dependency(relative) {
  let directory = process.cwd();
  for (;;) {
    const candidate = path.join(directory, "node_modules", relative);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Install music-app dependencies first: ${relative}`);
    directory = parent;
  }
}
for (const [relative, args] of [
  ["typescript/bin/tsc", ["--noEmit"]],
  ["vitest/vitest.mjs", ["run"]],
  ["vite/bin/vite.js", ["build"]],
]) {
  const result = spawnSync(process.execPath, [dependency(relative), ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
    timeout: 90000,
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.status !== 0) process.exit(result.status ?? 1);
}
