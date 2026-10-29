import path from "node:path";
import type { SwarmConfig } from "../config/schema.js";
import { resolveWorkerCount } from "../config/schema.js";
import type { ProfileConfig } from "../config/schema.js";
import { isTerminalJob } from "../domain.js";
import { SwarmError, errorMessage, isRetryable } from "../errors.js";
import type { WorkspacePort } from "../git/workspace.js";
import { silentLogger, type Logger } from "../logging/logger.js";
import { createProvider } from "../providers/registry.js";
import { extractJsonValue } from "../providers/parse.js";
import type { AgentProvider, ProviderResponse } from "../providers/types.js";
import type { AgentProfileRecord, Claim, Store, TaskRecord } from "../db/store.js";
import { combineSignals, withTimeout } from "./async.js";
import { createChecksRunner, type ChecksRunner } from "./checks.js";
import {
  ReviewResultSchema,
  WorkerResultSchema,
  coerceReviewResult,
  coerceWorkerResult,
  validatePlan,
  widenSingleTaskFiles,
  type Plan,
  type ReviewResult,
  type WorkerResult,
} from "./planner.js";
import {
  clip,
  plannerSystem,
  plannerUserPrompt,
  reviewerSystem,
  reviewerUserPrompt,
  workerSystem,
  workerUserPrompt,
} from "./prompts.js";
import { renderSnapshot, writeSnapshotAtomic } from "./snapshot.js";

export interface ProviderResolver {
  forProfile(profile: AgentProfileRecord): AgentProvider;
}

export interface StartJobInput {
  task: string;
  repoPath: string;
  baseBranch?: string;
  workerCount?: number;
  configProfile?: string;
  dryRun?: boolean;
}

export function configProviderResolver(
  redact: (text: string) => string = (text) => text,
): ProviderResolver {
  return {
    forProfile(profile) {
      return createProvider(profile.providerName, profile.config, redact);
    },
  };
}

export class Orchestrator {
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly logger: Logger;
  private readonly checks: ChecksRunner;

  constructor(
    private readonly store: Store,
    private readonly config: SwarmConfig,
    private readonly workspace: WorkspacePort,
    private readonly providers: ProviderResolver,
    options: { logger?: Logger; checks?: ChecksRunner; recoverOnStart?: boolean } = {},
  ) {
    this.logger = options.logger ?? silentLogger;
    this.checks = options.checks ?? createChecksRunner(config);
    if (options.recoverOnStart !== false) {
      const recovered = this.store.recoverInterrupted();
      if (recovered.jobs > 0 || recovered.runs > 0) {
        this.logger.warn(recovered, "marked in-flight work interrupted");
      }
    }
  }

  async startJob(input: StartJobInput): Promise<{ job_id: string; status: string }> {
    const profileName = input.configProfile ?? this.config.defaultProfile;
    const profile = this.config.profiles[profileName];
    if (!profile) {
      throw new SwarmError(`Unknown config profile ${profileName}`, "bad_config");
    }
    const workerCount = resolveWorkerCount(this.config, input.workerCount, profile.workerCount);
    const context = await this.workspace.assertRepo(input.repoPath, input.baseBranch);
    const job = this.store.createJob({
      task: input.task,
      repoPath: context.root,
      baseBranch: context.baseBranch,
      workerCount,
      configProfile: profileName,
      dryRun: input.dryRun ?? profile.dryRun ?? false,
      maxAttempts: this.config.defaultMaxAttempts,
      maxReviewRounds: this.config.maxReviewRounds,
    });
    this.store.insertProfiles(job.id, this.profileSnapshots(profile));
    this.store.postMessage({
      jobId: job.id,
      sender: "orchestrator",
      role: "system",
      messageType: "status",
      content: `Job created for: ${input.task}`,
      maxChars: this.config.maxMessageChars,
    });
    const execution = this.execute(job.id);
    this.inflight.set(job.id, execution);
    void execution.finally(() => this.inflight.delete(job.id));
    return { job_id: job.id, status: this.store.mustJob(job.id).status };
  }

  waitFor(jobId: string): Promise<void> {
    return this.inflight.get(jobId) ?? Promise.resolve();
  }

  async execute(jobId: string): Promise<void> {
    const cancel = new AbortController();
    this.controllers.set(jobId, cancel);
    const timeout = AbortSignal.timeout(this.config.jobTimeoutMs);
    const signal = combineSignals([cancel.signal, timeout]);
    try {
      const job = this.store.mustJob(jobId);
      if (job.status === "planning") await this.plan(jobId, signal);
      let current = this.store.mustJob(jobId);
      if (current.dryRun && current.status === "completed") return;
      if (current.status !== "running") return;
      while (current.status === "running" && !signal.aborted) {
        const outcome = await this.runScheduler(jobId, signal, cancel.signal);
        if (outcome === "cancelled") return;
        if (outcome === "failed") return;
        current = this.store.mustJob(jobId);
        if (current.status !== "running") return;
        const reviewed = await this.reviewJob(jobId, signal);
        if (reviewed !== "revise") return;
        current = this.store.mustJob(jobId);
      }
      if (cancel.signal.aborted) this.finishCancelled(jobId);
      else if (timeout.aborted)
        this.fail(jobId, `Job timed out after ${this.config.jobTimeoutMs}ms`);
    } catch (error) {
      if (cancel.signal.aborted) this.finishCancelled(jobId);
      else this.fail(jobId, errorMessage(error));
    } finally {
      this.controllers.delete(jobId);
      this.writeSnapshot(jobId);
    }
  }

  status(jobId: string): Record<string, unknown> {
    return statusPayload(this.store, jobId);
  }

  result(jobId: string): Record<string, unknown> {
    return resultPayload(this.store, jobId);
  }

  chat(input: { jobId: string; message: string; channel?: string; sender?: string }): {
    id: string;
    channel: string;
  } {
    this.store.mustJob(input.jobId);
    const record = this.store.postMessage({
      jobId: input.jobId,
      sender: input.sender ?? "mcp-client",
      role: "caller",
      channel: input.channel,
      messageType: "chat",
      content: input.message,
      maxChars: this.config.maxMessageChars,
    });
    return { id: record.id, channel: record.channel };
  }

  decisions(jobId: string): unknown {
    this.store.mustJob(jobId);
    return this.store.listDecisions(jobId).map((decision) => ({
      id: decision.id,
      question: decision.question,
      context: decision.context,
      options: decision.options,
      proposer: decision.proposer,
      status: decision.status,
      policy: decision.resolutionPolicy,
      quorum: decision.quorum,
      owner_role: decision.ownerRole,
      deadline: decision.deadline,
      final_option: decision.finalOption,
      rationale: decision.finalRationale,
      votes: decision.votes.map((vote) => ({
        voter: vote.voter,
        option: vote.option,
        rationale: vote.rationale,
        updated_at: vote.updatedAt,
      })),
    }));
  }

  vote(input: {
    jobId: string;
    decisionId: string;
    option: string;
    rationale?: string;
    voter?: string;
  }): { decision_id: string; voter: string; option: string } {
    const decision = this.store.mustDecision(input.decisionId);
    if (decision.jobId !== input.jobId) {
      throw new SwarmError(
        `Decision ${input.decisionId} is not part of job ${input.jobId}`,
        "not_found",
      );
    }
    const vote = this.store.upsertVote({
      decisionId: input.decisionId,
      voter: input.voter ?? "mcp-client",
      option: input.option,
      rationale: input.rationale,
    });
    return { decision_id: vote.decisionId, voter: vote.voter, option: vote.option };
  }

  cancel(jobId: string): { job_id: string; status: string } {
    const job = this.store.mustJob(jobId);
    if (isTerminalJob(job.status)) return { job_id: jobId, status: job.status };
    if (job.status !== "cancel_requested") {
      this.store.transitionJob(jobId, "cancel_requested");
    }
    this.controllers.get(jobId)?.abort("cancelled");
    return { job_id: jobId, status: "cancel_requested" };
  }

  async shutdown(): Promise<void> {
    for (const controller of this.controllers.values()) controller.abort("cancelled");
    await Promise.allSettled([...this.inflight.values()]);
    this.store.recoverInterrupted();
  }

  private profileSnapshots(profile: ProfileConfig): Array<{
    name: string;
    role: "planner" | "worker" | "reviewer";
    providerName: string;
    config: AgentProfileRecord["config"];
    systemPrompt?: string;
  }> {
    return (["planner", "worker", "reviewer"] as const).map((role) => {
      const name = profile[role];
      const agent = this.config.agents[name];
      if (!agent) throw new SwarmError(`Unknown agent ${name}`, "bad_config");
      const provider = this.config.providers[agent.provider];
      if (!provider) throw new SwarmError(`Unknown provider ${agent.provider}`, "bad_config");
      return {
        name,
        role,
        providerName: agent.provider,
        config: provider,
        systemPrompt: agent.systemPrompt,
      };
    });
  }

  private async plan(jobId: string, signal: AbortSignal): Promise<void> {
    const job = this.store.mustJob(jobId);
    const profile = this.store.profileForRole(jobId, "planner");
    const provider = this.providers.forProfile(profile);
    const context = await this.workspace.assertRepo(job.repoPath, job.baseBranch);
    const profiles = this.describeProfiles();
    let repairErrors: string[] | undefined;
    let lastOutput = "";
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (signal.aborted) {
        this.finishCancelled(jobId);
        return;
      }
      const response = await withTimeout(
        provider.complete({
          system: plannerSystem(profile.systemPrompt ?? undefined),
          prompt: clip(
            plannerUserPrompt({
              task: job.task,
              repo: context.root,
              baseBranch: context.baseBranch,
              context: context.summary,
              profiles,
              repairErrors,
            }),
            this.config.maxPromptChars,
          ),
          signal,
          timeoutMs: this.config.providerTimeoutMs,
          expectJson: true,
          metadata: { jobId, role: "planner" },
        }),
        this.config.providerTimeoutMs,
        signal,
      );
      lastOutput = response.text.slice(0, this.config.maxResponseChars);
      let validated: ReturnType<typeof validatePlan>;
      try {
        validated = validatePlan(readJson(response));
      } catch (error) {
        validated = { ok: false, errors: [errorMessage(error)] };
      }
      if (validated.ok) {
        this.acceptPlan(jobId, widenSingleTaskFiles(job.task, validated.plan), lastOutput);
        return;
      }
      repairErrors = validated.errors;
      this.store.addEvent(jobId, "plan.rejected", "job", jobId, {
        attempt,
        errors: validated.errors,
        output: lastOutput.slice(0, 2000),
      });
      this.logger.warn({ jobId, errors: validated.errors }, "planner output rejected");
    }
    const message = `Planning failed: ${(repairErrors ?? []).join("; ")}`;
    const report = this.terminalReport(jobId, message, "failed", message, "planning_failed");
    this.store.transitionJob(jobId, "failed", {
      error: message,
      plannerOutput: lastOutput,
      reviewState: "planning_failed",
      finalReport: JSON.stringify(report),
    });
  }

  private acceptPlan(jobId: string, plan: Plan, raw: string): void {
    const job = this.store.mustJob(jobId);
    this.store.replacePlan(
      jobId,
      {
        goal: plan.goal,
        completionCriteria: plan.completionCriteria,
        assumptions: plan.assumptions,
        risks: plan.risks,
        questions: plan.questions,
        raw,
      },
      plan.tasks.map((task) => ({
        stableId: task.id,
        title: task.title,
        instructions: task.instructions,
        acceptanceCriteria: task.acceptanceCriteria,
        dependencies: task.dependencies,
        suggestedRole: task.suggestedRole,
        fileAreas: task.fileAreas,
      })),
      job.maxAttempts,
    );
    for (const question of plan.questions) {
      this.store.postMessage({
        jobId,
        sender: "planner",
        role: "planner",
        messageType: "question",
        content: question,
        maxChars: this.config.maxMessageChars,
      });
      this.store.createDecision({
        jobId,
        question,
        options: ["proceed", "needs human answer"],
        proposer: "planner",
        policy: this.config.decision.policy,
        quorum: this.config.decision.quorum,
        ownerRole: this.config.decision.ownerRole,
      });
    }
    this.store.postMessage({
      jobId,
      sender: "planner",
      role: "planner",
      messageType: "proposal",
      content: plan.goal,
      maxChars: this.config.maxMessageChars,
    });
    if (job.dryRun) {
      const report = this.terminalReport(
        jobId,
        "Dry run stored the plan and did not launch workers or change git.",
        "completed",
        null,
        "skipped_dry_run",
      );
      this.store.transitionJob(jobId, "completed", {
        reviewState: "skipped_dry_run",
        finalReport: JSON.stringify(report),
        goal: plan.goal,
      });
      return;
    }
    this.store.transitionJob(jobId, "running", { goal: plan.goal, reviewState: "pending" });
  }

  private async runScheduler(
    jobId: string,
    signal: AbortSignal,
    cancel: AbortSignal,
  ): Promise<"continue" | "cancelled" | "failed"> {
    const job = this.store.mustJob(jobId);
    const inflight = new Map<string, Promise<void>>();
    while (!signal.aborted) {
      const current = this.store.mustJob(jobId);
      if (current.status === "cancel_requested" || current.status === "cancelled") break;
      const slots = job.workerCount - inflight.size;
      const profile = this.store.profileForRole(jobId, "worker");
      const claims = slots > 0 ? this.store.claimReady(jobId, slots, profile.id) : [];
      for (const claim of claims) {
        const work = this.executeClaim(jobId, claim, profile, signal, cancel).finally(() => {
          inflight.delete(claim.run.id);
        });
        inflight.set(claim.run.id, work);
      }
      if (claims.length === 0 && inflight.size === 0) {
        const diagnosis = this.store.diagnose(jobId);
        if (diagnosis.deadlock) {
          this.fail(jobId, diagnosis.message);
          return "failed";
        }
        const counts = this.store.taskCounts(jobId);
        if (counts.failed > 0 && counts.ready === 0 && counts.running === 0) {
          this.fail(jobId, "One or more tasks failed and nothing is left to run.");
          return "failed";
        }
        return "continue";
      }
      if (inflight.size > 0) await Promise.race([...inflight.values()]);
    }
    await Promise.allSettled([...inflight.values()]);
    if (cancel.aborted) {
      this.finishCancelled(jobId);
      return "cancelled";
    }
    this.fail(jobId, `Job timed out after ${this.config.jobTimeoutMs}ms`);
    return "failed";
  }

  private async executeClaim(
    jobId: string,
    claim: Claim,
    profile: AgentProfileRecord,
    signal: AbortSignal,
    cancel: AbortSignal,
  ): Promise<void> {
    const job = this.store.mustJob(jobId);
    let workspacePath: { path: string; branch: string; baseCommit: string } | undefined;
    try {
      if (cancel.aborted || signal.aborted) {
        this.settle(claim, "cancelled", "cancelled", false);
        return;
      }
      const repoContext = await this.workspace.assertRepo(job.repoPath, job.baseBranch);
      let baseCommit = repoContext.baseCommit;
      if (claim.task.kind === "revision" && job.integrationBranch) {
        const integrated = await this.workspace.commitForBranch(
          job.repoPath,
          job.integrationBranch,
        );
        if (integrated) baseCommit = integrated;
      }
      workspacePath = await this.workspace.createRunWorkspace({
        repoRoot: job.repoPath,
        dataDir: path.resolve(this.config.dataDir),
        jobId,
        stableId: claim.task.stableId,
        attempt: claim.task.attemptCount,
        baseCommit,
      });
      this.store.attachWorkspace(claim.run.id, workspacePath);
      const provider = this.providers.forProfile(profile);
      const context = repoContext;
      const response = await withTimeout(
        provider.complete({
          system: workerSystem(profile.config.capabilities, profile.systemPrompt ?? undefined),
          prompt: clip(
            workerUserPrompt({
              task: claim.task,
              goal: job.goal,
              jobTask: job.task,
              context: context.summary,
              messages: this.store.listMessages(jobId),
              decisions: this.store.listDecisions(jobId),
            }),
            this.config.maxPromptChars,
          ),
          cwd: workspacePath.path,
          signal,
          timeoutMs: Math.min(this.config.providerTimeoutMs, profile.config.timeoutMs),
          expectJson: profile.config.capabilities.structuredOutput,
          metadata: { jobId, taskId: claim.task.stableId, role: "worker" },
        }),
        Math.min(this.config.providerTimeoutMs, profile.config.timeoutMs),
        signal,
      );
      const result = this.readWorkerResult(response, profile);
      this.persistWorkerCoordination(jobId, claim.task, result);
      if (result.status !== "done") {
        const asksForHuman = /human|clarif/i.test(result.summary);
        const retry = result.status === "failed" || (result.status === "blocked" && !asksForHuman);
        const summary = retry
          ? `${result.summary} Return status done and a unified diff. Every added line must start with +.`
          : result.summary;
        this.settle(claim, "failed", "failed", retry, summary);
        return;
      }
      const finalized = await this.workspace.finalizeRun({
        repoRoot: job.repoPath,
        workspace: workspacePath,
        message: `swarm: ${claim.task.stableId} attempt ${claim.task.attemptCount}`,
        patch: result.patch,
        dropPaths: this.dropPathsFor(jobId, claim.task),
      });
      this.store.finishRun({
        runId: claim.run.id,
        taskId: claim.task.id,
        runStatus: "succeeded",
        taskStatus: "review",
        summary: result.summary.slice(0, 8000),
        headCommit: finalized.headCommit,
        providerName: response.provider,
        model: response.model ?? null,
        requeue: false,
      });
      if (finalized.headCommit) {
        this.store.insertArtifact({
          jobId,
          taskId: claim.task.id,
          runId: claim.run.id,
          kind: "commit",
          path: workspacePath.path,
          summary: `${finalized.headCommit} ${finalized.changedFiles.join(", ")}`.slice(0, 2000),
        });
      }
      this.store.postMessage({
        jobId,
        sender: profile.name,
        role: "worker",
        messageType: "result",
        taskId: claim.task.id,
        content: result.summary,
        maxChars: this.config.maxMessageChars,
      });
    } catch (error) {
      const code = error instanceof SwarmError ? error.code : "failed";
      if (cancel.aborted || code === "cancelled") {
        this.settle(claim, "cancelled", "cancelled", false, errorMessage(error));
        return;
      }
      const runStatus = code === "timeout" ? "timed_out" : "failed";
      this.settle(
        claim,
        runStatus,
        "failed",
        isRetryable(error) || code === "timeout",
        errorMessage(error),
      );
      this.logger.error({ jobId, taskId: claim.task.id, code }, errorMessage(error));
    }
  }

  private readWorkerResult(response: ProviderResponse, profile: AgentProfileRecord): WorkerResult {
    try {
      const value = coerceWorkerResult(readJson(response));
      const parsed = WorkerResultSchema.safeParse(value);
      if (!parsed.success) {
        throw new SwarmError(
          parsed.error.issues.map((issue) => issue.message).join("; "),
          "malformed",
          true,
        );
      }
      return parsed.data;
    } catch (error) {
      if (profile.config.capabilities.structuredOutput) throw error;
      const text = response.text.trim();
      if (!text) throw error;
      return { summary: text.slice(0, 8000), status: "done" };
    }
  }

  private persistWorkerCoordination(jobId: string, task: TaskRecord, result: WorkerResult): void {
    for (const message of result.messages ?? []) {
      this.store.postMessage({
        jobId,
        sender: "worker",
        role: "worker",
        channel: message.channel,
        messageType: message.type,
        taskId: task.id,
        content: message.content,
        maxChars: this.config.maxMessageChars,
      });
    }
    for (const proposal of result.proposals ?? []) {
      const decision = this.store.createDecision({
        jobId,
        question: proposal.question,
        context: proposal.context,
        options: proposal.options,
        proposer: "worker",
        policy: this.config.decision.policy,
        quorum: this.config.decision.quorum,
        ownerRole: this.config.decision.ownerRole,
      });
      this.store.postMessage({
        jobId,
        sender: "worker",
        role: "worker",
        messageType: "proposal",
        taskId: task.id,
        decisionId: decision.id,
        content: proposal.question,
        maxChars: this.config.maxMessageChars,
      });
    }
  }

  private settle(
    claim: Claim,
    runStatus: "failed" | "timed_out" | "cancelled",
    taskStatus: "failed" | "cancelled",
    retryable: boolean,
    error?: string,
  ): void {
    const task = this.store.getTask(claim.task.id);
    if (!task || task.status !== "running") return;
    const requeue = retryable && runStatus !== "cancelled" && task.attemptCount < task.maxAttempts;
    this.store.finishRun({
      runId: claim.run.id,
      taskId: claim.task.id,
      runStatus,
      taskStatus,
      error: error ?? null,
      requeue,
    });
  }

  private async reviewJob(
    jobId: string,
    signal: AbortSignal,
  ): Promise<"done" | "revise" | "failed"> {
    const job = this.store.mustJob(jobId);
    if (signal.aborted) {
      this.finishCancelled(jobId);
      return "failed";
    }
    const round = this.store.listReviews(jobId).length + 1;
    if (round > job.maxReviewRounds) {
      this.fail(jobId, `Review stopped after ${job.maxReviewRounds} rounds without approval.`);
      return "failed";
    }
    this.store.transitionJob(jobId, "review", { reviewRound: round, reviewState: "in_review" });
    const context = await this.workspace.assertRepo(job.repoPath, job.baseBranch);
    const branches = this.integrationBranches(jobId);
    const integration = await this.workspace.integrate({
      repoRoot: job.repoPath,
      dataDir: path.resolve(this.config.dataDir),
      jobId,
      baseCommit: context.baseCommit,
      branches,
      maxDiffChars: this.config.maxDiffChars,
    });
    this.store.insertArtifact({
      jobId,
      kind: integration.ok ? "integration-diff" : "merge-conflict",
      path: integration.path,
      summary: integration.ok ? integration.diff.slice(0, 4000) : (integration.error ?? "conflict"),
    });
    if (!integration.ok) {
      this.store.addEvent(jobId, "git.conflict", "job", jobId, {
        conflicts: integration.conflicts,
        error: integration.error,
      });
      this.fail(jobId, integration.error ?? "Integration failed");
      return "failed";
    }
    this.store.transitionJob(jobId, "review", { integrationBranch: integration.branch });
    const checks = await this.checks(integration.path);
    if (!checks.ok) {
      return this.reject(jobId, round, "Checks failed", [
        {
          severity: "major",
          message: "Configured checks failed",
          instruction: checks.summary,
        },
      ]);
    }
    const profile = this.store.profileForRole(jobId, "reviewer");
    const provider = this.providers.forProfile(profile);
    const response = await withTimeout(
      provider.complete({
        system: reviewerSystem(profile.systemPrompt ?? undefined),
        prompt: clip(
          reviewerUserPrompt({
            goal: job.goal,
            criteria: job.completionCriteria,
            tasks: this.store.listTasks(jobId),
            diff: integration.diff,
            checks: checks.summary,
            messages: this.store.listMessages(jobId),
            decisions: this.store.listDecisions(jobId),
          }),
          this.config.maxPromptChars,
        ),
        cwd: integration.path,
        signal,
        timeoutMs: this.config.providerTimeoutMs,
        expectJson: true,
        metadata: { jobId, role: "reviewer" },
      }),
      this.config.providerTimeoutMs,
      signal,
    );
    const parsed = ReviewResultSchema.safeParse(coerceReviewResult(readJson(response)));
    if (!parsed.success) {
      this.fail(
        jobId,
        `Reviewer returned an invalid result: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      );
      return "failed";
    }
    this.applyReviewDecisions(parsed.data);
    if (parsed.data.approved) {
      this.store.insertReview({
        jobId,
        round,
        status: "approved",
        summary: parsed.data.summary,
        findingsJson: JSON.stringify(parsed.data.findings),
      });
      this.store.markAccepted(jobId);
      const report = this.terminalReport(jobId, parsed.data.summary, "completed", null, "approved");
      this.store.transitionJob(jobId, "completed", {
        reviewState: "approved",
        finalReport: JSON.stringify(report),
      });
      await this.cleanup(jobId, false);
      this.store.postMessage({
        jobId,
        sender: profile.name,
        role: "reviewer",
        messageType: "result",
        content: parsed.data.summary,
        maxChars: this.config.maxMessageChars,
      });
      return "done";
    }
    return this.reject(jobId, round, parsed.data.summary, parsed.data.findings);
  }

  private reject(
    jobId: string,
    round: number,
    summary: string,
    findings: ReviewResult["findings"],
  ): "revise" | "failed" {
    const job = this.store.mustJob(jobId);
    this.store.insertReview({
      jobId,
      round,
      status: "rejected",
      summary,
      findingsJson: JSON.stringify(findings),
    });
    if (round >= job.maxReviewRounds) {
      this.fail(jobId, `Review rejected the work after ${round} rounds. ${summary}`);
      return "failed";
    }
    const instructions = findings
      .map(
        (finding, index) =>
          `${index + 1}. [${finding.severity}] ${finding.file ?? "repo"}${finding.line ? `:${finding.line}` : ""} ${finding.message}\n   Do: ${finding.instruction}`,
      )
      .join("\n");
    this.store.createRevisionTask({
      jobId,
      title: `Revision round ${round}`,
      instructions: `Address the review findings below in your own worktree. Do not overwrite unrelated work.\n${instructions}`,
      acceptanceCriteria: ["Every finding is addressed or explicitly shown to be inapplicable."],
      maxAttempts: job.maxAttempts,
    });
    this.store.transitionJob(jobId, "running", { reviewState: "revision_requested" });
    this.store.postMessage({
      jobId,
      sender: "reviewer",
      role: "reviewer",
      messageType: "finding",
      content: summary,
      maxChars: this.config.maxMessageChars,
    });
    return "revise";
  }

  private applyReviewDecisions(review: ReviewResult): void {
    for (const decision of review.decisions ?? []) {
      try {
        this.store.resolveDecision({
          decisionId: decision.decisionId,
          option: decision.option,
          rationale: decision.rationale,
          actor: "reviewer",
          actorRole: "reviewer",
        });
      } catch (error) {
        this.logger.warn({ decisionId: decision.decisionId }, errorMessage(error));
      }
    }
  }

  private dropPathsFor(jobId: string, task: TaskRecord): string[] {
    if (task.kind === "revision") return [];
    return this.store
      .listTasks(jobId)
      .filter((other) => other.id !== task.id && other.kind !== "revision")
      .flatMap((other) => other.fileAreas);
  }

  private integrationBranches(jobId: string): Array<{ branch: string; label: string }> {
    const tasks = topological(this.store.listTasks(jobId), this.store.dependencyMap(jobId));
    const worktrees = this.store.listWorktrees(jobId);
    const branches: Array<{ branch: string; label: string }> = [];
    for (const task of tasks) {
      const match = [...worktrees]
        .reverse()
        .find((item) => item.taskId === task.id && item.headCommit);
      if (!match) continue;
      branches.push({ branch: match.branchName, label: task.stableId });
    }
    return branches;
  }

  private async cleanup(jobId: string, failed: boolean): Promise<void> {
    const job = this.store.mustJob(jobId);
    const preserve = failed && this.config.git.preserveOnFailure;
    if (!this.config.git.cleanupWorktrees || preserve) {
      for (const worktree of this.store.listWorktrees(jobId)) {
        if (worktree.cleanupState === "active")
          this.store.setWorktreeState(worktree.id, "preserved");
      }
      return;
    }
    await this.workspace.cleanup({
      repoRoot: job.repoPath,
      worktrees: this.store.listWorktrees(jobId).map((worktree) => ({
        path: worktree.path,
        branch: worktree.branchName,
        preserve: false,
      })),
    });
    for (const worktree of this.store.listWorktrees(jobId)) {
      this.store.setWorktreeState(worktree.id, "removed");
    }
  }

  private finishCancelled(jobId: string): void {
    const job = this.store.getJob(jobId);
    if (!job || isTerminalJob(job.status)) return;
    this.store.cancelOutstanding(jobId);
    if (job.status !== "cancelled") {
      const current = this.store.mustJob(jobId);
      if (current.status !== "cancel_requested" && !isTerminalJob(current.status)) {
        this.store.transitionJob(jobId, "cancel_requested");
      }
      const again = this.store.mustJob(jobId);
      if (again.status === "cancel_requested") {
        const report = this.terminalReport(
          jobId,
          "Cancellation requested. No further work was launched.",
          "cancelled",
          null,
          "cancelled",
        );
        this.store.transitionJob(jobId, "cancelled", {
          reviewState: "cancelled",
          finalReport: JSON.stringify(report),
        });
      }
    }
  }

  private fail(jobId: string, message: string): void {
    const job = this.store.getJob(jobId);
    if (!job || isTerminalJob(job.status)) return;
    if (job.status === "cancel_requested") {
      const report = this.terminalReport(jobId, message, "cancelled", message, "cancelled");
      this.store.transitionJob(jobId, "cancelled", {
        error: message,
        reviewState: "cancelled",
        finalReport: JSON.stringify(report),
      });
      return;
    }
    const report = this.terminalReport(jobId, message, "failed", message, "failed");
    this.store.transitionJob(jobId, "failed", {
      error: message,
      reviewState: "failed",
      finalReport: JSON.stringify(report),
    });
    void this.cleanup(jobId, true);
  }

  private describeProfiles(): string {
    return Object.entries(this.config.agents)
      .map(([name, agent]) => {
        const provider = this.config.providers[agent.provider];
        const capabilities = provider ? JSON.stringify(provider.capabilities) : "unknown";
        return `- ${name} role=${agent.role} provider=${agent.provider} capabilities=${capabilities}`;
      })
      .join("\n");
  }

  private terminalReport(
    jobId: string,
    summary: string,
    status: string,
    error?: string | null,
    reviewState?: string,
  ): Record<string, unknown> {
    const report: Record<string, unknown> = {
      ...this.buildReport(jobId, summary),
      status,
      error: error ?? null,
    };
    if (reviewState !== undefined) report.reviewState = reviewState;
    return report;
  }

  private buildReport(jobId: string, summary: string): Record<string, unknown> {
    const job = this.store.mustJob(jobId);
    return {
      jobId,
      status: job.status,
      dryRun: job.dryRun,
      summary,
      goal: job.goal,
      completionCriteria: job.completionCriteria,
      assumptions: job.assumptions,
      risks: job.risks,
      questions: job.questions,
      reviewState: job.reviewState,
      error: job.error,
      integrationBranch: job.integrationBranch,
      tasks: this.store.listTasks(jobId).map((task) => ({
        id: task.stableId,
        title: task.title,
        status: task.status,
        attempts: task.attemptCount,
        summary: task.resultSummary,
        error: task.error,
      })),
      reviews: this.store.listReviews(jobId).map((review) => ({
        round: review.round,
        status: review.status,
        summary: review.summary,
        findings: JSON.parse(review.findingsJson) as unknown,
      })),
      decisions: this.store.listDecisions(jobId).map((decision) => ({
        id: decision.id,
        question: decision.question,
        status: decision.status,
        finalOption: decision.finalOption,
        rationale: decision.finalRationale,
        votes: decision.votes.map((vote) => ({ voter: vote.voter, option: vote.option })),
      })),
    };
  }

  private writeSnapshot(jobId: string): void {
    if (!this.config.writeSnapshot) return;
    try {
      const job = this.store.getJob(jobId);
      if (!job) return;
      const filePath = path.join(path.resolve(this.config.dataDir), "jobs", jobId, "swarm.md");
      writeSnapshotAtomic(
        filePath,
        renderSnapshot({
          job,
          tasks: this.store.listTasks(jobId),
          decisions: this.store.listDecisions(jobId),
          reviews: this.store.listReviews(jobId),
        }),
      );
      this.store.setSnapshotPath(jobId, filePath);
    } catch (error) {
      this.logger.warn({ jobId }, `snapshot failed: ${errorMessage(error)}`);
    }
  }
}

function readJson(response: ProviderResponse): unknown {
  if (response.structured !== undefined) return response.structured;
  return extractJsonValue(response.text.slice(0, 200_000));
}

function topological(tasks: TaskRecord[], dependencies: Map<string, string[]>): TaskRecord[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const seen = new Set<string>();
  const ordered: TaskRecord[] = [];
  const visit = (task: TaskRecord): void => {
    if (seen.has(task.id)) return;
    seen.add(task.id);
    for (const dependency of dependencies.get(task.id) ?? []) {
      const item = byId.get(dependency);
      if (item) visit(item);
    }
    ordered.push(task);
  };
  for (const task of tasks) visit(task);
  return ordered;
}

export function statusPayload(store: Store, jobId: string): Record<string, unknown> {
  const job = store.mustJob(jobId);
  return {
    job_id: job.id,
    status: job.status,
    review_state: job.reviewState,
    dry_run: job.dryRun,
    worker_count: job.workerCount,
    task_counts: store.taskCounts(jobId),
    active_workers: store.activeRuns(jobId).map((run) => ({
      run_id: run.id,
      task_id: run.taskId,
      status: run.status,
      branch: run.branchName,
    })),
    recent_events: store.listEvents(jobId, 20).map((event) => ({
      id: event.id,
      type: event.type,
      at: event.createdAt,
      entity_id: event.entityId,
    })),
    snapshot_path: job.snapshotPath,
    error: job.error,
  };
}

export function resultPayload(store: Store, jobId: string): Record<string, unknown> {
  const job = store.mustJob(jobId);
  if (!isTerminalJob(job.status)) {
    return {
      ready: false,
      job_id: job.id,
      status: job.status,
      message: "Job is still in progress. Poll swarm_status or swarm_result again.",
    };
  }
  const report = job.finalReport ? (JSON.parse(job.finalReport) as unknown) : null;
  return {
    ready: true,
    job_id: job.id,
    status: job.status,
    report,
    error: job.error,
  };
}
