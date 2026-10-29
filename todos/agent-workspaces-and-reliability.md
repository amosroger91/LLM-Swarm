# Agent workspaces and reliability

**Branch:** `codex/agent-workspaces-and-reliability`
**Goal:** Give each agent a complete nested worktree, preserve dependencies, and fix the review's correctness and safety defects.

- [x] 1. Contain patch writes and deliver CLI system prompts; add regression tests (28 targeted tests passed).
- [ ] 2. Make status/result read-only, enforce scheduler ownership, and propagate cancellation.
- [ ] 3. Create nested ignored workspaces, pin the base commit, inherit dependency commits, and supply relevant source context.
- [ ] 4. Record check evidence and refuse approval with incomplete diffs; fix lint and add CI.
- [ ] 5. Run integration and adversarial tests, update documentation and the daily tracker, and push/open a PR when the live Gitea URL is available.

Remote: the user explicitly selected https://github.com/amosroger91/LLM-Swarm.git. The initial main branch is pushed; GitHub Actions will provide CI for this repository.
