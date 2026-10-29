export const JOB_STATUSES = [
  "planning",
  "running",
  "review",
  "completed",
  "failed",
  "cancel_requested",
  "cancelled",
  "interrupted",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const TASK_STATUSES = [
  "blocked",
  "ready",
  "running",
  "review",
  "revision",
  "done",
  "failed",
  "cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "interrupted",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const MESSAGE_TYPES = [
  "status",
  "question",
  "finding",
  "proposal",
  "handoff",
  "result",
  "chat",
] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
];

export function isTerminalJob(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.includes(status);
}

const JOB_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  planning: ["running", "completed", "failed", "cancel_requested", "cancelled", "interrupted"],
  running: ["review", "completed", "failed", "cancel_requested", "cancelled", "interrupted"],
  review: ["running", "completed", "failed", "cancel_requested", "cancelled", "interrupted"],
  cancel_requested: ["cancelled", "failed", "interrupted"],
  completed: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};

const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  blocked: ["ready", "failed", "cancelled"],
  ready: ["running", "failed", "cancelled"],
  running: ["review", "ready", "failed", "cancelled"],
  review: ["done", "revision", "failed", "cancelled"],
  revision: ["done", "failed", "cancelled", "review"],
  done: ["review"],
  failed: [],
  cancelled: [],
};

export function assertJobTransition(from: JobStatus, to: JobStatus): void {
  if (from === to) return;
  if (!JOB_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid job transition ${from} -> ${to}`);
  }
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (from === to) return;
  if (!TASK_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid task transition ${from} -> ${to}`);
  }
}

export function emptyTaskCounts(): Record<TaskStatus, number> {
  return {
    blocked: 0,
    ready: 0,
    running: 0,
    review: 0,
    revision: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
  };
}

/**
 * A predecessor satisfies dependents once its implementation has succeeded.
 * `done` is the post-approval state. `review` and `revision` still count so a
 * job-level review cannot deadlock the graph. See docs/architecture.md.
 */
export function dependencySatisfied(status: TaskStatus): boolean {
  return status === "done" || status === "review" || status === "revision";
}
