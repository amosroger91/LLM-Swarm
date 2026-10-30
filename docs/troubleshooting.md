# Troubleshooting

## The MCP client sees no tools, or the protocol breaks

Stdout is reserved for MCP. Logs are JSON lines on stderr. Do not write status to stdout from a wrapper.

This server uses `@modelcontextprotocol/server` v2: `registerTool` and `serveStdio`. The v1 helpers `server.tool()` and `StdioServerTransport` are not the API in this package.

Start it with `npm run mcp` or `node dist/cli.js mcp`. An optional config is `--config config/swarm.example.yaml`.

## A job stays `interrupted` after a restart

Startup recovery marks unfinished runs `interrupted`. A running task returns to `ready` when attempts remain, otherwise it becomes `failed`. Recurring maintenance or explicit resume can restart the job without rerunning successful prerequisites. Human-only pending decisions and capped recovery budgets prevent automatic retries. Use the dashboard or `node dist/cli.js resume JOB --config CONFIG`. Invalid stored plans require corrected work or a new job. See [supervision](supervision.md) for the external Windows watchdog that can restore a dead scheduler.

## Workers never start

- The plan was invalid twice. `swarm_status` shows `failed` and `review_state` `planning_failed`.
- `worker_count` is above the cap. The error names the cap and `allowWorkerCountAboveDefault`. The count is not silently reduced.
- The target already tracks files under `workspaces/`, or a workspace ancestor is a symlink/junction. Resolve that conflict before starting a job.
- `repo_path` is not the git root, or `base_branch` does not exist locally.
- The provider command was not found, or PATH resolved a `.cmd`, `.bat`, or `.ps1` shim. Point `command` at a real executable. On Windows that is often the `.exe` next to the npm shim.
- A dependency cycle, or a failed task that leaves dependents blocked, fails the job instead of waiting.

## The CLI profile does something unexpected

Grok, OpenCode, and Gemini were help-checked only. Their JSON parsers are best-effort. If a CLI prints a banner on stderr, that does not by itself fail the run. A non-zero exit does. Timeouts and output over `maxStdoutBytes` kill the process tree.

Do not add `--always-approve` or `--yolo` to a shared profile.

`--no-auto-update` was not in the grok help text captured on 2026-10-29, so the sample does not pass it.

## Ollama returns HTML or connection errors

The default base URL is `http://127.0.0.1:11434/v1`. The adapter appends `/chat/completions`. No API key is required when `apiKeyOptional` is true. A key is never written to SQLite. If a server echoes a key, the CLI redacts values of `OLLAMA_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `NVIDIA_API_KEY`, `XAI_API_KEY`, and `GEMINI_API_KEY` from log lines and provider errors.

## Git commits show the wrong author

Swarm commits set `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, and `GIT_COMMITTER_EMAIL` for that process only. The defaults are `LLM Swarm` and `swarm@localhost`. Change `gitAuthorName` and `gitAuthorEmail` in the YAML. The tool does not run `git config`.

## A merge conflict

The job fails. The error mentions the branch label. `git merge --abort` runs in the integration worktree. The task branches still contain their own commits. The base branch is not updated. With `preserveOnFailure: true`, task worktrees stay on disk. Set `cleanupWorktrees` behavior only when you mean to delete them.

Push, merge-to-base, and remote pull requests throw unless the matching `git.allow*` flag is true.

## Chat or vote errors

`swarm_chat` stores `message_type = chat`. Votes must name an existing option. The same voter replaces their previous vote, and a `decision.voted` event records `replaced: true`. An `owner` decision stays open until the reviewer resolves it. A majority or unanimous decision stays open until the quorum and the rule are both met.

## Backup and restore

From the CLI, which uses SQLite's online backup API:

```powershell
npx tsx src/cli.ts backup C:\backups\swarm.db --config config/swarm.example.yaml
```

Or, with the database closed:

```powershell
sqlite3 .swarm-data\swarm.db ".backup C:\backups\swarm.db"
```

Copy the `.db` file only after a checkpoint if you are copying by hand. Prefer `backup`, which also copies a consistent WAL snapshot. Restoring is replacing `swarm.db` while no scheduler is running. Worktrees are files on disk. The database stores their paths. Restoring the database without those directories leaves the history readable and the worktrees missing.

`swarm.md` is disposable. Regenerate it with `llm-swarm snapshot <job_id>`.

## Tests and the Node version

```powershell
npm run format
npm run lint
npm run typecheck
npm test
```

Tests use temporary directories, an in-memory workspace, a local HTTP mock, and `node` plus a fake script. They do not call Ollama, grok, opencode, gemini, or a remote git host.

`npm audit` can report Vitest 3 issues, including a tinypool advisory. An attempt to move to Vitest 5 and ESLint 10 failed on npm 10.9.2 (`Cannot read properties of null (reading 'edgesOut')` in arborist). The runtime dependencies are the MCP SDK, better-sqlite3, yaml, and zod. ESLint may warn that `eslint-visitor-keys` wants Node `^20.19`, `^22.13`, or `>=24`. This machine is Node v23.10.0. The engines field is `>=22`.

## Missing checks or incomplete review

The default requires automated checks. Add a checker appropriate to the target repository. `requireChecks: false` permits an explicitly unverified experiment and records `not_run` in the final report. A clipped diff or review prompt cannot be approved: increase `maxDiffChars` / `maxPromptChars` or split the job.

## A scheduler is already running

Only one scheduler owns a database at a time. Use `status`, `result`, or `cancel` from other terminals; these do not acquire ownership or run recovery. Stop the existing MCP scheduler before starting another. Recovery detects dead local PIDs, but does not steal another host's ownership record. Do not delete a live ownership record.

## Where the repo lives

The user selected [amosroger91/LLM-Swarm](https://github.com/amosroger91/LLM-Swarm) for this project. `origin` points there and GitHub Actions runs the project checks. Agent worktrees belong to each target repository; the swarm does not automatically publish their branches or merge the target's base branch.
