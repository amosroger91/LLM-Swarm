# Agent workspaces and reliability

**Branch:** `codex/agent-workspaces-and-reliability`
**Goal:** Give each agent a complete nested worktree, preserve dependencies, and fix the review's correctness and safety defects.

- [x] 1. Contain patch writes and deliver CLI system prompts; add regression tests (28 targeted tests passed).
- [x] 2. Implement the coordinated runtime changes: nested workspaces, scheduler ownership, cross-process cancellation, pinned dependency snapshots, source context, and complete review evidence. Full suite and focused lifecycle/integration regressions pass; live Ollama smoke passed.
- [ ] 3. Ship tool exclusions, lint fixes, CI, portable smoke scripts, and documentation for the new defaults.
- [ ] 4. Finish adversarial verification, record the final CI results and daily tracker, and open a PR on the user-selected GitHub repository.

Remote: the user explicitly selected https://github.com/amosroger91/LLM-Swarm.git. The initial main branch is pushed; GitHub Actions will provide CI for this repository.
