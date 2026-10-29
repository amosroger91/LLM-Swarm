import fs from "node:fs";
import path from "node:path";
import { SwarmError } from "../errors.js";

/** A portable repository-relative path. Reject Windows aliases on every platform. */
export function validateFilePath(file: string): string {
  const normalized = file.replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (
    !normalized || path.posix.isAbsolute(normalized) || /[\x00-\x1f:"<>|?*]/.test(normalized) ||
    parts.some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part) ||
      /^(?:\.git|\.swarm-data|workspaces)$/i.test(part) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
  ) {
    throw new SwarmError(`Path is outside the worktree or reserved: ${file}`, "unsafe_path");
  }
  return normalized;
}

/** Refuse symlinks/junctions, including a linked ancestor of a new destination. */
export function safeFileTarget(root: string, file: string): string {
  const relative = validateFilePath(file);
  const realRoot = fs.realpathSync(root);
  let current = realRoot;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new SwarmError(`Refusing linked file or directory: ${file}`, "unsafe_path");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const check = path.relative(realRoot, current);
  if (!check || check.startsWith("..") || path.isAbsolute(check)) {
    throw new SwarmError(`Path is outside the worktree: ${file}`, "unsafe_path");
  }
  return current;
}

function headerPath(raw: string): string | null {
  if (raw === "/dev/null") return null;
  if (!/^[ab]\//.test(raw)) throw new SwarmError("Patch paths require a/ or b/ prefixes", "bad_patch", true);
  return validateFilePath(raw.slice(2));
}

export function validatedPatchPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const section of patch.split(/(?=^diff --git )/m)) {
    if (!section.trim()) continue;
    const header = section.split(/^@@/m, 1)[0] ?? "";
    if (/^(?:new file mode|old mode|new mode|deleted file mode) (?!100644\b|100755\b)/m.test(header) ||
        /^(?:rename |copy |GIT binary patch|Binary files )/m.test(header)) {
      throw new SwarmError("Only regular text-file patches are supported", "bad_patch", true);
    }
    const diff = /^diff --git a\/(\S+) b\/(\S+)\r?$/m.exec(header);
    if (header.startsWith("diff --git ") && !diff) {
      throw new SwarmError("Unsupported or ambiguous diff path", "bad_patch", true);
    }
    if (diff) {
      const oldPath = validateFilePath(diff[1]!);
      const newPath = validateFilePath(diff[2]!);
      if (oldPath !== newPath) throw new SwarmError("Mismatched diff paths", "unsafe_path");
      paths.add(newPath);
    }
    for (const line of header.split(/\r?\n/)) {
      if (!line.startsWith("+++ ") && !line.startsWith("--- ")) continue;
      const file = headerPath(line.slice(4));
      if (file) {
        if (diff && file !== diff[2]) throw new SwarmError("Mismatched patch headers", "unsafe_path");
        paths.add(file);
      }
    }
  }
  return [...paths];
}
