import { randomUUID, createHash } from "node:crypto";
import os from "node:os";
import { z } from "zod";
import type { CheckConfig, ProviderConfig } from "../config/schema.js";
import { ProviderConfigSchema } from "../config/schema.js";
import {
  assertJobTransition,
  assertTaskTransition,
  dependencySatisfied,
  emptyTaskCounts,
  type JobStatus,
  type MessageType,
  type RunStatus,
  type TaskStatus,
} from "../domain.js";
import { SwarmError } from "../errors.js";
import { withBusyRetry, type SqliteDatabase } from "./connection.js";
import type { ProviderUsage } from "../providers/types.js";

const StringArray = z.array(z.string());

export interface JobVerification {
  checks: CheckConfig[];
  requireChecks: boolean;
}

export interface BlockerRecord {
  id: string;
  jobId: string;
  taskId: string | null;
  runId: string | null;
  category: string;
  status: string;
  summary: string;
  details: string;
  nextAction: string;
  attempts: string[];
  occurrences: number;
  assists: number;
  decisionId: string | null;
  resolution: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobRecord {
  verification?: JobVerification;
  id: string;
  task: string;
  repoPath: string;
  baseBranch: string;
  baseCommit: string | null;
  integrationBranch: string | null;
  workerCount: number;
  configProfile: string | null;
  status: JobStatus;
  dryRun: boolean;
  goal: string | null;
  completionCriteria: string[];
  planJson: string | null;
  plannerOutput: string | null;
  assumptions: string[];
  risks: string[];
  questions: string[];
  reviewState: string | null;
  reviewRound: number;
  maxAttempts: number;
  maxReviewRounds: number;
  error: string | null;
  finalReport: string | null;
  snapshotPath: string | null;
  createdAt: string;
  updatedAt: string;
  cancelRequestedAt: string | null;
  completedAt: string | null;
}

export interface PlannerChatRecord {
  id: string;
  jobId: string;
  message: string;
  status: "pending" | "completed" | "failed";
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface AgentProfileRecord {
  id: string;
  jobId: string;
  name: string;
  role: "planner" | "worker" | "reviewer";
  providerType: string;
  providerName: string;
  model: string | null;
  config: ProviderConfig;
  fallbacks: Array<{ providerName: string; config: ProviderConfig }>;
  capabilitiesJson: string;
  systemPrompt: string | null;
  createdAt: string;
}

export interface DelegationRecord {
  id: string;
  agent: string;
  provider: string | null;
  model: string | null;
  promptChars: number;
  contextChars: number;
  outputChars: number;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
  failover: Array<{ provider: string; kind: string; error: string }>;
  error: string | null;
  createdAt: string;
}

export interface TaskRecord {
  id: string;
  jobId: string;
  stableId: string;
  title: string;
  instructions: string;
  acceptanceCriteria: string[];
  suggestedRole: string | null;
  fileAreas: string[];
  verificationChecks?: number[];
  status: TaskStatus;
  kind: "implementation" | "revision";
  attemptCount: number;
  maxAttempts: number;
  resultSummary: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunRecord {
  id: string;
  jobId: string;
  taskId: string | null;
  agentProfileId: string | null;
  role: string;
  attempt: number;
  status: RunStatus;
  providerName: string | null;
  model: string | null;
  worktreePath: string | null;
  branchName: string | null;
  baseCommit: string | null;
  headCommit: string | null;
  outputSummary: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface MessageRecord {
  id: string;
  jobId: string;
  sender: string;
  role: string;
  channel: string;
  messageType: MessageType;
  taskId: string | null;
  decisionId: string | null;
  content: string;
  createdAt: string;
}

export interface DecisionRecord {
  blocking: boolean;
  id: string;
  jobId: string;
  question: string;
  context: string | null;
  options: string[];
  proposer: string;
  status: "open" | "resolved";
  deadline: string | null;
  resolutionPolicy: "owner" | "majority" | "unanimous";
  quorum: number;
  ownerRole: string;
  finalOption: string | null;
  finalRationale: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  votes: VoteRecord[];
}

export interface VoteRecord {
  id: string;
  decisionId: string;
  voter: string;
  option: string;
  rationale: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewRecord {
  id: string;
  jobId: string;
  round: number;
  status: "approved" | "rejected";
  summary: string;
  findingsJson: string;
  createdAt: string;
}

export interface EventRecord {
  id: number;
  jobId: string;
  createdAt: string;
  type: string;
  entityType: string | null;
  entityId: string | null;
  payload: unknown;
}

export interface ArtifactRecord {
  id: string;
  jobId: string;
  taskId: string | null;
  runId: string | null;
  kind: string;
  path: string | null;
  summary: string;
  createdAt: string;
}

export interface WorktreeRecord {
  id: string;
  jobId: string;
  taskId: string | null;
  runId: string | null;
  path: string;
  branchName: string;
  baseCommit: string | null;
  headCommit: string | null;
  cleanupState: "active" | "preserved" | "removed";
  createdAt: string;
  updatedAt: string;
}

export interface Claim {
  task: TaskRecord;
  run: RunRecord;
}

export interface PlannedTaskInput {
  stableId: string;
  title: string;
  instructions: string;
  acceptanceCriteria: string[];
  dependencies: string[];
  suggestedRole?: string;
  fileAreas: string[];
  verificationChecks?: number[];
}

interface JobRow {
  verification_json: string | null;
  id: string;
  task: string;
  repo_path: string;
  base_branch: string;
  base_commit: string | null;
  integration_branch: string | null;
  worker_count: number;
  config_profile: string | null;
  status: JobStatus;
  dry_run: number;
  goal: string | null;
  completion_criteria_json: string | null;
  plan_json: string | null;
  planner_output: string | null;
  assumptions_json: string | null;
  risks_json: string | null;
  questions_json: string | null;
  review_state: string | null;
  review_round: number;
  max_attempts: number;
  max_review_rounds: number;
  error: string | null;
  final_report: string | null;
  snapshot_path: string | null;
  created_at: string;
  updated_at: string;
  cancel_requested_at: string | null;
  completed_at: string | null;
}

interface TaskRow {
  id: string;
  job_id: string;
  stable_id: string;
  title: string;
  instructions: string;
  acceptance_criteria_json: string;
  suggested_role: string | null;
  file_areas_json: string;
  verification_checks_json: string | null;
  status: TaskStatus;
  kind: "implementation" | "revision";
  attempt_count: number;
  max_attempts: number;
  result_summary: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function strings(value: string | null | undefined): string[] {
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  const result = StringArray.safeParse(parsed);
  return result.success ? result.data : [];
}

function mapJob(row: JobRow): JobRecord {
  return {
    verification: row.verification_json
      ? (JSON.parse(row.verification_json) as JobVerification)
      : undefined,
    id: row.id,
    task: row.task,
    repoPath: row.repo_path,
    baseBranch: row.base_branch,
    baseCommit: row.base_commit,
    integrationBranch: row.integration_branch,
    workerCount: row.worker_count,
    configProfile: row.config_profile,
    status: row.status,
    dryRun: row.dry_run === 1,
    goal: row.goal,
    completionCriteria: strings(row.completion_criteria_json),
    planJson: row.plan_json,
    plannerOutput: row.planner_output,
    assumptions: strings(row.assumptions_json),
    risks: strings(row.risks_json),
    questions: strings(row.questions_json),
    reviewState: row.review_state,
    reviewRound: row.review_round,
    maxAttempts: row.max_attempts,
    maxReviewRounds: row.max_review_rounds,
    error: row.error,
    finalReport: row.final_report,
    snapshotPath: row.snapshot_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cancelRequestedAt: row.cancel_requested_at,
    completedAt: row.completed_at,
  };
}

function mapTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    stableId: row.stable_id,
    title: row.title,
    instructions: row.instructions,
    acceptanceCriteria: strings(row.acceptance_criteria_json),
    suggestedRole: row.suggested_role,
    fileAreas: strings(row.file_areas_json),
    verificationChecks: row.verification_checks_json
      ? (JSON.parse(row.verification_checks_json) as number[])
      : undefined,
    status: row.status,
    kind: row.kind,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    resultSummary: row.result_summary,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class Store {
  private schedulerToken: string | null = null;
  constructor(private readonly db: SqliteDatabase) {}

  close(): void {
    this.releaseScheduler();
    this.db.close();
  }

  acquireScheduler(): void {
    this.immediate(() => {
      const owner = this.db.prepare("SELECT * FROM scheduler_owner WHERE singleton = 1").get() as
        { token: string; pid: number; hostname: string } | undefined;
      if (owner) {
        let alive = owner.hostname !== os.hostname();
        if (!alive) {
          try {
            process.kill(owner.pid, 0);
            alive = true;
          } catch (error) {
            alive = (error as NodeJS.ErrnoException).code !== "ESRCH";
          }
        }
        if (alive)
          throw new SwarmError(
            `Scheduler already running on ${owner.hostname} (PID ${owner.pid})`,
            "scheduler_busy",
          );
      }
      const token = randomUUID();
      this.db
        .prepare(
          "INSERT OR REPLACE INTO scheduler_owner (singleton, token, pid, hostname) VALUES (1, ?, ?, ?)",
        )
        .run(token, process.pid, os.hostname());
      this.schedulerToken = token;
    });
  }

  releaseScheduler(): void {
    if (!this.schedulerToken) return;
    this.db.prepare("DELETE FROM scheduler_owner WHERE token = ?").run(this.schedulerToken);
    this.schedulerToken = null;
  }

  pinBaseCommit(jobId: string, commit: string): string {
    this.db
      .prepare("UPDATE jobs SET base_commit = COALESCE(base_commit, ?) WHERE id = ?")
      .run(commit, jobId);
    return this.mustJob(jobId).baseCommit!;
  }

  pinVerification(jobId: string, verification: JobVerification): JobVerification {
    return this.immediate(() => {
      this.db
        .prepare("UPDATE jobs SET verification_json = ? WHERE id = ? AND verification_json IS NULL")
        .run(JSON.stringify(verification), jobId);
      const pinned = this.mustJob(jobId).verification;
      if (!pinned) throw new SwarmError("Verification configuration was not persisted", "internal");
      return pinned;
    });
  }

  requestCancel(jobId: string): { job_id: string; status: string } {
    return this.immediate(() => {
      const job = this.mustJob(jobId);
      if (["completed", "failed", "cancelled", "interrupted"].includes(job.status)) {
        return { job_id: jobId, status: job.status };
      }
      if (job.status !== "cancel_requested") this.transitionJob(jobId, "cancel_requested");
      return { job_id: jobId, status: "cancel_requested" };
    });
  }

  backup(destination: string): Promise<unknown> {
    return this.db.backup(destination);
  }

  private immediate<T>(fn: () => T): T {
    return withBusyRetry(() => this.db.transaction(fn).immediate());
  }

  private now(): string {
    return new Date().toISOString();
  }

  addEvent(
    jobId: string,
    type: string,
    entityType: string | null,
    entityId: string | null,
    payload: unknown,
  ): void {
    this.db
      .prepare(
        `INSERT INTO events (job_id, created_at, type, entity_type, entity_id, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(jobId, this.now(), type, entityType, entityId, JSON.stringify(payload ?? {}));
  }

  createJob(input: {
    task: string;
    repoPath: string;
    baseBranch: string;
    baseCommit?: string;
    workerCount: number;
    configProfile: string | null;
    dryRun: boolean;
    maxAttempts: number;
    maxReviewRounds: number;
  }): JobRecord {
    const id = randomUUID();
    const now = this.now();
    this.immediate(() => {
      this.db
        .prepare(
          `INSERT INTO jobs (
            id, task, repo_path, base_branch, worker_count, config_profile, status, dry_run,
            max_attempts, max_review_rounds, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'planning', ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.task,
          input.repoPath,
          input.baseBranch,
          input.workerCount,
          input.configProfile,
          input.dryRun ? 1 : 0,
          input.maxAttempts,
          input.maxReviewRounds,
          now,
          now,
        );
      this.addEvent(id, "job.created", "job", id, { status: "planning", dryRun: input.dryRun });
      this.db.prepare("UPDATE jobs SET human_goal = ? WHERE id = ?").run(input.task, id);
      if (input.baseCommit) this.pinBaseCommit(id, input.baseCommit);
    });
    return this.mustJob(id);
  }

  getJob(id: string): JobRecord | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
    return row ? mapJob(row) : null;
  }

  mustJob(id: string): JobRecord {
    const job = this.getJob(id);
    if (!job) throw new SwarmError(`Unknown job ${id}`, "not_found");
    return job;
  }

  listJobs(limit = 50): JobRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?")
      .all(limit) as JobRow[];
    return rows.map(mapJob);
  }

  transitionJob(
    id: string,
    to: JobStatus,
    patch: {
      error?: string | null;
      reviewState?: string | null;
      finalReport?: string | null;
      snapshotPath?: string | null;
      integrationBranch?: string | null;
      goal?: string | null;
      completionCriteria?: string[];
      assumptions?: string[];
      risks?: string[];
      questions?: string[];
      planJson?: string | null;
      plannerOutput?: string | null;
      reviewRound?: number;
    } = {},
  ): JobRecord {
    return this.immediate(() => {
      const current = this.mustJob(id);
      assertJobTransition(current.status, to);
      const now = this.now();
      this.db
        .prepare(
          `UPDATE jobs SET
            status = ?,
            updated_at = ?,
            error = COALESCE(?, error),
            review_state = COALESCE(?, review_state),
            final_report = COALESCE(?, final_report),
            snapshot_path = COALESCE(?, snapshot_path),
            integration_branch = COALESCE(?, integration_branch),
            goal = COALESCE(?, goal),
            completion_criteria_json = COALESCE(?, completion_criteria_json),
            assumptions_json = COALESCE(?, assumptions_json),
            risks_json = COALESCE(?, risks_json),
            questions_json = COALESCE(?, questions_json),
            plan_json = COALESCE(?, plan_json),
            planner_output = COALESCE(?, planner_output),
            review_round = COALESCE(?, review_round),
            cancel_requested_at = CASE WHEN ? = 'cancel_requested' THEN ? ELSE cancel_requested_at END,
            completed_at = CASE WHEN ? IN ('completed', 'failed', 'cancelled', 'interrupted') THEN ? ELSE completed_at END
          WHERE id = ?`,
        )
        .run(
          to,
          now,
          patch.error ?? null,
          patch.reviewState ?? null,
          patch.finalReport ?? null,
          patch.snapshotPath ?? null,
          patch.integrationBranch ?? null,
          patch.goal ?? null,
          patch.completionCriteria ? JSON.stringify(patch.completionCriteria) : null,
          patch.assumptions ? JSON.stringify(patch.assumptions) : null,
          patch.risks ? JSON.stringify(patch.risks) : null,
          patch.questions ? JSON.stringify(patch.questions) : null,
          patch.planJson ?? null,
          patch.plannerOutput ?? null,
          patch.reviewRound ?? null,
          to,
          now,
          to,
          now,
          id,
        );
      this.addEvent(id, "job.status_changed", "job", id, { from: current.status, to });
      return this.mustJob(id);
    });
  }

  insertProfiles(
    jobId: string,
    profiles: Array<{
      name: string;
      role: "planner" | "worker" | "reviewer";
      providerName: string;
      config: ProviderConfig;
      fallbacks?: Array<{ providerName: string; config: ProviderConfig }>;
      systemPrompt?: string;
    }>,
  ): void {
    const now = this.now();
    this.immediate(() => {
      const insert = this.db.prepare(
        `INSERT INTO agent_profiles (
          id, job_id, name, role, provider_type, provider_name, model, config_json,
          capabilities_json, system_prompt, created_at, fallbacks_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const profile of profiles) {
        const model = "model" in profile.config ? profile.config.model : null;
        insert.run(
          randomUUID(),
          jobId,
          profile.name,
          profile.role,
          profile.config.type,
          profile.providerName,
          model ?? null,
          JSON.stringify(profile.config),
          JSON.stringify(profile.config.capabilities),
          profile.systemPrompt ?? null,
          now,
          JSON.stringify(profile.fallbacks ?? []),
        );
      }
    });
  }

  profileForRole(jobId: string, role: "planner" | "worker" | "reviewer"): AgentProfileRecord {
    const row = this.db
      .prepare("SELECT * FROM agent_profiles WHERE job_id = ? AND role = ?")
      .get(jobId, role) as
      | {
          id: string;
          job_id: string;
          name: string;
          role: "planner" | "worker" | "reviewer";
          provider_type: string;
          provider_name: string;
          model: string | null;
          config_json: string;
          fallbacks_json: string;
          capabilities_json: string;
          system_prompt: string | null;
          created_at: string;
        }
      | undefined;
    if (!row) throw new SwarmError(`Job ${jobId} has no ${role} profile`, "not_found");
    const config = ProviderConfigSchema.parse(JSON.parse(row.config_json) as unknown);
    return {
      id: row.id,
      jobId: row.job_id,
      name: row.name,
      role: row.role,
      providerType: row.provider_type,
      providerName: row.provider_name,
      model: row.model,
      config,
      fallbacks: z
        .array(z.object({ providerName: z.string(), config: ProviderConfigSchema }))
        .parse(JSON.parse(row.fallbacks_json)),
      capabilitiesJson: row.capabilities_json,
      systemPrompt: row.system_prompt,
      createdAt: row.created_at,
    };
  }

  replacePlan(
    jobId: string,
    plan: {
      goal: string;
      completionCriteria: string[];
      assumptions: string[];
      risks: string[];
      questions: string[];
      raw: string;
    },
    tasks: PlannedTaskInput[],
    maxAttempts: number,
  ): void {
    this.immediate(() => {
      const now = this.now();
      const ids = new Map<string, string>();
      const insertTask = this.db.prepare(
        `INSERT INTO tasks (
          id, job_id, stable_id, title, instructions, acceptance_criteria_json, suggested_role,
          file_areas_json, verification_checks_json, status, kind, attempt_count, max_attempts, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'implementation', 0, ?, ?, ?)`,
      );
      for (const task of tasks) {
        const id = randomUUID();
        ids.set(task.stableId, id);
        const status: TaskStatus = task.dependencies.length === 0 ? "ready" : "blocked";
        insertTask.run(
          id,
          jobId,
          task.stableId,
          task.title,
          task.instructions,
          JSON.stringify(task.acceptanceCriteria),
          task.suggestedRole ?? null,
          JSON.stringify(task.fileAreas),
          task.verificationChecks === undefined ? null : JSON.stringify(task.verificationChecks),
          status,
          maxAttempts,
          now,
          now,
        );
        this.addEvent(jobId, "task.created", "task", id, { stableId: task.stableId, status });
      }
      const insertDep = this.db.prepare(
        `INSERT INTO task_dependencies (job_id, task_id, depends_on_task_id) VALUES (?, ?, ?)`,
      );
      for (const task of tasks) {
        const taskId = ids.get(task.stableId);
        if (!taskId) continue;
        for (const dependency of task.dependencies) {
          const dependsOn = ids.get(dependency);
          if (!dependsOn) {
            throw new SwarmError(`Missing dependency ${dependency}`, "bad_plan");
          }
          insertDep.run(jobId, taskId, dependsOn);
        }
      }
      this.db
        .prepare(
          `UPDATE jobs SET
            goal = ?, completion_criteria_json = ?, assumptions_json = ?, risks_json = ?,
            questions_json = ?, plan_json = ?, planner_output = ?, updated_at = ?
          WHERE id = ?`,
        )
        .run(
          plan.goal,
          JSON.stringify(plan.completionCriteria),
          JSON.stringify(plan.assumptions),
          JSON.stringify(plan.risks),
          JSON.stringify(plan.questions),
          plan.raw,
          plan.raw,
          now,
          jobId,
        );
      this.addEvent(jobId, "plan.accepted", "job", jobId, { tasks: tasks.length });
    });
  }

  listTasks(jobId: string): TaskRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE job_id = ? ORDER BY created_at, stable_id")
      .all(jobId) as TaskRow[];
    return rows.map(mapTask);
  }

  getTask(id: string): TaskRecord | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
    return row ? mapTask(row) : null;
  }

  taskCounts(jobId: string): Record<TaskStatus, number> {
    const counts = emptyTaskCounts();
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS count FROM tasks WHERE job_id = ? GROUP BY status")
      .all(jobId) as Array<{ status: TaskStatus; count: number }>;
    for (const row of rows) counts[row.status] = row.count;
    return counts;
  }

  private refreshReadyUnlocked(jobId: string): void {
    const tasks = this.listTasks(jobId).filter((task) => task.status === "blocked");
    const byId = new Map(this.listTasks(jobId).map((task) => [task.id, task]));
    const now = this.now();
    for (const task of tasks) {
      const deps = this.dependencyIds(task.id);
      const satisfied = deps.every((id) => {
        const dep = byId.get(id);
        return dep ? dependencySatisfied(dep.status) : false;
      });
      if (!satisfied) continue;
      const current = this.getTask(task.id);
      if (!current || current.status !== "blocked") continue;
      assertTaskTransition(current.status, "ready");
      this.db
        .prepare(
          "UPDATE tasks SET status = 'ready', updated_at = ? WHERE id = ? AND status = 'blocked'",
        )
        .run(now, task.id);
      this.addEvent(jobId, "task.status_changed", "task", task.id, {
        from: "blocked",
        to: "ready",
      });
    }
  }

  private dependencyIds(taskId: string): string[] {
    const rows = this.db
      .prepare("SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?")
      .all(taskId) as Array<{ depends_on_task_id: string }>;
    return rows.map((row) => row.depends_on_task_id);
  }

  dependencyMap(jobId: string): Map<string, string[]> {
    const rows = this.db
      .prepare("SELECT task_id, depends_on_task_id FROM task_dependencies WHERE job_id = ?")
      .all(jobId) as Array<{ task_id: string; depends_on_task_id: string }>;
    const map = new Map<string, string[]>();
    for (const row of rows) {
      const list = map.get(row.task_id) ?? [];
      list.push(row.depends_on_task_id);
      map.set(row.task_id, list);
    }
    return map;
  }

  claimReady(jobId: string, limit: number, profileId: string): Claim[] {
    return this.immediate(() => {
      this.refreshReadyUnlocked(jobId);
      const claims: Claim[] = [];
      for (let index = 0; index < limit; index += 1) {
        const row = this.db
          .prepare(
            `SELECT * FROM tasks WHERE job_id = ? AND status = 'ready'
             ORDER BY created_at, stable_id LIMIT 1`,
          )
          .get(jobId) as TaskRow | undefined;
        if (!row) break;
        const now = this.now();
        const updated = this.db
          .prepare(
            `UPDATE tasks
             SET status = 'running', attempt_count = attempt_count + 1, updated_at = ?
             WHERE id = ? AND status = 'ready'`,
          )
          .run(now, row.id);
        if (updated.changes !== 1) continue;
        const attempt = row.attempt_count + 1;
        const runId = randomUUID();
        this.db
          .prepare(
            `INSERT INTO agent_runs (
              id, job_id, task_id, agent_profile_id, role, attempt, status, created_at
            ) VALUES (?, ?, ?, ?, 'worker', ?, 'queued', ?)`,
          )
          .run(runId, jobId, row.id, profileId, attempt, now);
        this.db
          .prepare("UPDATE agent_runs SET status = 'running', started_at = ? WHERE id = ?")
          .run(now, runId);
        this.addEvent(jobId, "task.claimed", "task", row.id, { runId, attempt });
        this.addEvent(jobId, "run.started", "run", runId, { taskId: row.id, attempt });
        const task = this.getTask(row.id);
        const run = this.getRun(runId);
        if (!task || !run) continue;
        claims.push({ task, run });
      }
      return claims;
    });
  }

  private getRun(id: string): RunRecord | null {
    const row = this.db.prepare("SELECT * FROM agent_runs WHERE id = ?").get(id) as
      | {
          id: string;
          job_id: string;
          task_id: string | null;
          agent_profile_id: string | null;
          role: string;
          attempt: number;
          status: RunStatus;
          provider_name: string | null;
          model: string | null;
          worktree_path: string | null;
          branch_name: string | null;
          base_commit: string | null;
          head_commit: string | null;
          output_summary: string | null;
          error: string | null;
          started_at: string | null;
          finished_at: string | null;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      jobId: row.job_id,
      taskId: row.task_id,
      agentProfileId: row.agent_profile_id,
      role: row.role,
      attempt: row.attempt,
      status: row.status,
      providerName: row.provider_name,
      model: row.model,
      worktreePath: row.worktree_path,
      branchName: row.branch_name,
      baseCommit: row.base_commit,
      headCommit: row.head_commit,
      outputSummary: row.output_summary,
      error: row.error,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      createdAt: row.created_at,
    };
  }

  listRuns(jobId: string): RunRecord[] {
    const rows = this.db
      .prepare("SELECT id FROM agent_runs WHERE job_id = ? ORDER BY created_at")
      .all(jobId) as Array<{ id: string }>;
    return rows.flatMap((row) => {
      const run = this.getRun(row.id);
      return run ? [run] : [];
    });
  }

  activeRuns(jobId: string): RunRecord[] {
    return this.listRuns(jobId).filter(
      (run) => run.status === "running" || run.status === "queued",
    );
  }

  attachWorkspace(
    runId: string,
    workspace: { path: string; branch: string; baseCommit: string },
  ): void {
    this.immediate(() => {
      const now = this.now();
      this.db
        .prepare(
          `UPDATE agent_runs
           SET worktree_path = ?, branch_name = ?, base_commit = ?
           WHERE id = ?`,
        )
        .run(workspace.path, workspace.branch, workspace.baseCommit, runId);
      const run = this.getRun(runId);
      if (!run) return;
      this.db
        .prepare(
          `INSERT INTO worktrees (
            id, job_id, task_id, run_id, path, branch_name, base_commit, cleanup_state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(
          randomUUID(),
          run.jobId,
          run.taskId,
          runId,
          workspace.path,
          workspace.branch,
          workspace.baseCommit,
          now,
          now,
        );
      this.addEvent(run.jobId, "git.worktree_created", "run", runId, {
        path: workspace.path,
        branch: workspace.branch,
      });
    });
  }

  finishRun(input: {
    runId: string;
    taskId: string;
    runStatus: RunStatus;
    taskStatus: TaskStatus;
    summary?: string | null;
    error?: string | null;
    headCommit?: string | null;
    providerName?: string | null;
    model?: string | null;
    requeue: boolean;
  }): void {
    this.immediate(() => {
      const task = this.getTask(input.taskId);
      const run = this.getRun(input.runId);
      if (!task || !run) throw new SwarmError("Missing task or run", "not_found");
      const now = this.now();
      const nextTaskStatus: TaskStatus = input.requeue ? "ready" : input.taskStatus;
      assertTaskTransition(task.status, nextTaskStatus);
      this.db
        .prepare(
          `UPDATE agent_runs SET
            status = ?, finished_at = ?, output_summary = COALESCE(?, output_summary),
            error = COALESCE(?, error), head_commit = COALESCE(?, head_commit),
            provider_name = COALESCE(?, provider_name), model = COALESCE(?, model)
          WHERE id = ?`,
        )
        .run(
          input.runStatus,
          now,
          input.summary ?? null,
          input.error ?? null,
          input.headCommit ?? null,
          input.providerName ?? null,
          input.model ?? null,
          input.runId,
        );
      this.db
        .prepare(
          `UPDATE tasks SET status = ?, updated_at = ?, result_summary = COALESCE(?, result_summary),
           error = CASE WHEN ? = 'succeeded' THEN NULL ELSE COALESCE(?, error) END WHERE id = ?`,
        )
        .run(
          nextTaskStatus,
          now,
          input.summary ?? null,
          input.runStatus,
          input.error ?? null,
          input.taskId,
        );
      if (input.headCommit) {
        this.db
          .prepare("UPDATE worktrees SET head_commit = ?, updated_at = ? WHERE run_id = ?")
          .run(input.headCommit, now, input.runId);
      }
      this.addEvent(task.jobId, "run.finished", "run", input.runId, {
        status: input.runStatus,
        taskStatus: nextTaskStatus,
      });
      this.addEvent(task.jobId, "task.status_changed", "task", input.taskId, {
        from: task.status,
        to: nextTaskStatus,
      });
    });
  }

  diagnose(jobId: string): { deadlock: boolean; message: string; failedDependents: number } {
    return this.immediate(() => {
      this.refreshReadyUnlocked(jobId);
      let failedDependents = 0;
      let changed = true;
      while (changed) {
        changed = false;
        for (const task of this.listTasks(jobId).filter((item) => item.status === "blocked")) {
          const deps = this.dependencyIds(task.id)
            .map((id) => this.getTask(id))
            .filter((item): item is TaskRecord => item !== null);
          const bad = deps.filter((dep) => dep.status === "failed" || dep.status === "cancelled");
          const waiting = deps.filter(
            (dep) => !dependencySatisfied(dep.status) && !bad.includes(dep),
          );
          if (bad.length > 0 && waiting.length === 0) {
            assertTaskTransition(task.status, "failed");
            this.db
              .prepare(
                "UPDATE tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status = 'blocked'",
              )
              .run("A dependency failed or was cancelled", this.now(), task.id);
            this.addEvent(jobId, "task.status_changed", "task", task.id, {
              from: "blocked",
              to: "failed",
              reason: "dependency",
            });
            failedDependents += 1;
            changed = true;
          }
        }
      }
      const counts = this.taskCounts(jobId);
      const deadlock = counts.blocked > 0 && counts.ready === 0 && counts.running === 0;
      const message = deadlock
        ? `Every remaining task is blocked (${counts.blocked} blocked, ${failedDependents} failed through dependencies).`
        : "";
      if (deadlock) this.addEvent(jobId, "scheduler.deadlock", "job", jobId, { counts });
      return { deadlock, message, failedDependents };
    });
  }

  createRevisionTask(input: {
    jobId: string;
    title: string;
    instructions: string;
    acceptanceCriteria: string[];
    maxAttempts: number;
  }): TaskRecord {
    return this.immediate(() => {
      const now = this.now();
      const round = this.listReviews(input.jobId).length + 1;
      const id = randomUUID();
      const stableId = `revision-${round}`;
      this.db
        .prepare(
          `UPDATE tasks SET status = 'revision', updated_at = ?
           WHERE job_id = ? AND status = 'review'`,
        )
        .run(now, input.jobId);
      this.db
        .prepare(
          `INSERT INTO tasks (
            id, job_id, stable_id, title, instructions, acceptance_criteria_json, suggested_role,
            file_areas_json, status, kind, attempt_count, max_attempts, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'worker', '[]', 'ready', 'revision', 0, ?, ?, ?)`,
        )
        .run(
          id,
          input.jobId,
          stableId,
          input.title,
          input.instructions,
          JSON.stringify(input.acceptanceCriteria),
          input.maxAttempts,
          now,
          now,
        );
      this.addEvent(input.jobId, "task.created", "task", id, { stableId, kind: "revision" });
      const task = this.getTask(id);
      if (!task) throw new SwarmError("Revision task was not persisted", "internal");
      return task;
    });
  }

  markAccepted(jobId: string): void {
    this.immediate(() => {
      const now = this.now();
      const tasks = this.listTasks(jobId).filter(
        (task) => task.status === "review" || task.status === "revision",
      );
      for (const task of tasks) {
        assertTaskTransition(task.status, "done");
        this.db
          .prepare("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?")
          .run(now, task.id);
        this.addEvent(jobId, "task.status_changed", "task", task.id, {
          from: task.status,
          to: "done",
        });
      }
    });
  }

  cancelOutstanding(jobId: string): void {
    this.immediate(() => {
      const now = this.now();
      const runs = this.activeRuns(jobId);
      for (const run of runs) {
        this.db
          .prepare(
            "UPDATE agent_runs SET status = 'cancelled', finished_at = ?, error = COALESCE(error, ?) WHERE id = ?",
          )
          .run(now, "cancelled", run.id);
        this.addEvent(jobId, "run.finished", "run", run.id, { status: "cancelled" });
      }
      for (const task of this.listTasks(jobId)) {
        if (task.status !== "running" && task.status !== "ready" && task.status !== "blocked")
          continue;
        assertTaskTransition(task.status, "cancelled");
        this.db
          .prepare(
            "UPDATE tasks SET status = 'cancelled', updated_at = ?, error = COALESCE(error, ?) WHERE id = ?",
          )
          .run(now, "cancelled", task.id);
        this.addEvent(jobId, "task.status_changed", "task", task.id, {
          from: task.status,
          to: "cancelled",
        });
      }
    });
  }

  recoverInterrupted(): { jobs: number; runs: number; tasks: number } {
    return this.immediate(() => {
      const now = this.now();
      const chats = this.db
        .prepare("SELECT id FROM planner_chats WHERE status='pending'")
        .all() as Array<{ id: string }>;
      for (const chat of chats)
        this.finishPlannerChat(
          chat.id,
          "failed",
          "The service restarted before the planner replied. Your message is saved; you can retry it.",
        );
      const runs = this.db
        .prepare("SELECT id, job_id FROM agent_runs WHERE status IN ('queued', 'running')")
        .all() as Array<{ id: string; job_id: string }>;
      for (const run of runs) {
        this.db
          .prepare(
            "UPDATE agent_runs SET status = 'interrupted', finished_at = ?, error = COALESCE(error, ?) WHERE id = ?",
          )
          .run(now, "scheduler restarted before the run finished", run.id);
        this.addEvent(run.job_id, "run.interrupted", "run", run.id, {});
      }
      const tasks = this.db
        .prepare("SELECT * FROM tasks WHERE status = 'running'")
        .all() as TaskRow[];
      for (const task of tasks) {
        const next: TaskStatus = task.attempt_count < task.max_attempts ? "ready" : "failed";
        const error =
          next === "failed" ? "interrupted after the maximum number of attempts" : task.error;
        this.db
          .prepare("UPDATE tasks SET status = ?, updated_at = ?, error = ? WHERE id = ?")
          .run(next, now, error, task.id);
        this.addEvent(task.job_id, "task.status_changed", "task", task.id, {
          from: "running",
          to: next,
          reason: "interrupted",
        });
      }
      const jobs = this.db
        .prepare(
          "SELECT id, status FROM jobs WHERE status IN ('planning', 'running', 'review', 'cancel_requested')",
        )
        .all() as Array<{ id: string; status: JobStatus }>;
      for (const job of jobs) {
        assertJobTransition(job.status, "interrupted");
        this.db
          .prepare(
            `UPDATE jobs SET status = 'interrupted', updated_at = ?, completed_at = ?,
             error = COALESCE(error, ?) WHERE id = ?`,
          )
          .run(now, now, "scheduler stopped before the job finished", job.id);
        this.addEvent(job.id, "job.interrupted", "job", job.id, { from: job.status });
      }
      return { jobs: jobs.length, runs: runs.length, tasks: tasks.length };
    });
  }

  postMessage(input: {
    jobId: string;
    sender: string;
    role: string;
    channel?: string;
    messageType: MessageType;
    content: string;
    taskId?: string | null;
    decisionId?: string | null;
    maxChars: number;
  }): MessageRecord {
    const content =
      input.content.length > input.maxChars
        ? `${input.content.slice(0, input.maxChars)}\n[truncated]`
        : input.content;
    const id = randomUUID();
    const now = this.now();
    this.immediate(() => {
      this.db
        .prepare(
          `INSERT INTO messages (
            id, job_id, sender, role, channel, message_type, task_id, decision_id, content, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.jobId,
          input.sender,
          input.role,
          input.channel ?? "general",
          input.messageType,
          input.taskId ?? null,
          input.decisionId ?? null,
          content,
          now,
        );
      this.addEvent(input.jobId, "message.posted", "message", id, {
        sender: input.sender,
        type: input.messageType,
        channel: input.channel ?? "general",
      });
    });
    return this.mustMessage(id);
  }

  beginPlannerChat(jobId: string, message: string, maxChars: number): PlannerChatRecord {
    return this.immediate(() => {
      this.mustJob(jobId);
      if (
        this.db
          .prepare("SELECT 1 FROM planner_chats WHERE job_id=? AND status='pending'")
          .get(jobId)
      )
        throw new SwarmError(
          "The planner is already considering a message for this mission",
          "chat_busy",
        );
      const id = randomUUID(),
        now = this.now();
      this.db
        .prepare(
          "INSERT INTO planner_chats(id,job_id,message,status,started_at) VALUES(?,?,?,'pending',?)",
        )
        .run(id, jobId, message, now);
      this.postMessage({
        jobId,
        sender: "mcp-client",
        role: "caller",
        channel: "planning",
        messageType: "chat",
        content: message,
        maxChars,
      });
      this.addEvent(jobId, "planner.chat_started", "planner_chat", id, {});
      return {
        id,
        jobId,
        message,
        status: "pending",
        error: null,
        startedAt: now,
        finishedAt: null,
      };
    });
  }

  latestPlannerChat(jobId: string): PlannerChatRecord | null {
    return (
      (this.db
        .prepare(
          "SELECT id,job_id AS jobId,message,status,error,started_at AS startedAt,finished_at AS finishedAt FROM planner_chats WHERE job_id=? ORDER BY rowid DESC LIMIT 1",
        )
        .get(jobId) as PlannerChatRecord | undefined) ?? null
    );
  }

  finishPlannerChat(id: string, status: "completed" | "failed", error?: string): void {
    this.immediate(() => {
      const row = this.db
        .prepare("SELECT job_id FROM planner_chats WHERE id=? AND status='pending'")
        .get(id) as { job_id: string } | undefined;
      if (!row) return;
      this.db
        .prepare("UPDATE planner_chats SET status=?,error=?,finished_at=? WHERE id=?")
        .run(status, error ?? null, this.now(), id);
      this.addEvent(row.job_id, `planner.chat_${status}`, "planner_chat", id, { error });
      if (status === "failed")
        this.postMessage({
          jobId: row.job_id,
          sender: "coordinator",
          role: "system",
          channel: "planning",
          messageType: "finding",
          content: `The planner could not answer this message. ${error ?? "The provider failed."}\nYour message is saved. You can retry when the planner is available.`,
          maxChars: 2400,
        });
    });
  }

  planningMessages(jobId: string, limit = 50): MessageRecord[] {
    const rows = this.db
      .prepare(
        "SELECT id FROM messages WHERE job_id=? AND channel='planning' ORDER BY created_at DESC,rowid DESC LIMIT ?",
      )
      .all(jobId, limit) as Array<{ id: string }>;
    return rows.reverse().map((row) => this.mustMessage(row.id));
  }

  listMessages(jobId: string, limit = 100): MessageRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE job_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(jobId, limit) as Array<{
      id: string;
      job_id: string;
      sender: string;
      role: string;
      channel: string;
      message_type: MessageType;
      task_id: string | null;
      decision_id: string | null;
      content: string;
      created_at: string;
    }>;
    return rows.reverse().map((row) => ({
      id: row.id,
      jobId: row.job_id,
      sender: row.sender,
      role: row.role,
      channel: row.channel,
      messageType: row.message_type,
      taskId: row.task_id,
      decisionId: row.decision_id,
      content: row.content,
      createdAt: row.created_at,
    }));
  }

  private mustMessage(id: string): MessageRecord {
    const message = this.listMessagesById(id);
    if (!message) throw new SwarmError(`Unknown message ${id}`, "not_found");
    return message;
  }

  private listMessagesById(id: string): MessageRecord | null {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as
      | {
          id: string;
          job_id: string;
          sender: string;
          role: string;
          channel: string;
          message_type: MessageType;
          task_id: string | null;
          decision_id: string | null;
          content: string;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      jobId: row.job_id,
      sender: row.sender,
      role: row.role,
      channel: row.channel,
      messageType: row.message_type,
      taskId: row.task_id,
      decisionId: row.decision_id,
      content: row.content,
      createdAt: row.created_at,
    };
  }

  createDecision(input: {
    blocking?: boolean;
    jobId: string;
    question: string;
    context?: string;
    options: string[];
    proposer: string;
    policy: "owner" | "majority" | "unanimous";
    quorum: number;
    ownerRole: string;
    deadline?: string;
  }): DecisionRecord {
    if (input.options.length < 2) {
      throw new SwarmError("A decision needs at least two options", "bad_decision");
    }
    const id = randomUUID();
    const now = this.now();
    this.immediate(() => {
      this.db
        .prepare(
          `INSERT INTO decisions (
            id, job_id, question, context, options_json, proposer, status, deadline,
            resolution_policy, quorum, owner_role, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.jobId,
          input.question,
          input.context ?? null,
          JSON.stringify(input.options),
          input.proposer,
          input.deadline ?? null,
          input.policy,
          input.quorum,
          input.ownerRole,
          now,
        );
      this.addEvent(input.jobId, "decision.opened", "decision", id, { question: input.question });
      if (input.blocking) this.db.prepare("UPDATE decisions SET blocking = 1 WHERE id = ?").run(id);
    });
    return this.mustDecision(id);
  }

  listDecisions(jobId: string): DecisionRecord[] {
    const rows = this.db
      .prepare("SELECT id FROM decisions WHERE job_id = ? ORDER BY created_at")
      .all(jobId) as Array<{ id: string }>;
    return rows.map((row) => this.mustDecision(row.id));
  }

  getDecision(id: string): DecisionRecord | null {
    const row = this.db.prepare("SELECT * FROM decisions WHERE id = ?").get(id) as
      | {
          id: string;
          job_id: string;
          question: string;
          context: string | null;
          options_json: string;
          proposer: string;
          status: "open" | "resolved";
          deadline: string | null;
          resolution_policy: "owner" | "majority" | "unanimous";
          quorum: number;
          owner_role: string;
          blocking: number;
          final_option: string | null;
          final_rationale: string | null;
          created_at: string;
          resolved_at: string | null;
          resolved_by: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      jobId: row.job_id,
      question: row.question,
      context: row.context,
      options: strings(row.options_json),
      proposer: row.proposer,
      status: row.status,
      deadline: row.deadline,
      resolutionPolicy: row.resolution_policy,
      quorum: row.quorum,
      ownerRole: row.owner_role,
      blocking: row.blocking === 1,
      finalOption: row.final_option,
      finalRationale: row.final_rationale,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
      resolvedBy: row.resolved_by,
      votes: this.listVotes(row.id),
    };
  }

  mustDecision(id: string): DecisionRecord {
    const decision = this.getDecision(id);
    if (!decision) throw new SwarmError(`Unknown decision ${id}`, "not_found");
    return decision;
  }

  listVotes(decisionId: string): VoteRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM votes WHERE decision_id = ? ORDER BY created_at")
      .all(decisionId) as Array<{
      id: string;
      decision_id: string;
      voter: string;
      option_value: string;
      rationale: string | null;
      created_at: string;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      decisionId: row.decision_id,
      voter: row.voter,
      option: row.option_value,
      rationale: row.rationale,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  upsertVote(input: {
    decisionId: string;
    voter: string;
    option: string;
    rationale?: string;
  }): VoteRecord {
    return this.immediate(() => {
      const decision = this.mustDecision(input.decisionId);
      if (decision.status !== "open") {
        throw new SwarmError("Decision is already resolved", "closed_decision");
      }
      if (!decision.options.includes(input.option)) {
        throw new SwarmError(`Option is not one of: ${decision.options.join(", ")}`, "bad_vote");
      }
      const existing = decision.votes.find((vote) => vote.voter === input.voter);
      const now = this.now();
      if (existing) {
        this.db
          .prepare("UPDATE votes SET option_value = ?, rationale = ?, updated_at = ? WHERE id = ?")
          .run(input.option, input.rationale ?? null, now, existing.id);
      } else {
        this.db
          .prepare(
            `INSERT INTO votes (id, decision_id, voter, option_value, rationale, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            input.decisionId,
            input.voter,
            input.option,
            input.rationale ?? null,
            now,
            now,
          );
      }
      this.addEvent(decision.jobId, "decision.voted", "decision", decision.id, {
        voter: input.voter,
        option: input.option,
        replaced: Boolean(existing),
        previous: existing?.option ?? null,
      });
      this.maybeAutoResolve(decision.id);
      const vote = this.listVotes(input.decisionId).find((item) => item.voter === input.voter);
      if (!vote) throw new SwarmError("Vote was not persisted", "internal");
      return vote;
    });
  }

  private maybeAutoResolve(decisionId: string): void {
    const decision = this.mustDecision(decisionId);
    if (decision.status !== "open" || decision.resolutionPolicy === "owner") return;
    if (decision.votes.length < decision.quorum) return;
    const counts = new Map<string, number>();
    for (const vote of decision.votes) {
      counts.set(vote.option, (counts.get(vote.option) ?? 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const top = ranked[0];
    if (!top) return;
    if (decision.resolutionPolicy === "unanimous") {
      if (ranked.length === 1) {
        this.resolveUnlocked(
          decision,
          top[0],
          `Unanimous among ${decision.votes.length} votes.`,
          "policy:unanimous",
        );
      }
      return;
    }
    if (top[1] > decision.votes.length / 2) {
      this.resolveUnlocked(
        decision,
        top[0],
        `Majority ${top[1]} of ${decision.votes.length} votes.`,
        "policy:majority",
      );
    }
  }

  resolveDecision(input: {
    decisionId: string;
    option: string;
    rationale: string;
    actor: string;
    actorRole: string;
  }): DecisionRecord {
    return this.immediate(() => {
      const decision = this.mustDecision(input.decisionId);
      if (decision.status !== "open") {
        throw new SwarmError("Decision is already resolved", "closed_decision");
      }
      if (decision.resolutionPolicy === "owner" && input.actorRole !== decision.ownerRole) {
        throw new SwarmError(
          `Only the ${decision.ownerRole} can resolve this decision. Votes do not approve it on their own.`,
          "forbidden",
        );
      }
      if (!decision.options.includes(input.option)) {
        throw new SwarmError(
          `Option is not one of: ${decision.options.join(", ")}`,
          "bad_decision",
        );
      }
      this.resolveUnlocked(decision, input.option, input.rationale, input.actor);
      if (input.option === "stop_job") this.requestCancel(decision.jobId);
      const blocker = this.listBlockers(decision.jobId).find(
        (item) => item.decisionId === decision.id,
      );
      if (blocker) {
        if (input.option === "stop_job") this.requestCancel(decision.jobId);
        else if (blocker.taskId)
          this.grantRecoveryAttempt(blocker.taskId, `Human guidance: ${input.rationale}`);
        this.updateBlocker(blocker.id, {
          status: "resolved",
          resolution: `${input.option}: ${input.rationale}`,
          nextAction:
            input.option === "stop_job" ? "Cancellation requested" : "Retry with caller guidance",
        });
      }
      return this.mustDecision(input.decisionId);
    });
  }

  private resolveUnlocked(
    decision: DecisionRecord,
    option: string,
    rationale: string,
    actor: string,
  ): void {
    const now = this.now();
    this.db
      .prepare(
        `UPDATE decisions SET status = 'resolved', final_option = ?, final_rationale = ?,
         resolved_at = ?, resolved_by = ? WHERE id = ?`,
      )
      .run(option, rationale, now, actor, decision.id);
    this.addEvent(decision.jobId, "decision.resolved", "decision", decision.id, {
      option,
      rationale,
      actor,
    });
  }

  insertReview(input: {
    jobId: string;
    round: number;
    status: "approved" | "rejected";
    summary: string;
    findingsJson: string;
  }): ReviewRecord {
    const id = randomUUID();
    const now = this.now();
    this.immediate(() => {
      this.db
        .prepare(
          `INSERT INTO reviews (id, job_id, round, status, summary, findings_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.jobId, input.round, input.status, input.summary, input.findingsJson, now);
      this.addEvent(input.jobId, "review.recorded", "review", id, {
        round: input.round,
        status: input.status,
      });
    });
    const review = this.listReviews(input.jobId).find((item) => item.id === id);
    if (!review) throw new SwarmError("Review was not persisted", "internal");
    return review;
  }

  listReviews(jobId: string): ReviewRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM reviews WHERE job_id = ? ORDER BY round")
      .all(jobId) as Array<{
      id: string;
      job_id: string;
      round: number;
      status: "approved" | "rejected";
      summary: string;
      findings_json: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      jobId: row.job_id,
      round: row.round,
      status: row.status,
      summary: row.summary,
      findingsJson: row.findings_json,
      createdAt: row.created_at,
    }));
  }

  listEvents(jobId: string, limit = 20): EventRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE job_id = ? ORDER BY id DESC LIMIT ?")
      .all(jobId, limit) as Array<{
      id: number;
      job_id: string;
      created_at: string;
      type: string;
      entity_type: string | null;
      entity_id: string | null;
      payload_json: string;
    }>;
    return rows.reverse().map((row) => ({
      id: row.id,
      jobId: row.job_id,
      createdAt: row.created_at,
      type: row.type,
      entityType: row.entity_type,
      entityId: row.entity_id,
      payload: JSON.parse(row.payload_json) as unknown,
    }));
  }

  insertArtifact(input: {
    jobId: string;
    taskId?: string | null;
    runId?: string | null;
    kind: string;
    path?: string | null;
    summary: string;
  }): ArtifactRecord {
    const id = randomUUID();
    const now = this.now();
    let summary = input.summary;
    if (
      ["checks", "task-checks", "dependency-checks"].includes(input.kind) &&
      summary.length > 8000
    ) {
      const parsed = JSON.parse(summary) as Record<string, unknown>;
      if (!parsed || Array.isArray(parsed) || typeof parsed.summary !== "string")
        throw new SwarmError("Check evidence requires a diagnostic summary", "bad_artifact");
      const diagnostic = parsed.summary;
      const metadata = { ...parsed, summary: "", truncated: true };
      if (JSON.stringify(metadata).length > 8000)
        throw new SwarmError("Check evidence metadata exceeds the artifact limit", "bad_artifact");
      let lower = 0;
      let upper = diagnostic.length;
      while (lower < upper) {
        const limit = Math.ceil((lower + upper) / 2);
        const candidate = JSON.stringify({ ...metadata, summary: diagnostic.slice(0, limit) });
        if (candidate.length <= 8000) lower = limit;
        else upper = limit - 1;
      }
      summary = JSON.stringify({ ...metadata, summary: diagnostic.slice(0, lower) });
    } else summary = summary.slice(0, 8000);
    this.db
      .prepare(
        `INSERT INTO artifacts (id, job_id, task_id, run_id, kind, path, summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.jobId,
        input.taskId ?? null,
        input.runId ?? null,
        input.kind,
        input.path ?? null,
        summary,
        now,
      );
    return {
      id,
      jobId: input.jobId,
      taskId: input.taskId ?? null,
      runId: input.runId ?? null,
      kind: input.kind,
      path: input.path ?? null,
      summary,
      createdAt: now,
    };
  }

  listArtifacts(jobId: string): ArtifactRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM artifacts WHERE job_id = ? ORDER BY created_at")
      .all(jobId) as Array<{
      id: string;
      job_id: string;
      task_id: string | null;
      run_id: string | null;
      kind: string;
      path: string | null;
      summary: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      jobId: row.job_id,
      taskId: row.task_id,
      runId: row.run_id,
      kind: row.kind,
      path: row.path,
      summary: row.summary,
      createdAt: row.created_at,
    }));
  }

  listWorktrees(jobId: string): WorktreeRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM worktrees WHERE job_id = ? ORDER BY created_at")
      .all(jobId) as Array<{
      id: string;
      job_id: string;
      task_id: string | null;
      run_id: string | null;
      path: string;
      branch_name: string;
      base_commit: string | null;
      head_commit: string | null;
      cleanup_state: "active" | "preserved" | "removed";
      created_at: string;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      jobId: row.job_id,
      taskId: row.task_id,
      runId: row.run_id,
      path: row.path,
      branchName: row.branch_name,
      baseCommit: row.base_commit,
      headCommit: row.head_commit,
      cleanupState: row.cleanup_state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  setWorktreeState(
    id: string,
    state: "active" | "preserved" | "removed",
    headCommit?: string | null,
  ): void {
    this.db
      .prepare(
        "UPDATE worktrees SET cleanup_state = ?, head_commit = COALESCE(?, head_commit), updated_at = ? WHERE id = ?",
      )
      .run(state, headCommit ?? null, this.now(), id);
  }

  setSnapshotPath(jobId: string, snapshotPath: string): void {
    this.db
      .prepare("UPDATE jobs SET snapshot_path = ?, updated_at = ? WHERE id = ?")
      .run(snapshotPath, this.now(), jobId);
  }

  resumeJob(jobId: string): JobRecord {
    return this.immediate(() => {
      const job = this.mustJob(jobId);
      if (!["failed", "interrupted", "cancelled"].includes(job.status)) {
        throw new SwarmError(`Cannot resume a ${job.status} job`, "bad_state");
      }
      if (this.activeRuns(jobId).length)
        throw new SwarmError("Job still has active runs", "bad_state");
      for (const task of this.listTasks(jobId)) {
        if (!["failed", "cancelled"].includes(task.status)) continue;
        this.db
          .prepare(
            `UPDATE tasks SET status = 'blocked', max_attempts = attempt_count + ?, error = NULL, updated_at = ? WHERE id = ?`,
          )
          .run(job.maxAttempts, this.now(), task.id);
      }
      const status = this.listTasks(jobId).length ? "running" : "planning";
      this.db
        .prepare(
          `UPDATE jobs SET status = ?, error = NULL, final_report = NULL, completed_at = NULL,
        cancel_requested_at = NULL, max_review_rounds = review_round + ?, review_state = 'pending', updated_at = ? WHERE id = ?`,
        )
        .run(status, job.maxReviewRounds, this.now(), jobId);
      this.refreshReadyUnlocked(jobId);
      this.addEvent(jobId, "job.resumed", "job", jobId, { from: job.status, status });
      return this.mustJob(jobId);
    });
  }

  activatePlan(jobId: string): void {
    const job = this.mustJob(jobId);
    if (!job.dryRun || job.status !== "completed" || !this.listTasks(jobId).length)
      throw new SwarmError("Only a completed dry-run plan can be launched", "bad_state");
    this.db
      .prepare(
        "UPDATE jobs SET status='running', dry_run=0, error=NULL, final_report=NULL, completed_at=NULL, review_state='pending', updated_at=? WHERE id=?",
      )
      .run(this.now(), jobId);
    this.addEvent(jobId, "plan.launched", "job", jobId, {});
  }

  recordDelegation(input: Omit<DelegationRecord, "id" | "createdAt">): DelegationRecord {
    const record: DelegationRecord = { ...input, id: randomUUID(), createdAt: this.now() };
    this.db
      .prepare(
        `INSERT INTO delegations (id, agent, provider, model, prompt_chars, context_chars, output_chars,
          input_tokens, output_tokens, duration_ms, failover_json, error, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.agent,
        record.provider,
        record.model,
        record.promptChars,
        record.contextChars,
        record.outputChars,
        record.inputTokens,
        record.outputTokens,
        Math.round(record.durationMs),
        JSON.stringify(record.failover),
        record.error,
        record.createdAt,
      );
    return record;
  }

  listDelegations(limit = 50): DelegationRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM delegations ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Array<Record<string, string | number | null>>;
    return rows.map((row) => ({
      id: String(row.id),
      agent: String(row.agent),
      provider: row.provider === null ? null : String(row.provider),
      model: row.model === null ? null : String(row.model),
      promptChars: Number(row.prompt_chars),
      contextChars: Number(row.context_chars),
      outputChars: Number(row.output_chars),
      inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
      outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
      durationMs: Number(row.duration_ms),
      failover: JSON.parse(String(row.failover_json)) as DelegationRecord["failover"],
      error: row.error === null ? null : String(row.error),
      createdAt: String(row.created_at),
    }));
  }

  delegationTotals(): {
    count: number;
    contextChars: number;
    inputTokens: number;
    outputTokens: number;
  } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(context_chars), 0) AS context_chars,
          COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens
        FROM delegations WHERE error IS NULL`,
      )
      .get() as {
      count: number;
      context_chars: number;
      input_tokens: number;
      output_tokens: number;
    };
    return {
      count: row.count,
      contextChars: row.context_chars,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
    };
  }

  recordProviderCall(input: {
    jobId: string;
    taskId?: string;
    role: string;
    provider: string;
    model?: string;
    durationMs: number;
    usage?: ProviderUsage;
    error?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO provider_calls (job_id, task_id, role, provider, model, duration_ms, input_tokens, output_tokens, total_tokens, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.jobId,
        input.taskId ?? null,
        input.role,
        input.provider,
        input.model ?? null,
        Math.round(input.durationMs),
        input.usage?.inputTokens ?? null,
        input.usage?.outputTokens ?? null,
        input.usage?.totalTokens ?? null,
        input.error ?? null,
        this.now(),
      );
    this.addEvent(
      input.jobId,
      "provider.call_finished",
      input.taskId ? "task" : "job",
      input.taskId ?? input.jobId,
      {
        role: input.role,
        provider: input.provider,
        durationMs: input.durationMs,
        totalTokens: input.usage?.totalTokens ?? null,
        error: input.error ?? null,
      },
    );
  }

  measurements(jobId: string): Record<string, unknown> {
    const calls = this.db
      .prepare(
        "SELECT role, provider, model, duration_ms, input_tokens, output_tokens, total_tokens, error FROM provider_calls WHERE job_id = ? ORDER BY id",
      )
      .all(jobId) as Array<{
      duration_ms: number;
      input_tokens: number | null;
      output_tokens: number | null;
      total_tokens: number | null;
      error: string | null;
    }>;
    const job = this.mustJob(jobId);
    const sum = (key: "input_tokens" | "output_tokens" | "total_tokens"): number | null => {
      const known = calls.filter((call) => call[key] !== null);
      return known.length ? known.reduce((total, call) => total + (call[key] ?? 0), 0) : null;
    };
    return {
      elapsedMs: Date.parse(job.completedAt ?? this.now()) - Date.parse(job.createdAt),
      providerCalls: calls.length,
      providerDurationMs: calls.reduce((sum, call) => sum + call.duration_ms, 0),
      inputTokens: sum("input_tokens"),
      outputTokens: sum("output_tokens"),
      totalTokens: sum("total_tokens"),
      callsWithUsage: calls.filter((call) => call.total_tokens !== null).length,
      failedCalls: calls.filter((call) => call.error !== null).length,
      retries: this.listTasks(jobId).reduce(
        (sum, task) => sum + Math.max(0, task.attemptCount - 1),
        0,
      ),
      humanMessages: this.listMessages(jobId, 10000).filter((message) => message.role === "caller")
        .length,
      calls,
    };
  }

  reportBlocker(input: {
    jobId: string;
    taskId?: string;
    runId?: string;
    category: string;
    summary: string;
    details: string;
    nextAction: string;
    attempted?: string;
  }): BlockerRecord {
    const fingerprint = createHash("sha256")
      .update(`${input.taskId ?? "job"}:${input.category}`)
      .digest("hex");
    const existing = this.db
      .prepare("SELECT id FROM blockers WHERE job_id = ? AND fingerprint = ?")
      .get(input.jobId, fingerprint) as { id: string } | undefined;
    const now = this.now();
    const id = existing?.id ?? randomUUID();
    const old = existing
      ? this.listBlockers(input.jobId).find((item) => item.id === id)
      : undefined;
    const attempts = [
      ...(old?.attempts ?? []),
      ...(input.attempted ? [input.attempted] : []),
    ].slice(-20);
    this.db
      .prepare(
        `INSERT INTO blockers (id, job_id, task_id, run_id, category, fingerprint, summary, details, next_action, attempts_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id, fingerprint) DO UPDATE SET occurrences = occurrences + 1, status = 'open', run_id = excluded.run_id, summary = excluded.summary,
      details = excluded.details, next_action = excluded.next_action, attempts_json = excluded.attempts_json, updated_at = excluded.updated_at`,
      )
      .run(
        id,
        input.jobId,
        input.taskId ?? null,
        input.runId ?? null,
        input.category,
        fingerprint,
        input.summary.slice(0, 1000),
        input.details.slice(0, 8000),
        input.nextAction,
        JSON.stringify(attempts),
        now,
        now,
      );
    this.addEvent(input.jobId, "blocker.reported", "blocker", id, {
      taskId: input.taskId,
      category: input.category,
      nextAction: input.nextAction,
    });
    this.postMessage({
      jobId: input.jobId,
      sender: "coordinator",
      role: "system",
      taskId: input.taskId,
      messageType: "finding",
      content: `[BLOCKER: ${input.category}] ${input.summary}\nNext: ${input.nextAction}`,
      maxChars: 8000,
    });
    return this.listBlockers(input.jobId).find((item) => item.id === id)!;
  }

  listBlockers(jobId: string): BlockerRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM blockers WHERE job_id = ? ORDER BY created_at, id")
      .all(jobId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as string,
      jobId: row.job_id as string,
      taskId: row.task_id as string | null,
      runId: row.run_id as string | null,
      category: row.category as string,
      status: row.status as string,
      summary: row.summary as string,
      details: row.details as string,
      nextAction: row.next_action as string,
      attempts: strings(row.attempts_json as string),
      occurrences: row.occurrences as number,
      assists: row.assists as number,
      decisionId: row.decision_id as string | null,
      resolution: row.resolution as string | null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    }));
  }

  updateBlocker(
    id: string,
    patch: {
      status: string;
      nextAction: string;
      resolution?: string;
      decisionId?: string;
      assist?: boolean;
    },
  ): void {
    const previous = this.db
      .prepare("SELECT job_id,task_id,summary,status FROM blockers WHERE id=?")
      .get(id) as
      { job_id: string; task_id: string | null; summary: string; status: string } | undefined;
    this.db
      .prepare(
        `UPDATE blockers SET status = ?, next_action = ?, resolution = COALESCE(?, resolution), decision_id = COALESCE(?, decision_id), assists = assists + ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        patch.status,
        patch.nextAction,
        patch.resolution ?? null,
        patch.decisionId ?? null,
        patch.assist ? 1 : 0,
        this.now(),
        id,
      );
    if (previous && patch.status === "resolved" && previous.status !== "resolved") {
      this.addEvent(previous.job_id, "blocker.resolved", "blocker", id, {
        resolution: patch.resolution,
        nextAction: patch.nextAction,
      });
      this.postMessage({
        jobId: previous.job_id,
        taskId: previous.task_id,
        sender: "coordinator",
        role: "system",
        messageType: "status",
        content: `[RESOLVED] ${previous.summary}\n${patch.resolution ?? patch.nextAction}`,
        maxChars: 8000,
      });
    }
  }

  grantRecoveryAttempt(taskId: string, guidance: string): void {
    this.db
      .prepare(
        `UPDATE tasks SET max_attempts = MAX(max_attempts, attempt_count + 1), instructions = substr(instructions || ?, 1, 30000),
      status = CASE WHEN status IN ('failed', 'blocked') THEN 'ready' ELSE status END, updated_at = ? WHERE id = ?`,
      )
      .run(`\n\nRecovery guidance:\n${guidance}`, this.now(), taskId);
  }

  resolveTaskBlockers(jobId: string, taskId: string): void {
    for (const blocker of this.listBlockers(jobId).filter(
      (item) => item.taskId === taskId && item.status !== "resolved",
    )) {
      if (blocker.decisionId && this.mustDecision(blocker.decisionId).status === "open") continue;
      this.updateBlocker(blocker.id, {
        status: "resolved",
        nextAction: "Task proceeds to integration and review",
        resolution: "Task produced a validated commit",
      });
    }
  }

  recordCheckpoint(
    jobId: string,
    taskId: string,
    runId: string,
    headCommit: string,
    workspacePath: string,
  ): void {
    this.db
      .prepare("UPDATE agent_runs SET head_commit = ? WHERE id = ? AND status = 'running'")
      .run(headCommit, runId);
    this.db
      .prepare("UPDATE worktrees SET head_commit = ?, updated_at = ? WHERE run_id = ?")
      .run(headCommit, this.now(), runId);
    this.insertArtifact({
      jobId,
      taskId,
      runId,
      kind: "checkpoint",
      path: workspacePath,
      summary: `Validated partial file ownership; implementation remains unfinished. Commit ${headCommit}`,
    });
    this.addEvent(jobId, "run.checkpointed", "run", runId, { headCommit });
  }

  delegateDecisionToPlanner(decisionId: string): void {
    const decision = this.mustDecision(decisionId);
    if (decision.ownerRole === "human")
      throw new SwarmError("Human-only questions cannot be delegated automatically", "forbidden");
    if (decision.ownerRole === "planner") return;
    this.db
      .prepare("UPDATE decisions SET owner_role = 'planner' WHERE id = ? AND status = 'open'")
      .run(decisionId);
    this.addEvent(decision.jobId, "decision.delegated", "decision", decisionId, {
      from: decision.ownerRole,
      to: "planner",
      reason: "Routine agent question assigned to the authorized goal supervisor",
    });
  }

  saveProposal(
    jobId: string,
    message: string,
    reply: string,
    tasks: unknown[],
    contracts: string[],
  ): string {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO task_proposals (id, job_id, message, reply, tasks_json, contracts_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, jobId, message, reply, JSON.stringify(tasks), JSON.stringify(contracts), this.now());
    return id;
  }

  proposals(jobId: string): Array<{
    id: string;
    jobId: string;
    message: string;
    reply: string;
    tasks: unknown[];
    contracts: string[];
    status: string;
  }> {
    const rows = this.db
      .prepare("SELECT * FROM task_proposals WHERE job_id = ? ORDER BY created_at")
      .all(jobId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as string,
      jobId: row.job_id as string,
      message: row.message as string,
      reply: row.reply as string,
      tasks: JSON.parse(row.tasks_json as string) as unknown[],
      contracts: strings(row.contracts_json as string),
      status: row.status as string,
    }));
  }

  appendTasks(
    jobId: string,
    proposalId: string,
    tasks: PlannedTaskInput[],
    planJson: string,
    guidance: string,
  ): void {
    this.immediate(() => {
      const job = this.mustJob(jobId);
      const proposal = this.proposals(jobId).find((item) => item.id === proposalId);
      if (!proposal || proposal.status !== "pending")
        throw new SwarmError("Proposal is missing or already applied", "bad_state");
      if (job.status === "planning" || job.status === "cancel_requested")
        throw new SwarmError("Wait for planning or cancellation to finish", "bad_state");
      if (["failed", "interrupted", "cancelled"].includes(job.status)) this.resumeJob(jobId);
      const now = this.now();
      const existing = this.listTasks(jobId);
      const ids = new Map(existing.map((task) => [task.stableId, task.id]));
      for (const task of tasks) {
        const id = randomUUID();
        if (ids.has(task.stableId))
          throw new SwarmError(`Duplicate task ${task.stableId}`, "bad_plan");
        ids.set(task.stableId, id);
        this.db
          .prepare(
            `INSERT INTO tasks (id, job_id, stable_id, title, instructions, acceptance_criteria_json, suggested_role, file_areas_json, verification_checks_json, status, kind, attempt_count, max_attempts, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'blocked', 'implementation', 0, ?, ?, ?)`,
          )
          .run(
            id,
            jobId,
            task.stableId,
            task.title,
            task.instructions,
            JSON.stringify(task.acceptanceCriteria),
            task.suggestedRole ?? "worker",
            JSON.stringify(task.fileAreas),
            task.verificationChecks === undefined ? null : JSON.stringify(task.verificationChecks),
            job.maxAttempts,
            now,
            now,
          );
        this.addEvent(jobId, "task.created", "task", id, {
          stableId: task.stableId,
          source: "planner-chat",
        });
      }
      const latestRevision = existing.filter((task) => task.kind === "revision").at(-1);
      for (const task of tasks) {
        for (const dependency of new Set([
          ...task.dependencies.map((stableId) => {
            const id = ids.get(stableId);
            if (!id) throw new SwarmError(`Unknown dependency ${stableId}`, "bad_plan");
            return id;
          }),
          ...(latestRevision ? [latestRevision.id] : []),
        ])) {
          this.db
            .prepare(
              "INSERT INTO task_dependencies (job_id, task_id, depends_on_task_id) VALUES (?, ?, ?)",
            )
            .run(jobId, ids.get(task.stableId)!, dependency);
        }
      }
      this.db
        .prepare(
          `UPDATE jobs SET status = 'running', dry_run = 0, task = task || ?, plan_json = ?, final_report = NULL, error = NULL,
        completed_at = NULL, review_state = 'pending', max_review_rounds = MAX(max_review_rounds, review_round + 3), updated_at = ? WHERE id = ?`,
        )
        .run(`\n\nAdditional request from planner chat:\n${guidance}`, planJson, now, jobId);
      this.db.prepare("UPDATE task_proposals SET status = 'applied' WHERE id = ?").run(proposalId);
      this.refreshReadyUnlocked(jobId);
      this.addEvent(jobId, "plan.extended", "job", jobId, {
        proposalId,
        tasks: tasks.map((task) => task.stableId),
      });
    });
  }

  humanGoal(jobId: string): string {
    const row = this.db.prepare("SELECT human_goal, task FROM jobs WHERE id = ?").get(jobId) as
      { human_goal: string | null; task: string } | undefined;
    if (!row) throw new SwarmError("Unknown job", "not_found");
    return row.human_goal ?? row.task;
  }

  escalateDecision(decisionId: string, question: string): void {
    const decision = this.mustDecision(decisionId);
    this.db
      .prepare(
        "UPDATE decisions SET owner_role = 'human', resolution_policy = 'owner', blocking = 1, context = COALESCE(context, '') || ? WHERE id = ? AND status = 'open'",
      )
      .run(`\nPlanner escalation: ${question}`, decisionId);
    this.addEvent(decision.jobId, "decision.escalated", "decision", decisionId, { question });
    this.postMessage({
      jobId: decision.jobId,
      sender: "planner",
      role: "planner",
      messageType: "question",
      content: `Human answer required: ${question}`,
      decisionId,
      maxChars: 8000,
    });
  }
}
