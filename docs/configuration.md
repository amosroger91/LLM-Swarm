# Configuration

Load order:

1. `llm-swarm --config <file>`
2. `SWARM_CONFIG`
3. Built-in default, which matches the Ollama profile in `config/swarm.example.yaml`

`dataDir` and `database` are resolved relative to the config file, and a leading `~/` means your home directory. Pointing every project's config at one `dataDir` (as `config/hybrid.yaml` does with `~/.llm-swarm`) gives you one daemon, one dashboard, and one job history for all of them. Without a file, `dataDir` is `.swarm-data` under the process working directory. The database path is `database` or `<dataDir>/swarm.db`.

`dataDir` stores SQLite and snapshots. Agent worktrees live under `<repo_path>/workspaces/<job-id>/` independently of `dataDir`. Keep the data directory ignored if it is inside the target repository. See [workspaces.md](workspaces.md) for tool exclusions and retention.

## Providers

`openai_compatible` fields: `baseUrl`, `model`, optional `apiKeyEnv`, `apiKeyOptional`, `jsonMode` (`off` or `json_object`), `timeoutMs`, `temperature`, and `capabilities`.

Additional optional fields are `protocol` (`openai` or `ollama`), `contextTokens`, `maxOutputTokens`, and `maxToolRounds`. Native Ollama uses `/api/chat`, `options.num_ctx`, and native tool arguments. The OpenAI-compatible endpoint uses `/chat/completions`; context-window control is not assumed to be supported there.

```yaml
type: openai_compatible
protocol: ollama
baseUrl: http://127.0.0.1:11434
model: YOUR_INSTALLED_MODEL
apiKeyOptional: true
jsonMode: json_object
contextTokens: 16384
maxOutputTokens: 4096
maxToolRounds: 16
capabilities:
  structuredOutput: true
  toolCalling: true
  streaming: false
  nonInteractive: true
```

Tool workers operate in bounded turns with scoped file access, configured checks, coordination tools, and explicit help requests. `providerTimeoutMs` bounds an HTTP request, `agentTimeoutMs` bounds the complete tool turn, and `jobTimeoutMs` bounds the job. Roles can already use different providers/models through their agent profiles. See [supervision](supervision.md) for recovery and maintenance limits.

`cli` fields: `command`, `args`, `promptTransport` (`argv`, `stdin`, or `file`), `outputParser`, `timeoutMs`, `capabilities`, `envPass`, `maxStdoutBytes`, `documentedStatus`, `notes`, and optional `fileEditing` and `model`. An argument of exactly `{model}` is replaced with `model`.

The `claude-json` parser reads Claude Code's `claude -p --output-format json` envelope: the answer, token usage (including cache reads), and `is_error` results such as usage limits, which failover treats as exhaustion. See the `claude` provider in `config/hybrid.yaml`.

Set `fileEditing: false` for a read-only CLI that returns patches from supplied context. Workers then receive the patch-only contract; the coordinator validates ownership, applies the diff, and runs required checks. The default preserves CLI workers that edit their own worktree directly. This describes the provider's capabilities and does not change its sandbox or command policy.

`capabilities` is `structuredOutput`, `toolCalling`, `streaming`, and `nonInteractive`. Workers with `structuredOutput: false` may return plain text, which is stored as a done result. Planners and reviewers always require JSON.

`apiKeyEnv` normally names an environment variable. An ignored local YAML file may instead provide `apiKey: <credential>`. The loader places that value in the current process environment and retains only the variable reference in validated configuration, job profiles and SQLite. For compatibility it also recognizes OpenRouter/NVIDIA credentials pasted into `apiKeyEnv`; the value is never used as a variable name or saved in a job snapshot. Keep credential-bearing configuration out of version control.

At CLI startup, the selected Ollama profile is checked against `/api/show`. If the selected model reports no tool support, workers use patch responses from that same model; the saved YAML and chosen model are unchanged. This avoids advertising tools to a completion-only base model. It does not turn a base model into an instruction-tuned model.

### Automatic failover

Planner conversations use compact task/blocker/check summaries with read-only tools for specific missing evidence. The dashboard accepts a message immediately, clears the composer, and polls its durable pending/completed/failed state. A failure appears in the conversation with retry; a service restart marks an unfinished reply failed instead of leaving it pending forever. Enter sends and Shift+Enter inserts a newline. `POST /api/jobs/:id/chat` accepts `background: true` for this queued behavior (HTTP 202); omitting it keeps the synchronous reply contract. Chat turns have a maximum 90-second deadline, shared by the configured fallback candidates. Provider quotas still apply.

Set `costPolicy: local_or_free` to fail closed on cost: only non-CLI providers explicitly declared with `costClass: local` or `costClass: free` may run, including the primary. Metered and unclassified providers are skipped, and exhausting permitted routes creates a blocker. `configured` is the compatibility default. Cost classes are configuration declarations, not a vendor billing API; a `free` route must use an account on that provider's free tier. The framework never upgrades accounts or purchases quota.

For quota-limited API providers, set `maxInputChars` to bound the serialized request (including system messages and tool definitions) before any network request is sent. This is a character limit, not a promise about model tokenization. Oversized requests raise a context blocker rather than consuming another attempt at the service. Under local/free policy, tool workers retain the assigned task instructions and fetch source in pages of at most 4,000 characters instead of resending the repository on every turn. The full immutable human request remains in SQLite and is accessible through the paginated `read_goal` tool; workers must consult it before product or scope decisions. Recent coordination excerpts are marked as excerpts and can be refreshed through tools. Required review evidence and checks are never weakened to fit a budget.

An agent can list up to four ordered `fallbackProviders`. Each name references a provider definition, so another model on the same endpoint and a different provider use the same mechanism:

```yaml
agents:
  local-worker:
    role: worker
    provider: local-qwen
    fallbackProviders: [local-qwen-backup, groq-worker]
```

Only listed providers can be selected; there is no automatic discovery, upgrade, or CLI substitution. Choose backups whose API usage you authorize. Credential values stay outside saved profiles; provider definitions and credential references are snapshotted with each new job, including its backups. Existing jobs keep their snapshots.

On timeouts, connection/API errors, missing credentials, tool-loop exhaustion, or invalid response contracts, the coordinator tries each candidate once within the existing turn deadline. Each gets a share of the remaining time, failed candidates cool down for one minute in the running scheduler, and compatible backups continue in the same scoped worktree after pending tool operations settle. A provider that cannot preserve required editing capabilities is skipped. Cancellation, containment failures, rejected reviews, and legitimate task blockers do not trigger a model switch. Completed prerequisites remain intact; the same checks and independent review still apply.

Every switch and exhaustion is recorded in events and shared messages. The dashboard displays each role's primary and ordered backups; call evidence records the provider/model actually used. Exhausting the list surfaces a blocker through the existing recovery mechanism. A restart restores the saved candidates; the short health cooldown is process-local.

OpenAI-compatible HTTP 429 responses with a short `Retry-After` (or a reported cooldown) receive at most two retries within the deadline before failover. Native Ollama accepts optional `thinking: false` to disable model thinking where supported, without changing its model. The default leaves the model's thinking setting alone.

### Sample CLI profiles

These profiles are not selected by `defaultProfile`. They record flags that appeared in local help text on 2026-10-29. No live model call was made.

| Profile  | Arguments                                                     | Parser            | Left off on purpose                                                       |
| -------- | ------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------- |
| grok     | `--output-format json --cwd {cwd} --prompt-file {promptFile}` | `grok-json`       | `--always-approve`. `--no-auto-update` was not in the captured help text. |
| opencode | `run --format json --dir {cwd} {prompt}`                      | `opencode-events` | `-p` is the password flag, not the prompt.                                |
| gemini   | `--skip-trust --output-format json -p {prompt}`               | `gemini-json`     | `--approval-mode` and `--yolo`.                                           |

On Windows, `opencode` from npm is often `opencode.ps1`. The adapter rejects `.ps1`, `.cmd`, and `.bat`. Set `command` to the sibling `opencode.exe`.

`envPass` controls additional environment variables passed to children. Names must be identifiers. Values whose names contain `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, or `CREDENTIAL` are redacted from error text. Both system instructions and the user prompt are delivered through argv, stdin, or a prompt file. CLI executables retain the host user's filesystem permissions, including access to their own saved credentials; the environment allowlist is not a sandbox.

## Agents and profiles

An agent has a `role` (`planner`, `worker`, or `reviewer`), a `provider` name, and optional `fallbackProviders` (below). See [failover.md](failover.md) for cooldowns and retry rotation. A profile points at one agent of each role. The role on the agent must match the slot. `workerCount` on a profile cannot exceed the cap.

`start_swarm`'s `config_profile` selects a profile. `worker_count` overrides the profile count when it is present.

## Delegation and the daemon

```yaml
delegate:
  agent: delegate # any agent; defaults to the default profile's worker
  maxInputChars: 120000 # larger requests are refused; use delegate_map
  maxOutputChars: 12000
  maxConcurrency: 4 # parallel calls in delegate_map
  maxFiles: 200
dashboard:
  port: 4317
  autoStart: true # `mcp` starts a detached dashboard daemon when none is running
```

The `mcp` command first looks for `<dataDir>/dashboard.json` written by a live dashboard and proxies every tool call to it. If there is none and `autoStart` is on, it starts `dashboard` as a detached process (log: `<dataDir>/daemon.log`; if the port is taken it picks a free one) and attaches. With `autoStart: false`, or `mcp --in-process`, the MCP process runs its own scheduler as before. See [claude-code.md](claude-code.md).

## Decisions, git, and checks

```yaml
decision:
  policy: owner # owner | majority | unanimous
  quorum: 1
  ownerRole: reviewer
  blockOnQuestions: true
git:
  cleanupWorktrees: false
  preserveOnFailure: true
  allowPush: false
  allowMergeToBase: false
  allowRemotePr: false
requireChecks: true
checks:
  - name: Project acceptance
    command: node
    args: ["scripts/verify.mjs"] # use an actual checker from the target project
    protectedPaths: ["scripts/verify.mjs"]
```

Checks run in each task's worktree before handoff and all run again in the integration worktree, with `shell: false`, the allowlisted environment, and job cancellation. On Windows, `.cmd`, `.bat`, and `.ps1` shims are rejected; use a real executable, such as Node with the checker script as an argument. Dependencies required by the checker must be available in each checkout. A checker must leave HEAD and the Git working tree unchanged; ignore generated build output in the target project before running it.

Task plans may set `verificationChecks` to a nonempty array of unique zero-based indices into `checks`. Indices must identify existing configured commands. Each handoff reruns the union of the task's and every dependency ancestor's selections to detect dependent regressions. Omission by the task or any ancestor runs all configured checks, including for legacy tasks and final revision tasks. The planner receives the check catalog and may select indices; it cannot supply executable commands. All checks still run after integration, regardless of task selections.

Select checks that can pass with only the task and its dependencies implemented. For example, a target repository with independent queue and library modules can provide these existing acceptance files:

```yaml
requireChecks: true
checks:
  - name: Queue acceptance # index 0
    command: node
    args: ["--test", "test/queue.acceptance.test.mjs"]
    protectedPaths: ["test/queue.acceptance.test.mjs"]
  - name: Library acceptance # index 1
    command: node
    args: ["--test", "test/library.acceptance.test.mjs"]
    protectedPaths: ["test/library.acceptance.test.mjs"]
```

The queue task can select `verificationChecks: [0]`; the library task can select `[1]`. Each file must test its own module without depending on unfinished independent work. A wiring task that depends on both reruns both checks even if its own selection contains only `[1]`, because check `0` is inherited from the queue ancestor. It can also omit the selection to run all checks. If only a whole-app checker exists, keep the change in one task or configure narrower check commands first. The framework runs the supplied suite; it does not automatically generate acceptance tests or establish that the suite covers every part of the human goal.

`name` is an optional evidence label. `protectedPaths` optionally lists repository-relative files or directories that workers must preserve. The union across all checks is protected for every worker, including revisions, and applies to direct file tools, returned patches, agent commits, and checkpoints. Protection is explicit: include imported verifier helpers, fixtures, and configuration when they must remain independent. With the field omitted, no additional paths are protected. Paths cannot be absolute, traverse outside the repository, or contain globs.

The job pins its check definitions, protected paths, and `requireChecks` policy before implementation. Restarting with an edited config does not change that job's verification contract or the meaning of its stored indices. Start a new job to use new definitions. Existing jobs from before this feature pin the current definitions on their next execution; missing task selections default to all checks.

A `task-checks` artifact records the task/run, check indices, commit, status, and diagnostic summary. If a prerequisite commit has no matching successful evidence, the coordinator verifies the assembled dependency snapshot before starting the worker and records `dependency-checks`. Failed task checks keep the commit as a scoped repair checkpoint and return their evidence to the next bounded attempt; dependents wait for a successful gate. A worker's own `run_check` call does not replace the coordinator's gate. Long diagnostic summaries may be truncated while the JSON record and verification metadata remain intact.

An empty list records `not_run`. The default `requireChecks: true` fails the task before handoff. Set it to `false` only for deliberately unverified runs; the report retains the missing-check evidence at the task and integration stages. An incomplete diff or review prompt always fails before approval, regardless of `requireChecks`.

## Limits

| Field                | Default |
| -------------------- | ------- |
| `defaultWorkerCount` | 2       |
| `maxWorkerCount`     | 5       |
| `defaultMaxAttempts` | 2       |
| `maxReviewRounds`    | 3       |
| `jobTimeoutMs`       | 1800000 |
| `providerTimeoutMs`  | 120000  |
| `agentTimeoutMs`     | 900000  |
| `maxPromptChars`     | 80000   |
| `maxResponseChars`   | 200000  |
| `maxMessageChars`    | 16000   |
| `maxDiffChars`       | 50000   |

## Custom providers

```ts
import { registerProviderBuilder } from "llm-swarm";

registerProviderBuilder("echo-driver", (config, context) => ({
  name: context.name,
  capabilities: config.capabilities,
  complete: async () => ({ text: "ok", provider: context.name }),
}));
```

Register the builder in the process that constructs the orchestrator, before a job selects that provider. The scheduler calls `createProvider` and does not know about the driver.
