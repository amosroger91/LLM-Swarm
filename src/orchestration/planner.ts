import { z } from "zod";
import { validateFilePath } from "../safety/files.js";

export const PlanTaskSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  title: z.string().min(1).max(200),
  instructions: z.string().min(1).max(8000),
  acceptanceCriteria: z.array(z.string().min(1).max(1000)).min(1).max(20),
  dependencies: z.array(z.string()).max(20).default([]),
  suggestedRole: z.string().max(100).optional(),
  fileAreas: z.array(z.string().max(300)).max(30).default([]),
  verificationChecks: z
    .array(z.number().int().nonnegative())
    .min(1)
    .max(20)
    .refine((indices) => new Set(indices).size === indices.length, {
      message: "Verification check indices must be unique",
    })
    .optional(),
});

export const PlanSchema = z.object({
  goal: z.string().min(1).max(2000),
  completionCriteria: z.array(z.string().min(1).max(1000)).min(1).max(20),
  tasks: z.array(PlanTaskSchema).min(1).max(30),
  risks: z.array(z.string().max(1000)).max(20).default([]),
  assumptions: z.array(z.string().max(1000)).max(20).default([]),
  questions: z.array(z.string().max(1000)).max(20).default([]),
  contracts: z.array(z.string().min(1).max(2000)).max(30).default([]),
});

export type Plan = z.infer<typeof PlanSchema>;

const PLAN_STRING_LISTS = ["completionCriteria", "risks", "assumptions", "questions"] as const;
const TASK_STRING_LISTS = ["acceptanceCriteria", "dependencies", "fileAreas"] as const;

/** Local models often emit one string where the contract requires a string array. */
export function coercePlanInput(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const plan = { ...(input as Record<string, unknown>) };
  for (const key of PLAN_STRING_LISTS) plan[key] = stringList(plan[key]);
  if (Array.isArray(plan.tasks)) {
    plan.tasks = plan.tasks.map((task) => {
      if (!task || typeof task !== "object" || Array.isArray(task)) return task;
      const copy = { ...(task as Record<string, unknown>) };
      for (const key of TASK_STRING_LISTS) {
        copy[key] = key === "fileAreas" ? fileAreaList(copy[key]) : stringList(copy[key]);
      }
      return copy;
    });
  }
  return plan;
}

function stringList(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed ? [trimmed] : [];
}

function fileAreaList(value: unknown): unknown {
  const split = (text: string): string[] =>
    text
      .split(/[,;\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  if (typeof value === "string") return split(value);
  if (!Array.isArray(value)) return value;
  return value.flatMap((item) => (typeof item === "string" ? split(item) : [item]));
}

const MENTIONED_FILE = /\b([A-Za-z0-9][A-Za-z0-9._/-]*\.[A-Za-z0-9]{1,8})\b/g;
const UNTOUCHED_FILE = /do not (?:change|edit|modify|touch)\s+`?([A-Za-z0-9._/-]+)/gi;

/** A one-task plan still has to be allowed to write every file the request names. */
export function widenSingleTaskFiles(jobTask: string, plan: Plan): Plan {
  const task = plan.tasks[0];
  if (!task || plan.tasks.length !== 1) return plan;
  const denied = new Set<string>();
  for (const match of jobTask.matchAll(UNTOUCHED_FILE)) {
    const name = match[1]
      ?.replace(/^\.\//, "")
      .replace(/[.)]+$/g, "")
      .toLowerCase();
    if (name) denied.add(name);
  }
  const areas = [...task.fileAreas];
  const seen = new Set(areas.map((area) => area.replaceAll("\\", "/").toLowerCase()));
  for (const match of jobTask.matchAll(MENTIONED_FILE)) {
    const file = match[1]?.replaceAll("\\", "/").replace(/^\.\//, "");
    if (!file || file.split("/").includes("..")) continue;
    const key = file.toLowerCase();
    const base = file.split("/").pop()?.toLowerCase() ?? key;
    if (denied.has(key) || denied.has(base) || seen.has(key)) continue;
    seen.add(key);
    areas.push(file);
  }
  if (areas.length === task.fileAreas.length) return plan;
  const added = areas.slice(task.fileAreas.length);
  return {
    ...plan,
    tasks: [
      {
        ...task,
        fileAreas: areas,
        instructions: `${task.instructions}\n\nAlso create these files from the original request, in this same change: ${added.join(", ")}.`,
      },
    ],
  };
}

export function validatePlan(
  input: unknown,
  checkCount?: number,
): { ok: true; plan: Plan } | { ok: false; errors: string[] } {
  const parsed = PlanSchema.safeParse(coercePlanInput(input));
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "plan"}: ${issue.message}`,
      ),
    };
  }
  const plan = parsed.data;
  const errors: string[] = [];
  for (const task of plan.tasks) {
    for (const index of task.verificationChecks ?? []) {
      if (checkCount !== undefined && index >= checkCount) {
        errors.push(`task ${task.id} references unknown verification check ${index}`);
      }
    }
    task.fileAreas = task.fileAreas.map((area) =>
      area.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, ""),
    );
    for (const area of task.fileAreas) {
      try {
        validateFilePath(area);
      } catch {
        errors.push(
          `task ${task.id} has invalid fileArea ${JSON.stringify(area)}. Use repository-relative paths without leading slashes or globs.`,
        );
      }
    }
  }
  const ids = new Set<string>();
  for (const task of plan.tasks) {
    if (ids.has(task.id)) errors.push(`duplicate task id ${task.id}`);
    ids.add(task.id);
    if (task.dependencies.includes(task.id)) errors.push(`task ${task.id} depends on itself`);
  }
  for (const task of plan.tasks) {
    for (const dependency of task.dependencies) {
      if (!ids.has(dependency))
        errors.push(`task ${task.id} depends on missing task ${dependency}`);
    }
  }
  if (errors.length === 0 && hasCycle(plan.tasks)) {
    errors.push("task dependencies contain a cycle");
  }
  if (plan.tasks.length > 1) {
    for (const task of plan.tasks) {
      if (task.fileAreas.length === 0) {
        errors.push(
          `task ${task.id} lists no files. With more than one task, each task must list only the files it will change. For a small website, return exactly one task.`,
        );
      }
    }
  }
  const ancestors = (id: string, seen = new Set<string>()): Set<string> => {
    for (const dependency of plan.tasks.find((task) => task.id === id)?.dependencies ?? []) {
      if (seen.has(dependency)) continue;
      seen.add(dependency);
      ancestors(dependency, seen);
    }
    return seen;
  };
  const fileOwners = new Map<string, string>();
  for (const task of plan.tasks) {
    for (const area of task.fileAreas) {
      const key = area.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
      if (!key) continue;
      const owner = [...fileOwners].find(
        ([other, owner]) =>
          (key === other || key.startsWith(`${other}/`) || other.startsWith(`${key}/`)) &&
          !ancestors(task.id).has(owner) &&
          !ancestors(owner).has(task.id),
      )?.[1];
      if (owner) {
        errors.push(
          `tasks ${owner} and ${task.id} both list ${area}. Put shared files in one task so the branches do not conflict.`,
        );
      } else {
        fileOwners.set(key, task.id);
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, plan };
}

function hasCycle(tasks: Plan["tasks"]): boolean {
  const deps = new Map(tasks.map((task) => [task.id, task.dependencies]));
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string): boolean => {
    const current = state.get(id);
    if (current === "visiting") return true;
    if (current === "done") return false;
    state.set(id, "visiting");
    for (const dependency of deps.get(id) ?? []) {
      if (visit(dependency)) return true;
    }
    state.set(id, "done");
    return false;
  };
  for (const task of tasks) {
    if (visit(task.id)) return true;
  }
  return false;
}

const DONE_STATUSES = new Set([
  "done",
  "complete",
  "completed",
  "success",
  "succeeded",
  "ok",
  "finished",
]);
const FAIL_STATUSES = new Set(["failed", "fail", "error", "failure"]);
const BLOCK_STATUSES = new Set(["blocked", "block"]);
const MESSAGE_TYPES = new Set(["status", "question", "finding", "proposal", "handoff", "result"]);

function filesToPatch(files: unknown): string | undefined {
  if (!Array.isArray(files)) return undefined;
  const parts: string[] = [];
  for (const file of files) {
    if (!file || typeof file !== "object") continue;
    const record = file as Record<string, unknown>;
    const rawPath = typeof record.path === "string" ? record.path : record.name;
    const content = record.content;
    if (typeof rawPath !== "string" || typeof content !== "string") continue;
    const filePath = rawPath.replaceAll("\\", "/").replace(/^\.\//, "");
    if (!filePath || filePath.split("/").includes("..") || filePath.startsWith("/")) continue;
    const text = content.replaceAll("\r\n", "\n");
    const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
    const body = lines.map((line) => `+${line}`).join("\n");
    parts.push(
      [
        `diff --git a/${filePath} b/${filePath}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${filePath}`,
        `@@ -0,0 +1,${lines.length} @@`,
        body,
        "",
      ].join("\n"),
    );
  }
  return parts.length > 0 ? parts.join("") : undefined;
}

/** Local models miss required strings, use status synonyms, or return file contents instead of a diff. */
export function coerceWorkerResult(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const value = { ...(input as Record<string, unknown>) };
  if (
    typeof value.patch === "string" &&
    /^(?:none|null|n\/?a|not (?:needed|required|applicable))\.?$/i.test(value.patch.trim())
  )
    delete value.patch;
  const status = typeof value.status === "string" ? value.status.trim().toLowerCase() : "";
  if (DONE_STATUSES.has(status)) value.status = "done";
  else if (FAIL_STATUSES.has(status)) value.status = "failed";
  else if (BLOCK_STATUSES.has(status)) value.status = "blocked";
  else if (!status && (typeof value.patch === "string" || Array.isArray(value.files))) {
    value.status = "done";
  }
  if (typeof value.summary !== "string" || value.summary.trim().length === 0) {
    value.summary =
      typeof value.notes === "string" && value.notes.trim().length > 0
        ? value.notes
        : "Worker finished without a summary.";
  }
  if (typeof value.patch !== "string" || value.patch.trim().length === 0) {
    const synthesized = filesToPatch(value.files);
    if (synthesized) value.patch = synthesized;
  }
  if (!Array.isArray(value.messages)) delete value.messages;
  else {
    value.messages = value.messages.flatMap((message) => {
      if (!message || typeof message !== "object") return [];
      const record = message as Record<string, unknown>;
      if (typeof record.content !== "string" || record.content.trim().length === 0) return [];
      const type = typeof record.type === "string" ? record.type : "status";
      return [
        {
          ...record,
          type: MESSAGE_TYPES.has(type) ? type : "status",
          content: record.content,
        },
      ];
    });
  }
  if (!Array.isArray(value.proposals)) delete value.proposals;
  return value;
}

export const WorkerResultSchema = z.object({
  summary: z.string().min(1).max(8000),
  status: z.enum(["done", "blocked", "failed"]),
  notes: z.string().max(8000).optional(),
  patch: z.string().max(200_000).optional(),
  messages: z
    .array(
      z.object({
        channel: z.string().max(100).optional(),
        type: z.enum(["status", "question", "finding", "proposal", "handoff", "result"]),
        content: z.string().min(1).max(8000),
      }),
    )
    .max(20)
    .optional(),
  proposals: z
    .array(
      z.object({
        question: z.string().min(1).max(1000),
        context: z.string().max(4000).optional(),
        options: z.array(z.string().min(1).max(200)).min(2).max(8),
        blocking: z.boolean().optional(),
      }),
    )
    .max(5)
    .optional(),
});

export type WorkerResult = z.infer<typeof WorkerResultSchema>;

const APPROVED_WORDS = new Set(["true", "yes", "approved", "approve", "pass", "passed"]);
const REJECTED_WORDS = new Set(["false", "no", "rejected", "reject", "fail", "failed"]);

/** Local reviewers sometimes return "yes" or omit the findings array. */
export function coerceReviewResult(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const value = { ...(input as Record<string, unknown>) };
  if (typeof value.approved === "string") {
    const word = value.approved.trim().toLowerCase();
    if (APPROVED_WORDS.has(word)) value.approved = true;
    else if (REJECTED_WORDS.has(word)) value.approved = false;
  }
  if (!Array.isArray(value.findings)) value.findings = [];
  value.findings = (value.findings as unknown[]).map((finding) => {
    if (!finding || typeof finding !== "object") return finding;
    const copy = { ...(finding as Record<string, unknown>) };
    // A bad optional locator must not discard an otherwise actionable rejection.
    if (typeof copy.line !== "number" || !Number.isInteger(copy.line) || copy.line <= 0)
      delete copy.line;
    return copy;
  });
  if (value.approved === false && (value.findings as unknown[]).length === 0) {
    const summary =
      typeof value.summary === "string" && value.summary.trim().length > 0
        ? value.summary.trim()
        : "Review rejected the work.";
    value.findings = [{ severity: "major", message: summary, instruction: summary }];
  }
  if (typeof value.summary !== "string" || value.summary.trim().length === 0) {
    value.summary = value.approved === true ? "Approved." : "Rejected.";
  }
  return value;
}

export const ReviewResultSchema = z
  .object({
    approved: z.boolean(),
    summary: z.string().min(1).max(8000),
    findings: z
      .array(
        z.object({
          severity: z.enum(["info", "minor", "major", "critical"]),
          file: z.string().max(300).optional(),
          line: z.number().int().positive().optional(),
          message: z.string().min(1).max(2000),
          instruction: z.string().min(1).max(4000),
        }),
      )
      .max(50)
      .default([]),
    decisions: z
      .array(
        z.object({
          decisionId: z.string().min(1),
          option: z.string().min(1),
          rationale: z.string().min(1).max(4000),
        }),
      )
      .max(20)
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.approved &&
      value.findings.some(
        (finding) => finding.severity === "major" || finding.severity === "critical",
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["approved"],
        message: "Approval cannot contain unresolved major or critical findings",
      });
    if (!value.approved && value.findings.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["findings"],
        message: "A rejection needs at least one finding with an instruction",
      });
    }
  });

export type ReviewResult = z.infer<typeof ReviewResultSchema>;
