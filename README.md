# LLM Swarm

Local multi-agent orchestration for a software repo, exposed as an MCP server.

## Overview

LLM Swarm takes one task, asks a planner for a validated plan, and runs up to five workers per job in separate Git worktrees. Each worker gets a complete checkout under the target repository's `workspaces/` directory, its own branch, and the committed output of its dependencies. SQLite is the source of truth for jobs, tasks, chat, votes, and reviews. The coordinator integrates the results, runs configured checks, and asks a reviewer to assess the complete diff. Remote pushes, changes to the base branch, and PR creation are not automated by the swarm.

## Architecture

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

```powershell
npm install
npm run build
npm run mcp -- --config config/swarm.example.yaml
```

Point an MCP client at `node dist/cli.js mcp --config config/swarm.example.yaml` after a build. Configure `checks` for the target repository before starting an implementation job. Checks are required by default; a deliberately unverified experiment can set `requireChecks: false`. With no config file and no `SWARM_CONFIG` variable, the process uses the built-in Ollama profile at `http://127.0.0.1:11434/v1`.

The target repository must already have a commit. A typical checked run uses a command such as `node scripts/verify.mjs` from that repository. Commands run directly without a shell; on Windows, use a real executable rather than `npm.cmd`. Install any dependencies the checks require in the worktree or configure an appropriate executable path.

Check a job from another terminal:

```powershell
npx tsx src/cli.ts jobs --config config/swarm.example.yaml
npx tsx src/cli.ts status <job_id> --config config/swarm.example.yaml
```

## Configuration

Secrets are read from the environment. The database, config, and logs store the variable name, not the value.

| Variable         | Required | Description                                                           |
| ---------------- | -------- | --------------------------------------------------------------------- |
| `OLLAMA_API_KEY` | optional | Sent only when set. The sample Ollama provider works with no key.     |
| `OPENAI_API_KEY` | optional | For an OpenAI-compatible provider that names this variable.           |
| `XAI_API_KEY`    | optional | Passed to the grok CLI only when that profile's `envPass` lists it.   |
| `GEMINI_API_KEY` | optional | Passed to the gemini CLI only when that profile's `envPass` lists it. |
| `SWARM_CONFIG`   | optional | Path to a YAML config. `--config` wins over this variable.            |

`.env.example` lists supported variables. Set them in the process environment; the app does not automatically load `.env`. Node's `--env-file` option can load a local file when starting the built CLI. Provider and profile fields are documented in [docs/configuration.md](docs/configuration.md).

## Usage

### MCP tools

| Tool              | What it does                                                                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start_swarm`     | Persists a job and returns `{ job_id, status }` without waiting for the swarm to finish. Optional `base_branch`, `worker_count`, `config_profile`, and `dry_run`. |
| `swarm_status`    | Job status, task counts, active workers, recent events, review state.                                                                                             |
| `swarm_chat`      | Appends a message to the job chat room.                                                                                                                           |
| `swarm_decisions` | Lists decisions, options, votes, and rationale.                                                                                                                   |
| `swarm_vote`      | Records or replaces the caller's vote. Default voter is `mcp-client`.                                                                                             |
| `swarm_result`    | Final report when the job is terminal, otherwise `{ ready: false }`.                                                                                              |
| `cancel_swarm`    | Stops launching new work. Idempotent for a job that already finished.                                                                                             |

`dry_run` stores the plan and does not launch workers or change git.

### CLI

| Command             | What it does                                         |
| ------------------- | ---------------------------------------------------- |
| `mcp`               | MCP server on stdio. Diagnostics go to stderr.       |
| `migrate`           | Opens the database and applies migrations.           |
| `jobs`              | Prints recent jobs as JSON.                          |
| `status <job_id>`   | Prints one job's status.                             |
| `result <job_id>`   | Prints the final report, or an in-progress response. |
| `cancel <job_id>`   | Requests cancellation.                               |
| `snapshot <job_id>` | Regenerates `swarm.md`.                              |
| `backup <file>`     | Copies the SQLite database.                          |

## Project structure

```
src/cli.ts                 local CLI
src/mcp/server.ts          MCP tools
src/orchestration/         planner validation, scheduler, prompts, snapshots
src/db/                    SQLite connection, migrations, store
src/providers/             OpenAI-compatible and CLI adapters
src/git/workspace.ts       worktrees, or an in-memory workspace for tests
src/safety/                paths, process spawn, redaction, remote-git policy
config/swarm.example.yaml  Ollama default plus help-checked CLI profiles
test/                      Vitest suite, no network and no real agent CLIs
```

## Tech stack

- Node.js 22 or newer. This tree was exercised on Node v23.10.0. Current LTS is Node 24; Node 24 was not required for the run.
- TypeScript, ESM, Zod 4, better-sqlite3, Vitest 3, ESLint 9, Prettier.
- MCP TypeScript SDK v2 (`@modelcontextprotocol/server` and `@modelcontextprotocol/client`). This is not the deprecated `@modelcontextprotocol/sdk` v1 package. Tools use `registerTool` with Zod object schemas and `serveStdio`.

## Notes / conventions

- One local scheduler. SQLite coordinates claims inside that design. It is not a distributed queue.
- Worktrees live at `<repo>/workspaces/<job>/agent-<task>-<attempt>/`. They are retained by default for inspection. Set `git.cleanupWorktrees: true` to remove successful task worktrees; integration remains available. `dataDir` holds the database and snapshots, separate from worktree storage.
- The coordinator adds `/workspaces/` to Git's local exclude file. This repository also excludes it from lint, formatting, tests, and source discovery. Other target projects must exclude it from their own build/test globs and watchers; see [workspace setup](docs/workspaces.md).
- Every job pins its starting commit. Dependent workers inherit prerequisite commits. Independent tasks must own disjoint file areas; explicit dependencies permit sequential edits to the same file.
- Status and result commands read stored job state without starting a scheduler. Cancellation from another process reaches the active scheduler through SQLite. A database permits one scheduler owner at a time, and recovery only runs after ownership is acquired.
- Patches are validated before any write, including header consistency, reserved paths, traversal, and symlink/junction checks. CLI tools and configured checks are trusted host processes: worktrees are not an operating-system sandbox.
- Review cannot approve a truncated diff or prompt. Check results record `passed`, `failed`, or `not_run`; the default configuration refuses unchecked completion.
- Git commands are argument arrays with `shell: false`. The commit author is set with `GIT_AUTHOR_*` and `GIT_COMMITTER_*` (`LLM Swarm` / `swarm@localhost`). The user's git config is not modified.
- Agent CLIs are not given a shell. `.cmd`, `.bat`, and `.ps1` shims are rejected. On Windows, point `opencode` at `opencode.exe` if PATH resolves `opencode.ps1`.
- The grok, opencode, and gemini profiles in the sample config were checked against local `--help` text on 2026-10-29. They were not called against a live model. `--always-approve` and `--yolo` are left off.
- A predecessor satisfies its dependents when the task is `review`, `revision`, or `done`. `done` is the post-approval state. Treating only `done` as satisfied would deadlock the job-level review.
- Deleting `swarm.md` does not change job status.
- `npm audit` reports issues in Vitest 3's test runner (including tinypool). Installing Vitest 5 and ESLint 10 failed on npm 10.9.2 with an arborist `edgesOut` error, so the project stays on Vitest 3 and ESLint 9. Those findings are in the test toolchain, not in the server runtime.
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
