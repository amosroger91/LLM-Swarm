# Configuration

Load order:

1. `llm-swarm --config <file>`
2. `SWARM_CONFIG`
3. Built-in default, which matches the Ollama profile in `config/swarm.example.yaml`

`dataDir` and `database` are resolved relative to the config file. Without a file, `dataDir` is `.swarm-data` under the process working directory. The database path is `database` or `<dataDir>/swarm.db`.

Put `dataDir` outside any repository you pass as `repo_path`. Nested git worktrees inside the target repo are rejected.

## Providers

`openai_compatible` fields: `baseUrl`, `model`, optional `apiKeyEnv`, `apiKeyOptional`, `jsonMode` (`off` or `json_object`), `timeoutMs`, `temperature`, and `capabilities`.

`cli` fields: `command`, `args`, `promptTransport` (`argv`, `stdin`, or `file`), `outputParser`, `timeoutMs`, `capabilities`, `envPass`, `maxStdoutBytes`, `documentedStatus`, and `notes`.

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

`envPass` is the only way a secret reaches a child process. Names must be identifiers. Values whose names contain `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, or `CREDENTIAL` are redacted from error text.

## Agents and profiles

An agent has a `role` (`planner`, `worker`, or `reviewer`) and a `provider` name. A profile points at one agent of each role. The role on the agent must match the slot. `workerCount` on a profile cannot exceed the cap.

`start_swarm`'s `config_profile` selects a profile. `worker_count` overrides the profile count when it is present.

## Decisions, git, and checks

```yaml
decision:
  policy: owner # owner | majority | unanimous
  quorum: 1
  ownerRole: reviewer
git:
  cleanupWorktrees: true
  preserveOnFailure: true
  allowPush: false
  allowMergeToBase: false
  allowRemotePr: false
checks:
  - command: npm
    args: ["test"]
```

Checks run in the integration worktree with `shell: false` and the allowlisted environment. An empty list is success and does not spawn anything.

## Limits

| Field                | Default |
| -------------------- | ------- |
| `defaultWorkerCount` | 2       |
| `maxWorkerCount`     | 5       |
| `defaultMaxAttempts` | 2       |
| `maxReviewRounds`    | 3       |
| `jobTimeoutMs`       | 1800000 |
| `providerTimeoutMs`  | 120000  |
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
