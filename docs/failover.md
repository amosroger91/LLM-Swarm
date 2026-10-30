# Model routing and failover

Each agent names a primary provider and an ordered list of `fallbacks`:

```yaml
agents:
  worker:
    role: worker
    provider: ollama-tools
    fallbackProviders: [groq, gemini-api, openrouter-free]
```

Every call goes through the chain. The first available provider answers; when it fails with a recoverable error (HTTP error, timeout, malformed or contract-violating output, tool-loop limit, context overflow, missing key, or a CLI that crashed, hit a usage limit, or is not installed), the next one gets the same request, with a note that partial edits may already be in the worktree. The turn's deadline is split across the remaining candidates, so a hung provider cannot use up the whole budget. Planner, worker, reviewer, and planner-chat responses are validated against their contracts before a fallback's answer is accepted.

Errors that are not recoverable, such as an unsafe path or a cancellation, never switch providers.

## Cooldowns

A failed provider is skipped by later requests until its cooldown ends. The length depends on the failure:

| Kind          | Examples                                                                      | Cooldown                                                 |
| ------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------- |
| `exhausted`   | HTTP 429 or 402; quota, rate-limit, or usage-limit text (incl. Claude Code's) | `Retry-After` if sent, else 1 min doubling to 30 min     |
| `unavailable` | HTTP 401/403/404, missing API key, CLI not installed, bad config              | 60 min                                                   |
| `transient`   | Network error, timeout, 5xx, CLI crash                                        | 15 s doubling to 10 min                                  |
| `output`      | Malformed or invalid JSON, tool-round limit, context overflow                 | 15 s; 2 min after 3 in a row, so other models get a turn |

A success clears the cooldown. When every provider is cooling down or blocked, the call fails visibly with `providers_exhausted` and the job records a blocker, rather than hammering a provider that just failed.

`costPolicy: local_or_free` restricts every chain to providers declared `costClass: local` or `free`; see [configuration.md](configuration.md).

## When a model messes up

A worker that reports failure, returns an unusable answer, or hits a retryable error gets a task retry (up to `defaultMaxAttempts`). The retry starts at the next provider in the chain: attempt 2 begins with the second provider, attempt 3 with the third, wrapping around. Reviewer-requested revisions and the recovery supervisor work as before.

## Mixing provider types

Planner and reviewer chains can mix anything: a Claude Code CLI planner can fall back to Gemini over HTTP, then to local Ollama. For a worker that edits files, a fallback that cannot edit files (no tool calling, or a CLI with `fileEditing: false`) is skipped, so keep worker chains to providers that edit the same way.

## Seeing it work

- `swarm_providers` (MCP) or **Models & routing** in the dashboard: health, cooldowns, last error, failover chains, and delegation history.
- Job events include `provider.failover` with the providers that failed and the one that served.
- `node dist/cli.js providers --config ...` pings every provider once.

Health is held in the daemon's memory and resets when it restarts. Each job snapshots its chains when it starts, so editing the config affects new jobs only.
