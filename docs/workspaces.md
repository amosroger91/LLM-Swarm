# Agent workspaces

Each worker receives a complete checkout, including the source tree, tests, and project configuration:

```text
target-repository/
  src/
  package.json
  workspaces/
    <job-id>/
      agent-api-1/
        src/
        package.json
      agent-tests-1/
        src/
        package.json
      agent-tests-2/     # a retry has a fresh checkout and branch
      integration/       # combined code used for checks and review
```

The branch format is `codex/swarm/<job-id>/<task-id>/<attempt>`. Job and task identifiers are validated, and complete IDs prevent short-prefix collisions. Worktrees share the underlying repository's objects and refs but have separate working files, HEAD, and staging areas.

The coordinator creates branches, pins the job's original commit, merges prerequisite commits before launching a dependent agent, and integrates successful results. A CLI agent may commit its own work; the coordinator verifies those commits descend from the assigned snapshot and contain only owned files. HTTP agents return patches for the coordinator to validate and commit. Agents do not manage another agent's branch or the base branch.

## Exclusions

The coordinator adds `/workspaces/` to the repository's local `.git/info/exclude`, which is shared by linked worktrees. This keeps generated checkouts out of ordinary Git status and staging, and Git-aware searches. It refuses to use a `workspaces/` directory that already contains tracked project files or linked path components.

Git exclusions do not configure every build tool. For each target project:

- Add `workspaces/` to `.gitignore` and `.prettierignore` if the exclusion should travel with the project.
- Exclude `workspaces/**` from ESLint, test discovery, coverage, and file watchers.
- Scope TypeScript compilation to project source/test directories or add `workspaces` to `exclude`.
- Run checks from the agent or integration checkout, with its own dependency installation and build outputs as needed.

LLM-Swarm's own lint, formatting, tests, and TypeScript configuration already respect this layout. The coordinator does not rewrite arbitrary target-project build configuration.

## File ownership and dependencies

Independent tasks cannot claim overlapping files or directories. A task with an explicit dependency can edit the same files after its predecessor finishes. Its worktree starts with the predecessors' recorded commits, and its prompt includes relevant committed source. A concurrent update to the user's base branch cannot change the running job's snapshot.

Patch destinations must be consistent across headers, relative to the assigned worktree, and free of traversal, reserved Git/workspace paths, symlinks, or junctions. Only regular text-file patch modes are supported. Cross-task edits are discarded or rejected before the coordinator commits. Cleanup verifies both repository and branch identity before removal; merge conflicts are preserved for diagnosis rather than resolved by choosing one side automatically.

These checks control the coordinator's file operations. CLI providers and configured check commands still run with the host user's permissions. Use trusted executables and configuration, or run the entire swarm in an OS/container sandbox when handling untrusted executable code. A nested folder is not a filesystem permission boundary.

## Retention and review

Worktrees remain on disk by default. Set `git.cleanupWorktrees: true` to remove successful task worktrees after review. Failed work is preserved by default. The integration checkout remains available for inspection and manual Git workflow.

Checks are required by default. `requireChecks: false` explicitly permits a run without automated checks, and the final report still records `not_run`. Review refuses incomplete diffs or prompts; increase the relevant limit or split the task instead of accepting unseen changes.

Use `git worktree list` to inspect all registered worktrees. Remove an unused checkout with `git worktree remove <path>` before deleting its branch. Do not recursively delete the `workspaces` directory while jobs are active.
