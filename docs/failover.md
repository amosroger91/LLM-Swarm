# Model routing and failover

Each agent names a primary provider and an ordered list of `fallbacks`:

```yaml
agents:
  worker:
    role: worker
    provider: ollama-tools
    fallbacks: [groq, gemini-api, openrouter-free]
```

Every call goes through the chain. The first healthy provider answers; when it fails, the next one gets the same request.

## What counts as a failure

| Kind          | Examples                                                                      | Cooldown                                                 |
| ------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------- |
| `exhausted`   | HTTP 429 or 402; quota, rate-limit, or usage-limit text (incl. Claude Code's) | `Retry-After` if sent, else 1 min doubling to 30 min     |
| `unavailable` | HTTP 401/403/404, missing API key, CLI not installed, bad config              | 60 min                                                   |
| `transient`   | Network error, timeout, 5xx, CLI crash                                        | 15 s doubling to 10 min                                  |
| `output`      | Malformed JSON, tool-round limit, context overflow                            | None; after 3 in a row, 2 min so other models get a turn |
| `cancelled`   | Job cancelled or shut down                                                    | Never fails over                                         |

A success clears the provider's cooldown. Providers in cooldown are tried last rather than skipped, so a request only fails after every provider in the chain has been asked.

## When a model messes up

A worker that reports failure, returns an unusable answer, or hits a retryable error gets a task retry (up to `defaultMaxAttempts`). The retry starts at the next provider in the chain: attempt 2 begins with the second provider, attempt 3 with the third, wrapping around. Reviewer-requested revisions and the recovery supervisor work as before.

## Compatibility rules

Planners and reviewers use the same prompt for every provider, so their chains can mix anything: a Claude Code CLI planner can fall back to Gemini over HTTP, then to local Ollama.

Workers receive a prompt shaped by how they edit files, so every provider in a worker chain must share a contract (validated when the config loads):

| Contract           | Providers                                                             |
| ------------------ | --------------------------------------------------------------------- |
| `edits-with-tools` | `openai_compatible` with `toolCalling: true`                          |
| `edits-checkout`   | `cli` with file editing (default)                                     |
| `returns-patch`    | `openai_compatible` without tools, or `cli` with `fileEditing: false` |

Providers in one worker chain must also agree on `structuredOutput`.

## Seeing it work

- `swarm_providers` (MCP) or **Models & routing** in the dashboard: health, cooldowns, last error, failover chains, and delegation history.
- Job events include `provider.failover` with the providers that failed and the one that served.
- `node dist/cli.js providers --config ...` pings every provider once.

Health is held in the daemon's memory and resets when it restarts. Each job snapshots its chains when it starts, so editing the config affects new jobs only.
