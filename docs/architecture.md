# Architecture

LLM Swarm has one local scheduler per SQLite database. MCP constructs an `Orchestrator`; status, result, and cancel CLI commands operate directly on the store without starting one. Scheduler startup acquires a SQLite ownership record containing a token, PID, and hostname before recovery. A live owner blocks a second scheduler; a dead local owner can be recovered. Closing the owning store releases only its own token. This is not a distributed work queue, and a lock from another hostname is not stolen.

## State

Job status: `planning`, `running`, `review`, `completed`, `failed`, `cancel_requested`, `cancelled`, `interrupted`.

Task status: `blocked`, `ready`, `running`, `review`, `revision`, `done`, `failed`, `cancelled`.

Run status: `queued`, `running`, `succeeded`, `failed`, `timed_out`, `cancelled`, `interrupted`.

A task is `ready` only when every dependency is satisfied. A dependency is satisfied when the predecessor is `review`, `revision`, or `done`. Worker success moves a task to `review`, not `done`. The reviewer is the only path to `done`, via an explicit approval record. If dependents waited for literal `done`, the job-level review could never start. A task sent back to `revision` still satisfies dependents, so that send-back does not deadlock the rest of the graph.

Completion is computed from task, integration, and review rows. Planner or worker text cannot mark the job complete. A dry run moves `planning` to `completed` with review state `skipped_dry_run` and does not launch workers or change git.

## Scheduler

`start_swarm` inserts the job and returns. Planning and execution continue on a background promise. `waitFor` exists for tests.

The scheduler claims up to `workerCount` ready tasks. The default count is 2. The cap is `min(5, maxWorkerCount)` unless `allowWorkerCountAboveDefault` is set. A request above the cap throws. It is not clamped.

Claims use an immediate transaction: select one `ready` task, conditional `UPDATE` to `running`, insert the run. Two connections cannot both observe a successful update for the same task.

Provider calls and git commands run outside the database transaction. `finishRun` always runs from success, failure, timeout, or cancel paths, so a thrown provider error does not leave the task `running`. On process restart, `recoverInterrupted` marks queued or running runs `interrupted`, returns a running task to `ready` when attempts remain (otherwise `failed`), and marks an in-flight job `interrupted`. The recurring maintenance sweep or an explicit resume can subsequently restart the job while retaining successful task commits. See [supervision](supervision.md).

Cancellation sets `cancel_requested`, aborts the job's `AbortController`, and does not claim further work. The active scheduler polls persisted cancellation every 100 ms, so CLI cancellation works across processes. Configured checks receive the abort signal. A job timeout is a failure, not a cancellation.

A worker result of `blocked` fails that task and is not retried. `failed` is retried while attempts remain. A failed task with nothing left ready or running fails the job before review.

If every remaining task is blocked and nothing is ready or running, the job fails as a deadlock. Blocked tasks whose dependencies have all failed or been cancelled are failed first.

## Review

The job pins its base commit at creation. Each worker gets `<repo>/workspaces/<job>/agent-<task>-<attempt>/` and a unique `codex/swarm/<job>/<task>/<attempt>` branch. Prerequisite commits are merged before a dependent worker starts; independent tasks have disjoint file ownership. Worker prompts include selected committed source from that dependency snapshot, with omissions explicitly marked. Source collection excludes credentials, generated output, and sibling workspaces.

The scheduler topologically merges recorded commit SHAs onto `codex/swarm/<job>/integration` at `<repo>/workspaces/<job>/integration/`. Using SHAs prevents a branch moved later from substituting different code. A merge conflict runs `git merge --abort`, records the conflict, and fails the job. Revisions are not allowed to silently choose the other side of a conflict. On failure, `preserveOnFailure` (the default) keeps recorded worktrees.

Configured checks are command/argument pairs from the config file, never agent output. Their evidence records `passed`, `failed`, or `not_run`. Missing checks fail the job by default; `requireChecks: false` permits an explicitly unverified result. A failing configured check creates a revision task without calling the reviewer. A truncated diff or oversized review prompt fails the job before review so unseen changes cannot be approved.

The reviewer returns JSON. Rejection requires at least one finding with a severity, message, and instruction. That inserts a review row, moves current `review` tasks to `revision`, and adds one ready task whose stable id is `revision-<n>`, where `n` is the number of review rows after the insert plus one. The first rejection therefore creates `revision-2`. The id is unique. `maxReviewRounds` (default 3) bounds the loop. Approval marks `review` and `revision` tasks `done` and completes the job.

Worktrees are retained by default. Optional successful cleanup verifies the recorded path's repository and branch before removing task worktrees. The integration checkout stays for inspection.

## Providers

Built-in drivers are `openai_compatible` and `cli`. A `custom` driver registers with `registerProviderBuilder`. Output parsers register with `registerOutputParser`. The scheduler does not change.

The OpenAI-compatible adapter posts to `/chat/completions`. It sends `response_format: { type: "json_object" }` only when the call expects JSON, the provider declares `structuredOutput`, and `jsonMode` is `json_object`. The API key comes from `apiKeyEnv`. It is optional when `apiKeyOptional` is true, which is how the Ollama profile works.

The CLI adapter spawns `command` plus an argument array with `shell: false`. Both the role/system contract and user prompt are included in all prompt transports. `{prompt}`, `{promptFile}`, and `{cwd}` replace arguments. Prompt files are created in the temp directory with mode `0600` and deleted afterward. The child environment is a base allowlist plus `envPass`. On Windows the process tree is killed with `taskkill /pid /t /f`. Elsewhere the process group gets `SIGKILL`. CLI processes retain host permissions; use trusted executables or run the swarm inside an OS sandbox.

Parsers named `grok-json`, `opencode-events`, and `gemini-json` are best-effort. The sample profiles were checked against `--help` output, not a live model call.

## Chat, decisions, and the snapshot

Messages have a sender, role, channel, and type: `status`, `question`, `finding`, `proposal`, `handoff`, `result`, or `chat`. `chat` is the type used when a caller posts through `swarm_chat`. Agents do not write SQL. They do not use `swarm.md` as a database.

Decisions have options and votes. A second vote from the same voter replaces the previous option and writes a `decision.voted` event with `replaced: true`. The default policy is `owner` (the reviewer). Majority and unanimous policies resolve only when the quorum is met and the rule matches. Votes do not resolve an owner decision.

`swarm.md` is written atomically under `dataDir/jobs/<id>/` with a `GENERATED FILE` banner. The database remains the source of truth.

## Git safety

`repo_path` must be the repository root. Workspace identifiers and refs are validated. Before any patch write, all destination paths and headers are checked for consistency, traversal, reserved paths, Windows aliases, and linked ancestors. Regular text modes are required. NUL-delimited Git status handles filenames without shell parsing. The coordinator verifies agent commits descend from their assigned snapshot and limits committed files to task ownership. Git hooks and commit signing are disabled for coordinator Git operations.

The coordinator writes `/workspaces/` into Git's local exclude file. Source collection skips nested workspaces. Lint, test, formatting, and watcher exclusions for arbitrary target projects remain their configuration responsibility; see [workspaces.md](workspaces.md).

`git.allowPush`, `git.allowMergeToBase`, and `git.allowRemotePr` default to false. `assertRemoteAllowed` throws otherwise. The adapter never runs an agent-supplied string as git.

## MCP

`@modelcontextprotocol/server` v2 serves stdio through `serveStdio`. Tools are registered with Zod object schemas. Schema failures are tool errors and do not run the handler. Domain errors return `isError: true` and do not include `structuredContent`. Logs go to stderr so they do not share stdout with the protocol.
