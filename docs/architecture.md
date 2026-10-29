# Architecture

LLM Swarm is a single local process. The MCP server and the CLI both construct one `Orchestrator` around one SQLite database. A second process can open the same database and read status. It must not run a second scheduler for the same jobs. SQLite serializes task claims. It is not a distributed work queue.

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

Provider calls and git commands run outside the database transaction. `finishRun` always runs from success, failure, timeout, or cancel paths, so a thrown provider error does not leave the task `running`. On process restart, `recoverInterrupted` marks queued or running runs `interrupted`, returns a running task to `ready` when attempts remain (otherwise `failed`), and marks an in-flight job `interrupted`. Recovery does not resume the job.

Cancellation sets `cancel_requested`, aborts the job's `AbortController`, and does not claim further work. A job timeout is a failure, not a cancellation.

A worker result of `blocked` fails that task and is not retried. `failed` is retried while attempts remain. A failed task with nothing left ready or running fails the job before review.

If every remaining task is blocked and nothing is ready or running, the job fails as a deadlock. Blocked tasks whose dependencies have all failed or been cancelled are failed first.

## Review

The scheduler topologically merges task branches that have a recorded head commit onto `swarm/<job8>/integration`. The worktree lives under `dataDir`, outside the repository. A merge conflict runs `git merge --abort`, records the conflict, and fails the job. Task branches are left as they were. On failure, `preserveOnFailure` (the default) keeps those worktrees.

Configured checks are command/argument pairs from the config file. They are not taken from agent output. A failing check counts as a rejection and creates a revision task without calling the reviewer.

The reviewer returns JSON. Rejection requires at least one finding with a severity, message, and instruction. That inserts a review row, moves current `review` tasks to `revision`, and adds one ready task whose stable id is `revision-<n>`, where `n` is the number of review rows after the insert plus one. The first rejection therefore creates `revision-2`. The id is unique. `maxReviewRounds` (default 3) bounds the loop. Approval marks `review` and `revision` tasks `done` and completes the job.

Successful cleanup removes recorded task worktrees. The integration worktree is not in that table, so it stays for inspection.

## Providers

Built-in drivers are `openai_compatible` and `cli`. A `custom` driver registers with `registerProviderBuilder`. Output parsers register with `registerOutputParser`. The scheduler does not change.

The OpenAI-compatible adapter posts to `/chat/completions`. It sends `response_format: { type: "json_object" }` only when the call expects JSON, the provider declares `structuredOutput`, and `jsonMode` is `json_object`. The API key comes from `apiKeyEnv`. It is optional when `apiKeyOptional` is true, which is how the Ollama profile works.

The CLI adapter spawns `command` plus an argument array with `shell: false`. `{prompt}`, `{promptFile}`, and `{cwd}` replace a whole argument. Prompt files are created in the temp directory with mode `0600` and deleted afterward. The child environment is a base allowlist plus `envPass`. On Windows the process tree is killed with `taskkill /pid /t /f`. Elsewhere the process group gets `SIGKILL`.

Parsers named `grok-json`, `opencode-events`, and `gemini-json` are best-effort. The sample profiles were checked against `--help` output, not a live model call.

## Chat, decisions, and the snapshot

Messages have a sender, role, channel, and type: `status`, `question`, `finding`, `proposal`, `handoff`, `result`, or `chat`. `chat` is the type used when a caller posts through `swarm_chat`. Agents do not write SQL. They do not use `swarm.md` as a database.

Decisions have options and votes. A second vote from the same voter replaces the previous option and writes a `decision.voted` event with `replaced: true`. The default policy is `owner` (the reviewer). Majority and unanimous policies resolve only when the quorum is met and the rule matches. Votes do not resolve an owner decision.

`swarm.md` is written atomically under `dataDir/jobs/<id>/` with a `GENERATED FILE` banner. The database remains the source of truth.

## Git safety

`repo_path` must be the repository root. Branch names are `swarm/<8 chars>/<stable id>/<attempt>`. Refs are checked for `-`, `..`, `@{`, and empty segments. Patches are rejected when a path is absolute or contains `..`. A porcelain path that escapes the worktree is reset inside that worktree only.

`git.allowPush`, `git.allowMergeToBase`, and `git.allowRemotePr` default to false. `assertRemoteAllowed` throws otherwise. The adapter never runs an agent-supplied string as git.

## MCP

`@modelcontextprotocol/server` v2 serves stdio through `serveStdio`. Tools are registered with Zod object schemas. Schema failures are tool errors and do not run the handler. Domain errors return `isError: true` and do not include `structuredContent`. Logs go to stderr so they do not share stdout with the protocol.
