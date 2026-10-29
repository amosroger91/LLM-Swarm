import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ProviderConfig } from "../config/schema.js";
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

const StringArray = z.array(z.string());

export interface JobRecord {
  id: string;
  task: string;
  repoPath: string;
  baseBranch: string;
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

export interface AgentProfileRecord {
  id: string;
  jobId: string;
  name: string;
  role: "planner" | "worker" | "reviewer";
  providerType: string;
  providerName: string;
  model: string | null;
  config: ProviderConfig;
  capabilitiesJson: string;
  systemPrompt: string | null;
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
}

interface JobRow {
  id: string;
  task: string;
  repo_path: string;
  base_branch: string;
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
    id: row.id,
    task: row.task,
    repoPath: row.repo_path,
    baseBranch: row.base_branch,
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
  constructor(private readonly db: SqliteDatabase) {}

  close(): void {
    this.db.close();
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
      systemPrompt?: string;
    }>,
  ): void {
    const now = this.now();
    this.immediate(() => {
      const insert = this.db.prepare(
        `INSERT INTO agent_profiles (
          id, job_id, name, role, provider_type, provider_name, model, config_json,
          capabilities_json, system_prompt, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          file_areas_json, status, kind, attempt_count, max_attempts, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'implementation', 0, ?, ?, ?)`,
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
           error = COALESCE(?, error) WHERE id = ?`,
        )
        .run(nextTaskStatus, now, input.summary ?? null, input.error ?? null, input.taskId);
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
    const summary = input.summary.slice(0, 8000);
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
}
