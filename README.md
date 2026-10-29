# LLM Swarm

Local multi-agent orchestration for a software repo, exposed as an MCP server.

## Overview

LLM Swarm takes one task, asks a planner for a validated plan, and runs up to five workers in isolated git worktrees. A reviewer approves the integrated result or sends back one bounded revision. SQLite is the source of truth for jobs, tasks, chat, votes, and reviews. An optional `swarm.md` file is a generated snapshot. Nothing is pushed, merged to the base branch, or opened as a pull request unless that action is turned on in config. It is off by default.

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
        +--> git worktrees under dataDir, outside the target repo
        +--> optional dataDir/jobs/<id>/swarm.md
```

The scheduler, store, and providers can run without the MCP transport. See [docs/architecture.md](docs/architecture.md).

## Quick start

```powershell
npm install
npm run build
copy .env.example .env
npm run mcp
```

Point an MCP client at the stdio command `npm run mcp`, or `node dist/cli.js mcp` after a build. Pass `--config config/swarm.example.yaml` to use the sample file. With no config file and no `SWARM_CONFIG` variable, the process uses the built-in Ollama profile at `http://127.0.0.1:11434/v1`.

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

Copy `.env.example` to `.env` for local experiments. `.env` is gitignored. Provider and profile fields are documented in [docs/configuration.md](docs/configuration.md). The sample file is `config/swarm.example.yaml`.

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
- Workers commit in worktrees under `dataDir`, which must sit outside the target repository. The default `.swarm-data` directory is next to the config file, or next to the process working directory when no config file is used.
- Git commands are argument arrays with `shell: false`. The commit author is set with `GIT_AUTHOR_*` and `GIT_COMMITTER_*` (`LLM Swarm` / `swarm@localhost`). The user's git config is not modified.
- Agent CLIs are not given a shell. `.cmd`, `.bat`, and `.ps1` shims are rejected. On Windows, point `opencode` at `opencode.exe` if PATH resolves `opencode.ps1`.
- The grok, opencode, and gemini profiles in the sample config were checked against local `--help` text on 2026-10-29. They were not called against a live model. `--always-approve` and `--yolo` are left off.
- A predecessor satisfies its dependents when the task is `review`, `revision`, or `done`. `done` is the post-approval state. Treating only `done` as satisfied would deadlock the job-level review.
- Deleting `swarm.md` does not change job status.
- `npm audit` reports issues in Vitest 3's test runner (including tinypool). Installing Vitest 5 and ESLint 10 failed on npm 10.9.2 with an arborist `edgesOut` error, so the project stays on Vitest 3 and ESLint 9. Those findings are in the test toolchain, not in the server runtime.
- This repo was built in `C:\Users\roger\Documents\dev\LLM-Swarm`. The new-project convention asks for a Gitea remote and names the retired host `http://gitea.kscomputing.local:3000`. That host is not the live server. The live host is `https://gitea.kscomputing.com`. No remote was created and nothing was pushed. Create the empty repo and pass the `.com` URL before any push.

Troubleshooting, backup, and restart behavior are in [docs/troubleshooting.md](docs/troubleshooting.md).
