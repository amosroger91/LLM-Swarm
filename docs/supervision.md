# Blockers, supervision, and recurring recovery

The coordinator persists blockers in SQLite. A blocker records its job, task and run, category, evidence, attempted fixes, recurrence count, assistance count, next action, linked decision, and eventual resolution. State survives a scheduler restart. `swarm_status`, `swarm_blockers`, terminal reports, `swarm.md`, and the dashboard expose it.

## Detection and assistance

Provider errors, invalid patches, no-change results, missing capabilities, and repeated failures become blocker records. A task's normal retry budget is applied first. Once it is exhausted or the same failure recurs, the planner can propose one different recovery approach by default. Recovery guidance is appended to the task, with a bounded extra attempt. It cannot relax file ownership, required checks, containment, or acceptance criteria.

If assistance fails, the task waits on a specific decision rather than retrying indefinitely. The caller can give concrete guidance or stop the job. Blocked tasks retain their history. Valid partial file edits can be committed as scoped checkpoints and inherited by the next attempt; a checkpoint never counts as implementation success or approval.

Native API workers can call `request_help`, `ask_decision`, `post_message`, and `read_coordination` during execution. CLI workers can return messages and proposals with `blocking: true`. Read tools paginate long files and mark incomplete results. Agents must not overwrite a file based on an unseen remainder.

A watchdog reports an absence of observable progress. This is a warning, not proof that a model is deadlocked. File operations, tool completions, and completed provider requests provide progress evidence. Separate deadlines bound each HTTP request, the full agent tool turn, and the job. By default these are 120 seconds, 15 minutes, and 30 minutes respectively. CLI processes retain their configured process deadline.

## Automatic planning

Recurring maintenance answers routine agent questions using the immutable human goal, current scope, task results, and recorded messages. Supported answers include evidence and use an offered option. Owner decisions are explicitly delegated to the planner; majority/unanimous decisions receive a planner vote and retain their quorum rules. Missing authority, credentials, or human preferences are escalated to a human owner. Those questions are never automatically answered.

At the boundary before final verification, the goal supervisor can identify missing work within the human-defined goal and append validated tasks. Expansion is bounded by a planning-round budget and total task-addition budget. Explicit human requests in the planning room remain reviewable proposals. The original goal is retained separately from accepted additions.

The goal supervisor cannot complete a job. The integrated output must still pass configured checks and an independent reviewer must approve the complete diff. Invalid reviewer JSON receives one bounded repair request. Major or critical findings cannot coexist with an approval. Cancellation and newly appended work are rechecked before completion.

An explicit human answer to proceed to verification remains effective for that task state. The supervisor cannot repeat the same goal question on every tick; new or updated tasks allow a fresh goal check. A missing implementation of an already explicit requirement should become corrective work, not a request to restate the requirement.

## Recurring sweep and process recovery

```yaml
providerTimeoutMs: 120000
agentTimeoutMs: 900000
jobTimeoutMs: 1800000
recovery:
  enabled: true
  maxAssistsPerTask: 1
  stallWarningMs: 60000
maintenance:
  enabled: true
  intervalMs: 30000
  maxAutoResumes: 3
  maxPlanningRounds: 3
  maxTasksAdded: 10
```

The live scheduler runs a sweep every 30 seconds by default. Interrupted jobs and jobs that reached their overall deadline can be resumed without rerunning successful prerequisites. Other failures require their recorded guidance rather than blindly restarting. Cancelled and completed jobs are not automatically restarted. Human-owned pending decisions are left for the caller. Invalid stored plans or exhausted recovery budgets surface clear next actions.

A retry compares its accumulated changes against the original task boundary, while preserving checkpoint ancestry and rechecking ownership. If the first attempt finished the files but lost its final response, the next attempt can validate that existing work without making a meaningless extra edit. Required integration checks and independent review still apply.

An in-process timer cannot revive its own dead process. On Windows, install the external task:

```powershell
powershell.exe -NoProfile -File scripts/install-watchdog.ps1 -Config config/music.local.yaml
```

`LLM-Swarm-Recovery` runs every minute in the current user's interactive session. It launches a hidden PowerShell runner calling `node dist/cli.js watchdog --config ...`. A live scheduler causes a clean no-op. If the scheduler died, the watchdog restores the dashboard, acquires the dead owner's lock, recovers interrupted state, and starts a maintenance sweep. Overlapping scheduled instances are ignored. No password or elevated account is stored. Recovery is available while that Windows user is logged in.

`node dist/cli.js maintenance --config ...` runs a standalone sweep and waits for any jobs it resumed. `watchdog` keeps the recovered dashboard and scheduler running. A live database owner is never stolen.

To remove the installed external task:

```powershell
Unregister-ScheduledTask -TaskName LLM-Swarm-Recovery -Confirm:$false
```

## Manual controls

```powershell
node dist/cli.js blockers JOB --config CONFIG
node dist/cli.js resolve JOB DECISION retry_with_guidance "Concrete fix or requirement" --config CONFIG
node dist/cli.js resume JOB --config CONFIG
node dist/cli.js metrics JOB --config CONFIG
```

Resume grants unfinished failed/cancelled tasks another bounded attempt budget and retains successful commits, artifacts, and reviews. It validates the stored plan first. Earlier plans with absolute ownership paths require correction through a validated continuation or a new job. Resume never publishes changes or merges into the base branch.
