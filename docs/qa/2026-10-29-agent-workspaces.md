# Agent workspace verification — 2026-10-29

## Acceptance criteria and test plan

The change adds a complete worktree for each task attempt under the target repository, preserves dependency commits, and separates read-only CLI commands from scheduler startup. It also hardens patch destinations, delivers CLI system prompts, and requires complete review evidence.

Expected behavior and failure cases:

| Area               | Cases to exercise                                                            | Required result                                                                          |
| ------------------ | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Layout             | Concurrent jobs, retries, dry run, linked root                               | Unique job/task/attempt paths; dry run makes no workspace changes; linked roots rejected |
| Git                | Sequential shared-file work, agent-owned commits, moving main                | Dependency output visible; agent commits retained; base SHA remains pinned               |
| Patches            | Mismatched headers, traversal, aliases, junctions, special modes             | Reject before writing any file outside the permitted worktree                            |
| Lifecycle          | Status/result from another process, cancellation, crash, duplicate scheduler | Reads preserve state; active work aborts; only a dead owner is recovered                 |
| Context            | Relevant source, uncommitted files, credentials, sibling workspaces          | Use committed source from the assigned snapshot; exclude unrelated/sensitive paths       |
| Review             | Missing/failing checks, diff/prompt truncation                               | Explicit evidence states; no approval with unseen changes or required checks missing     |
| Cleanup            | Retain/remove successful work, unrelated folders                             | Report final state accurately; preserve integration; refuse unrelated paths              |
| Provider transport | argv, stdin, prompt file                                                     | System and user prompts both reach the child                                             |
| Git execution      | Repository hooks and worktree-root hook files                                | Coordinator operations do not execute either                                             |
| Live model         | Local Ollama creates an exact file                                           | Checks pass; base README unchanged; terminal result is approved                          |

## Evidence

- The original suite had 56 tests. New regression tests exercise the four reproduced defects and the cases above using temporary repositories, real Git operations, local mock providers, and separate Node processes.
- A live `qwen2.5-coder:7b` run completed job `892e97e1-a4f9-43c5-ad0a-72a95b3acf0e`. The integrated `hello.txt` is exactly `hello-from-swarm` plus a newline; the README remains exactly `base` plus a newline. The configured checker passed before reviewer approval.
- Live fixture: `C:/Users/roger/AppData/Local/Temp/llm-swarm-ollama-TLHbt8/repo/workspaces/892e97e1-a4f9-43c5-ad0a-72a95b3acf0e/integration/`.
- Local lint, type checking, formatting, and build checks are part of validation. GitHub Actions also runs the suite on Windows/Linux with Node 22/24; its final result is recorded in the PR.

## Scope

CLI provider transport is exercised with local fake executables. Grok, OpenCode, and Gemini account/model integrations are not claimed as live-tested. No production repository was used as a swarm target. No production deployment was performed. Host CLI execution is not an OS sandbox; trusted executables/configuration or a separate container/OS boundary remain necessary.
