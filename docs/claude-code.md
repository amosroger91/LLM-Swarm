# Using the swarm from Claude Code

The swarm is an MCP server Claude Code can hand work to. Two kinds of offloading:

- **`delegate` / `delegate_map`**: one bounded question or chore, answered by a cheap model. The cheap model reads the files; Claude only reads the answer. This is where most token savings come from.
- **`start_swarm` + `swarm_wait`**: a multi-file implementation. The planner splits it into tasks, workers implement them in isolated git worktrees, checks and a reviewer gate completion. Claude waits on one call instead of polling.

## Install

```sh
npm install && npm run build
claude mcp add llm-swarm --scope user \
  -e GROQ_API_KEY=... -e GEMINI_API_KEY=... -e OPENROUTER_API_KEY=... \
  -- node /absolute/path/to/LLM-Swarm/dist/cli.js mcp --config /absolute/path/to/LLM-Swarm/config/hybrid.yaml
```

Keys are optional; any provider without one is skipped by failover. Check what works:

```sh
node dist/cli.js providers --config config/hybrid.yaml
```

The first MCP connection starts a detached daemon (the web dashboard plus the scheduler) and every later Claude Code session attaches to it. Jobs keep running after Claude Code exits; open the dashboard URL in `<dataDir>/daemon.log` (default http://127.0.0.1:4317) to plan, watch, and steer them. Environment variables reach the daemon from whichever MCP client started it, so pass keys in `claude mcp add`, or start the daemon yourself with `node dist/cli.js dashboard --config ...` from a shell that has them.

`--tools all` adds chat, voting, and planner-proposal tools. The default `core` set is smaller because every advertised tool costs Claude context on every turn; the dashboard covers the rest.

## Tools

| Tool                                                                          | Use it for                                                                                                     |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `delegate`                                                                    | Summarize/search/explain files, draft tests or boilerplate, review a diff. `files` accepts paths, dirs, globs. |
| `delegate_map`                                                                | The same task per file, in parallel; `reduce` merges the answers. For file sets too large for one call.        |
| `start_swarm`                                                                 | A feature or refactor with clear acceptance criteria. `dry_run: true` to review the plan first.                |
| `swarm_wait`                                                                  | Blocks until the job finishes or needs an answer (default 300 s). Use instead of polling.                      |
| `swarm_status`                                                                | Compact status. `verbose: true` for the full call log and blocker evidence.                                    |
| `swarm_result`                                                                | Final report, with the integration branch to merge.                                                            |
| `swarm_jobs`                                                                  | Recent jobs.                                                                                                   |
| `swarm_providers`                                                             | Which models are healthy or cooling down, the failover chains, and delegation totals.                          |
| `resolve_swarm_decision`, `resume_swarm`, `launch_swarm_plan`, `cancel_swarm` | Steering.                                                                                                      |

Delegate output ends with a one-line footer such as `[groq/llama-3.3-70b after ollama-chat:transient · 3 files · 4s 2100+180 tok]`, showing which model answered and whether it failed over.

## Teach Claude when to delegate

Add something like this to your project's `CLAUDE.md` (or `~/.claude/CLAUDE.md`):

```md
## Offloading to llm-swarm

- Before reading more than ~3 files just to understand them, call `delegate` with the files
  and a specific question instead. Read files yourself only when you are about to edit them.
- Use `delegate` for first drafts of tests, docs, fixtures, and boilerplate, then review them.
- Use `delegate_map` (with `reduce`) for questions that span a whole directory.
- For multi-file implementation work that can run unattended, use `start_swarm`, then
  `swarm_wait`. Merge the integration branch from `swarm_result` after reviewing it.
- Delegated answers come from smaller models: verify anything you act on.
```

## Profiles in `config/hybrid.yaml`

| Profile  | Planner / reviewer            | Workers                                  |
| -------- | ----------------------------- | ---------------------------------------- |
| `hybrid` | Claude Code → Gemini → Ollama | Ollama → Groq → Gemini → OpenRouter free |
| `claude` | Claude Code → Gemini → Ollama | Claude Code (Sonnet)                     |
| `local`  | Ollama → Gemini → Groq        | Ollama → Groq → Gemini → OpenRouter free |

Pick one with `config_profile` on `start_swarm`, or in the dashboard's New mission dialog. The Claude Code planner replaces Claude Code's default system prompt and tool set, which measured at about 3.2K instead of 20.2K input tokens per call.

## Limits worth knowing

- `delegate` refuses context over `delegate.maxInputChars` (default 120 000) rather than truncating; use `delegate_map`.
- Paths must stay inside `root` (default: the Claude Code project directory).
- Long `delegate` calls depend on the MCP client's tool timeout. For Claude Code, raise it with `MCP_TOOL_TIMEOUT` (milliseconds) if slow local models time out.
