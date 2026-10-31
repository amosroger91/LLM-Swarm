# Local control center

Build and run:

```powershell
npm install
npm run build
node dist/cli.js dashboard --config config/swarm.example.yaml
```

Open http://127.0.0.1:4317. An optional positional port follows `dashboard`. The server binds only to loopback and uses the same SQLite database as MCP and the CLI. One scheduler owns a database. The dashboard advertises itself in `<dataDir>/dashboard.json`, and `mcp` processes attach to it as clients instead of starting a second scheduler, so the web UI and any number of Claude Code sessions share the same jobs. When MCP starts first, it launches the dashboard daemon for you.

**Models & routing** in the sidebar shows each provider's health (healthy, cooling down after a rate limit, or unavailable), when it comes back, its last error, the failover chain for every agent, and recent `delegate` calls with how much context they read on Claude's behalf.

The sidebar lists missions. Each mission shows its original human goal, task states and dependencies, active runs, retry counts, reported token usage, checks, reviews, worktrees, commits, messages, and blocker evidence. Updates poll every two seconds. Token totals include only usage actually reported by providers; unavailable usage is not treated as zero cost.

The overview's Verification panel uses the mission's pinned check count and required-check policy when available. It shows recent task, dependency-preflight, and integration check evidence. A task-check record includes its task/run, exact commit, executed check indices, status, and diagnostic output; stored records remain in **Artifacts** as `task-checks` or `dependency-checks`. Long diagnostics may be truncated, with their metadata preserved. Passing the task gate releases work to dependents. Each handoff reruns the union of the task's and every dependency ancestor's selections. Final integration checks and reviewer approval still determine completion. `swarm.md` also lists each task's selection; omission by a task or any ancestor means all configured checks.

Use **New mission** to choose a repository, existing branch, worker count, and model profile. **Plan only** stores the graph without creating worktrees; **Launch this plan** starts execution after review.

The planning room calls the job's snapshotted planner profile. Questions receive conversational answers. Implementation requests can produce persisted task proposals with file ownership, dependencies, and interface contracts. **Add tasks to mission** validates the combined graph before inserting work. Existing tasks are retained. Overlapping files require dependencies on their previous owners. New work appended during review prevents completion of a stale integration snapshot.

Blocker cards show the cause, recurrence, attempted fixes, and next action. Answer forms deliver a selected option and concrete guidance. Resolved options and rationale appear in worker context. Routine questions can be answered by automatic supervision; human-only questions remain explicit requests for the caller.

The local HTTP API does not accept SQL or arbitrary commands. `/api/rpc` exposes only the orchestrator methods listed in `src/mcp/backend.ts`, behind the same token, host, and origin checks. Control requests require a per-process session token, exact host, and matching origin. Browser-rendered repository and agent content is escaped. A backend restart rotates the token; the browser reacquires it from the same-origin page without discarding the current mission selection.

The dashboard is deliberately local. Running it on a shared network would require a separate authenticated transport and access model.
