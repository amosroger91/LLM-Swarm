import fs from "node:fs";
import path from "node:path";
import { SwarmError } from "../errors.js";

export function resolveExistingDirectory(input: string): string {
  if (input.includes("\0")) {
    throw new SwarmError("Path contains a null byte", "bad_path");
  }
  const resolved = path.resolve(input);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new SwarmError(`Path does not exist: ${resolved}`, "bad_path");
  }
  if (!stat.isDirectory()) {
    throw new SwarmError(`Path is not a directory: ${resolved}`, "bad_path");
  }
  return fs.realpathSync(resolved);
}

export function resolveInside(root: string, target: string): string {
  if (target.includes("\0")) {
    throw new SwarmError("Path contains a null byte", "bad_path");
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, target);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new SwarmError(`Path escapes the allowed root: ${target}`, "bad_path");
  }
  return resolved;
}

export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function assertOutsideRepository(repoRoot: string, dataDir: string): void {
  const repo = fs.realpathSync(repoRoot);
  fs.mkdirSync(dataDir, { recursive: true });
  const data = fs.realpathSync(dataDir);
  if (isInside(repo, data)) {
    throw new SwarmError(
      `dataDir ${data} is inside repository ${repo}. Put the swarm database and worktrees outside the target repository.`,
      "bad_data_dir",
    );
  }
}
