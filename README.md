# LLM Swarm

Local multi-agent orchestration for a software repo, exposed as an MCP server and a web control center.

Use a strong model (Claude Code) to plan and review, and local Ollama or free remote models to do the work, with automatic failover when a model is rate limited, out of quota, down, or produces bad output. From Claude Code, hand off whole features (`start_swarm`) or cheap one-off chores (`delegate`) so the expensive model spends its tokens on decisions instead of reading files.

- [Using it from Claude Code](docs/claude-code.md): install, tools, and a `CLAUDE.md` snippet that teaches Claude when to delegate.
- [Model routing and failover](docs/failover.md): fallback chains, cooldowns, and retry rotation.
- `config/hybrid.yaml`: Claude Code plans/reviews; Ollama → Groq → Gemini → OpenRouter execute.

## Overview

LLM Swarm takes one task, asks a planner for a validated plan, and runs up to five workers per job in separate Git worktrees. Each worker gets a complete checkout under the target repository's `workspaces/` directory, its own branch, and the verified committed output of its dependencies. Before a task can hand off, the coordinator runs its configured checks against the commit and records the evidence. Failed checks return the task for bounded repair. SQLite is the source of truth for jobs, tasks, chat, votes, and reviews. The coordinator then integrates the results, runs every configured check, and asks a reviewer to assess the complete diff. Remote pushes, changes to the base branch, and PR creation are not automated by the swarm.

## Architecture

The [local control center](docs/dashboard.md) displays live tasks, dependencies, worker activity, verification, model usage, and planner chat. [Recurring supervision](docs/supervision.md) answers supported worker questions, adds bounded missing work within the human goal, and resumes interrupted jobs. Human-only questions remain explicit decisions. Checks and independent review still determine completion.

```
MCP client or CLI
        |
        v
  Orchestrator  (one local process)
    |    |    |
 planner workers reviewer
        |
        +--> SQLite  (.swarm-data/swarm.db)
        +--> <target-repo>/workspaces/<job>/agent-<task>-<attempt>/
        +--> <target-repo>/workspaces/<job>/integration/
        +--> optional dataDir/jobs/<id>/swarm.md
```

The scheduler, store, and providers can run without the MCP transport. See [docs/architecture.md](docs/architecture.md).

## Quick start

```sh
npm install
npm run build
node dist/cli.js providers --config config/hybrid.yaml   # ping every model once
claude mcp add llm-swarm --scope user -- node "$PWD/dist/cli.js" mcp --config "$PWD/config/hybrid.yaml"
```

The first MCP connection starts a detached daemon that runs the scheduler and the web control center at `http://127.0.0.1:4317`; later Claude Code sessions attach to the same daemon, and jobs keep running after Claude exits. To run the web UI on its own: `node dist/cli.js dashboard --config config/hybrid.yaml`. A database has one scheduler owner; MCP processes find a running dashboard through `<dataDir>/dashboard.json` and act as its clients (`mcp --in-process` opts out).

Point an MCP client at `node dist/cli.js mcp --config config/swarm.example.yaml` after a build. Configure `checks` for the target repository before starting an implementation job. Checks are required by default; a deliberately unverified experiment can set `requireChecks: false`. With no config file and no `SWARM_CONFIG` variable, the process uses the built-in Ollama profile at `http://127.0.0.1:11434/v1`.

The target repository must already have a commit. A typical checked run uses a command such as `node scripts/verify.mjs` from that repository. Each task's checks must pass with only that task and its dependencies implemented. Configure scoped checks for parallel tasks, or use one task when the checker requires the complete change. Commands run directly without a shell; on Windows, use a real executable rather than `npm.cmd`. Install any dependencies the checks require in each worktree or configure an appropriate executable path. See [verification configuration](docs/configuration.md#decisions-git-and-checks) for check selection and protected acceptance files.

Check a job from another terminal:

```powershell
npx tsx src/cli.ts jobs --config config/swarm.example.yaml
npx tsx src/cli.ts status <job_id> --config config/swarm.example.yaml
```

## Configuration

Secrets are read from the environment. An ignored local YAML file can also supply `apiKey`; the loader converts it to an environment reference before validation and persistence. Validated configuration snapshots and the database store the reference, and the CLI redacts configured credentials from logs and provider errors.

| Variable             | Required         | Description                                                                   |
| -------------------- | ---------------- | ----------------------------------------------------------------------------- |
| `OLLAMA_API_KEY`     | optional         | Sent only when set. The sample Ollama provider works with no key.             |
| `OPENAI_API_KEY`     | optional         | For an OpenAI-compatible provider that names this variable.                   |
| `OPENROUTER_API_KEY` | profile-specific | OpenRouter models, e.g. the free-tier failover in `hybrid.yaml`.              |
| `NVIDIA_API_KEY`     | profile-specific | For an NVIDIA provider that names this variable.                              |
| `GROQ_API_KEY`       | profile-specific | Groq models, e.g. the free-tier failover in `hybrid.yaml`.                    |
| `GEMINI_API_KEY`     | optional         | Gemini API failover in `hybrid.yaml`; the gemini CLI when `envPass` lists it. |
| `ANTHROPIC_API_KEY`  | optional         | Claude Code planner; without it `claude` uses its own login.                  |
| `XAI_API_KEY`        | optional         | Passed to the grok CLI only when that profile's `envPass` lists it.           |
| `SWARM_CONFIG`       | optional         | Path to a YAML config. `--config` wins over this variable.                    |

`.env.example` lists supported variables. Set them in the process environment; the app does not automatically load `.env`. Node's `--env-file` option can load a local file when starting the built CLI. Provider and profile fields are documented in [docs/configuration.md](docs/configuration.md).

## Usage

### MCP tools

| Tool              | What it does                                                                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `delegate`        | Runs one bounded task on the cheap delegate agent. It reads the given files/globs itself and returns only its answer plus a one-line provenance footer.           |
| `delegate_map`    | Runs a task per file in parallel, optionally merging the answers with `reduce`.                                                                                   |
| `swarm_wait`      | Blocks until a job finishes or needs an answer (or the timeout passes) and returns compact status. Replaces polling.                                              |
| `swarm_jobs`      | Recent jobs with task counts.                                                                                                                                     |
| `swarm_providers` | Provider health, cooldowns, failover chains, and delegation totals.                                                                                               |
| `start_swarm`     | Persists a job and returns `{ job_id, status }` without waiting for the swarm to finish. Optional `base_branch`, `worker_count`, `config_profile`, and `dry_run`. |
| `swarm_status`    | Compact job status: task counts, active workers, open blockers and questions, token totals. `verbose: true` adds the full call log and blocker evidence.          |
| `swarm_chat`      | Appends a message to the job chat room.                                                                                                                           |
| `swarm_decisions` | Lists decisions, options, votes, and rationale.                                                                                                                   |
| `swarm_vote`      | Records or replaces the caller's vote. Default voter is `mcp-client`.                                                                                             |
| `swarm_result`    | Final report when the job is terminal, otherwise `{ ready: false }`.                                                                                              |
| `cancel_swarm`    | Stops launching new work. Idempotent for a job that already finished.                                                                                             |

`dry_run` stores the plan and does not launch workers or change git.

`resume_swarm`, `launch_swarm_plan`, and `resolve_swarm_decision` are also in the default `core` toolset. `mcp --tools all` adds `swarm_chat`, `swarm_decisions`, `swarm_vote`, `swarm_blockers`, `swarm_planner_chat`, `apply_swarm_proposal`, and `swarm_maintenance`; the smaller default keeps tool definitions from crowding the caller's context. Tool results are compact JSON. Native API workers with `toolCalling` enabled can read source, edit assigned files, run configured checks, exchange live messages, and request help. Planner task additions validate the combined dependency graph and file ownership.

### CLI

| Command             | What it does                                                                     |
| ------------------- | -------------------------------------------------------------------------------- |
| `mcp`               | MCP server on stdio; attaches to or starts the daemon. Diagnostics go to stderr. |
| `dashboard [port]`  | Web control center plus scheduler (the daemon).                                  |
| `providers`         | Sends a one-word prompt to every provider and reports which work.                |
| `migrate`           | Opens the database and applies migrations.                                       |
| `jobs`              | Prints recent jobs as JSON.                                                      |
| `status <job_id>`   | Prints one job's status.                                                         |
| `result <job_id>`   | Prints the final report, or an in-progress response.                             |
| `cancel <job_id>`   | Requests cancellation.                                                           |
| `snapshot <job_id>` | Regenerates `swarm.md`.                                                          |
| `backup <file>`     | Copies the SQLite database.                                                      |

## Project structure

```
src/cli.ts                 local CLI
src/mcp/server.ts          MCP tools
src/orchestration/         planner validation, scheduler, prompts, snapshots
src/db/                    SQLite connection, migrations, store
src/providers/             OpenAI-compatible and CLI adapters, failover chains, provider health
src/orchestration/delegate.ts  delegate / delegate_map
src/mcp/backend.ts         in-process or daemon-backed tool backend
src/git/workspace.ts       worktrees, or an in-memory workspace for tests
src/safety/                paths, process spawn, redaction, remote-git policy
config/swarm.example.yaml  Ollama default plus help-checked CLI profiles
config/hybrid.yaml         Claude Code planner/reviewer, Ollama + free-tier workers with failover
test/                      Vitest suite, no network and no real agent CLIs
```

## Tech stack

- Node.js 22.12+, Node 24, or Node 26+. This revision was exercised on Node 24.13.0.
- TypeScript, ESM, Zod 4, better-sqlite3, Vitest 5, ESLint 9, Prettier.
- MCP TypeScript SDK v2 (`@modelcontextprotocol/server` and `@modelcontextprotocol/client`). This is not the deprecated `@modelcontextprotocol/sdk` v1 package. Tools use `registerTool` with Zod object schemas and `serveStdio`.

## Notes / conventions

- One local scheduler. SQLite coordinates claims inside that design. It is not a distributed queue.
- Worktrees live at `<repo>/workspaces/<job>/agent-<task>-<attempt>/`. They are retained by default for inspection. Set `git.cleanupWorktrees: true` to remove successful task worktrees; integration remains available. `dataDir` holds the database and snapshots, separate from worktree storage.
- The coordinator adds `/workspaces/` to Git's local exclude file. This repository also excludes it from lint, formatting, tests, and source discovery. Other target projects must exclude it from their own build/test globs and watchers; see [workspace setup](docs/workspaces.md).
- Every job pins its starting commit. Dependent workers inherit prerequisite commits. Independent tasks must own disjoint file areas; explicit dependencies permit sequential edits to the same file.
- Check commands, `requireChecks`, and explicitly configured `protectedPaths` are pinned with each job. Optional task `verificationChecks` selects unique zero-based check indices. Each handoff reruns the union of that task's and every dependency ancestor's selections to catch regressions; omission by any of them runs all checks. Workers cannot change protected verifier files. Legacy jobs pin the current definitions on their next execution and use all checks when no selection was stored.
- Status and result commands read stored job state without starting a scheduler. Cancellation from another process reaches the active scheduler through SQLite. A database permits one scheduler owner at a time, and recovery only runs after ownership is acquired.
- Patches are validated before any write, including header consistency, reserved paths, traversal, and symlink/junction checks. CLI tools and configured checks are trusted host processes: worktrees are not an operating-system sandbox.
- Review cannot approve a truncated diff or prompt. Task evidence records the check indices and exact commit in `task-checks` artifacts. Check results record `passed`, `failed`, or `not_run`; the default configuration refuses unchecked handoffs and completion. Goal coverage depends on the acceptance checks configured for the target project.
- Git commands are argument arrays with `shell: false`. The commit author is set with `GIT_AUTHOR_*` and `GIT_COMMITTER_*` (`LLM Swarm` / `swarm@localhost`). The user's git config is not modified.
- Agent CLIs are not given a shell. `.cmd`, `.bat`, and `.ps1` shims are rejected. On Windows, point `opencode` at `opencode.exe` if PATH resolves `opencode.ps1`.
- The grok, opencode, and gemini profiles in the sample config were checked against local `--help` text on 2026-10-29. They were not called against a live model. `--always-approve` and `--yolo` are left off.
- A predecessor satisfies its dependents when the task is `review`, `revision`, or `done`. `done` is the post-approval state. Treating only `done` as satisfied would deadlock the job-level review.
- Deleting `swarm.md` does not change job status.
- The test runner was upgraded to Vitest 5 after the earlier installation issue. The current dependency audit reports zero vulnerabilities.
- This project's user-selected remote is [amosroger91/LLM-Swarm](https://github.com/amosroger91/LLM-Swarm). GitHub Actions checks formatting, lint, types, build, and tests on Windows and Linux with Node 22 and 24.

## Validation

```powershell
npm run format:check
npm run lint
npm run typecheck
npm run build
npm test
```

The automated suite uses real temporary Git repositories, mock providers, and separate CLI processes. `npx tsx scripts/ollama-smoke.ts` additionally exercises a live local Ollama model and verifies exact output bytes plus the unchanged base README. Its default model is `qwen2.5-coder:7b`; `SWARM_SMOKE_MODEL` overrides it.

Troubleshooting, backup, and restart behavior are in [docs/troubleshooting.md](docs/troubleshooting.md).

The music-app regression run and initial 10-case comparison are recorded in [the QA notes](docs/qa/2026-10-29-music-and-supervision.md). Reproduce it with `npx tsx scripts/benchmark.ts CONFIG OUTPUT_DIRECTORY`; set `SWARM_BENCHMARK_TOOLS=1` for native Ollama tools. Benchmark and live-model scripts make real provider requests; unit tests use local fixtures.
