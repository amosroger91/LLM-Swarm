# Configuration

Load order:

1. `llm-swarm --config <file>`
2. `SWARM_CONFIG`
3. Built-in default, which matches the Ollama profile in `config/swarm.example.yaml`

`dataDir` and `database` are resolved relative to the config file. Without a file, `dataDir` is `.swarm-data` under the process working directory. The database path is `database` or `<dataDir>/swarm.db`.

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

`cli` fields: `command`, `args`, `promptTransport` (`argv`, `stdin`, or `file`), `outputParser`, `timeoutMs`, `capabilities`, `envPass`, `maxStdoutBytes`, `documentedStatus`, `notes`, and optional `fileEditing`.

Set `fileEditing: false` for a read-only CLI that returns patches from supplied context. Workers then receive the patch-only contract; the coordinator validates ownership, applies the diff, and runs required checks. The default preserves CLI workers that edit their own worktree directly. This describes the provider's capabilities and does not change its sandbox or command policy.

`capabilities` is `structuredOutput`, `toolCalling`, `streaming`, and `nonInteractive`. Workers with `structuredOutput: false` may return plain text, which is stored as a done result. Planners and reviewers always require JSON.

There is no `apiKey` field. A config that contains one fails validation.

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

An agent has a `role` (`planner`, `worker`, or `reviewer`) and a `provider` name. A profile points at one agent of each role. The role on the agent must match the slot. `workerCount` on a profile cannot exceed the cap.

`start_swarm`'s `config_profile` selects a profile. `worker_count` overrides the profile count when it is present.

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
  - command: node
    args: ["scripts/verify.mjs"] # use an actual checker from the target project
```

Checks run in the integration worktree with `shell: false`, the allowlisted environment, and job cancellation. On Windows, `.cmd`, `.bat`, and `.ps1` shims are rejected; use a real executable, such as Node with the checker script as an argument. Dependencies required by the checker must be available in that checkout.

An empty list records `not_run`. The default `requireChecks: true` fails that job before model review. Set it to `false` only for deliberately unverified runs; the report retains the missing-check evidence. An incomplete diff or review prompt always fails before approval, regardless of `requireChecks`.

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
