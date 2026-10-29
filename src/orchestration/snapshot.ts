import fs from "node:fs";
import path from "node:path";
import type { DecisionRecord, JobRecord, ReviewRecord, TaskRecord } from "../db/store.js";

export function renderSnapshot(input: {
  job: JobRecord;
  tasks: TaskRecord[];
  decisions: DecisionRecord[];
  reviews: ReviewRecord[];
}): string {
  const lines = [
    "<!-- GENERATED FILE. Do not edit. Source of truth is the SQLite database. This file is not a lock, queue, or coordination database. -->",
    `# Swarm ${input.job.id}`,
    "",
    `Status: ${input.job.status}`,
    `Review: ${input.job.reviewState ?? "pending"}`,
    `Repository: ${input.job.repoPath}`,
    `Base branch: ${input.job.baseBranch}`,
    `Integration branch: ${input.job.integrationBranch ?? "(not created)"}`,
    "",
    "## Goal",
    input.job.goal ?? input.job.task,
    "",
    "## Tasks",
  ];
  for (const task of input.tasks) {
    lines.push(
      `- ${task.stableId} [${task.status}] ${task.title} (attempts ${task.attemptCount}/${task.maxAttempts})`,
    );
  }
  lines.push("", "## Decisions");
  if (input.decisions.length === 0) lines.push("(none)");
  for (const decision of input.decisions) {
    lines.push(`- ${decision.status}: ${decision.question}`);
    if (decision.finalOption)
      lines.push(`  resolved: ${decision.finalOption} — ${decision.finalRationale ?? ""}`);
  }
  lines.push("", "## Reviews");
  if (input.reviews.length === 0) lines.push("(none)");
  for (const review of input.reviews) {
    lines.push(`- round ${review.round}: ${review.status} — ${review.summary}`);
  }
  if (input.job.error) {
    lines.push("", "## Error", input.job.error);
  }
  lines.push("");
  return lines.join("\n");
}

export function writeSnapshotAtomic(filePath: string, body: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, body, "utf8");
  fs.rmSync(filePath, { force: true });
  fs.renameSync(temporary, filePath);
}
