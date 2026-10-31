# Music application and supervision verification

The original music-app job failed before integration. Its planner assigned absolute-looking paths such as `/src/index.css`, while Git reports repository-relative paths. The validator accepted those areas; every implementation task failed ownership checks. Its configuration also disabled required checks. The partially written app depended on a nonexistent Gun version and had an invalid unquoted Tailwind configuration property.

The original scaffold and database were backed up under ignored `artifacts/music-testing/`. The music app was developed on `codex/music-swarm-validation`; the original `master` seed was retained. The corrected configuration is local to this machine at `config/music.local.yaml`.

## Application evidence

- TypeScript and Vite build the app.
- Browser tests cover desktop and mobile search, album/artist modes, real audio playback and seeking with a local WAV fixture, likes, playlists, persistence, empty/error states, and memory-only Nostr identities.
- Two independent browser contexts exchange libraries through actual WebRTC connections using a local PeerJS server and through an independent local Gun relay.
- A local WebSocket relay receives a cryptographically verified Nostr library event; a following subscription receives the same library. No events are published to public Nostr relays during tests.
- Live swarm job `f560766f-8937-4e22-9c50-42b98b3814a1` produced both utility commits at attempt 1 and dependent wiring after recovery. Integrated checks rejected two merging defects. Later model revisions introduced an unrelated Redux rewrite, which TypeScript rejected. After bounded recovery and operator guidance, the run was explicitly stopped rather than described as an autonomous success. The successful utility commits were retained on the application validation branch, and the operator corrected immutable merging and wiring in commit `fe7bda9`.
- That corrected application passed all 20 unit tests and all 8 desktop/mobile browser tests, plus TypeScript and the production build. A later first-local-duplicate regression adds a focused 21st acceptance case for a separate live trial.
- Actual Apple search returned 36 results through the development proxy and 35 through production JSONP, with no browser page errors. This check used live network responses rather than the deterministic test fixtures.

## Framework evidence

Regression coverage includes invalid ownership paths, live tool messages, bounded planner assistance, human escalation, automatic question answering, goal-supervisor task additions, planner proposals, single application of a proposal, loopback API protections, and native Ollama tool transport.

A separate-process test kills a scheduler while a dependent worker is waiting, invokes the maintenance CLI, and verifies that the job completes with the predecessor's original commit and attempt count unchanged. Another real-Git test verifies that an interrupted attempt's scoped checkpoint is inherited without approving that failed run.

The one-minute Windows task was installed as `LLM-Swarm-Recovery`. The live dashboard was deliberately stopped; the scheduled task restored it and recorded `job.interrupted` followed by `maintenance.auto_resumed` for music job `f560766f-8937-4e22-9c50-42b98b3814a1`. Its two successful utility tasks were retained at attempt 1; only unfinished wiring restarted.

The same live run raised decision `f3cc99e5-0b74-4fcd-a2ea-944c173b19bc`. Recurring supervision delegated it to the planner, selected an offered repair option with recorded rationale, and restarted the worker without a human answer. That demonstrates the control path; it does not establish that the model's subsequent repair was correct.

Live testing exposed an optional-patch placeholder bug and a timeout-budget bug. Direct tool edits are now validated even when the model supplies a non-diff placeholder, while a no-change run still fails. Request deadlines and full tool-turn deadlines are separate; productive multi-step agents are no longer restricted to the duration of one request.

## Final checked result

Focused live job `33df2101-0485-4bbe-bfcf-b150066192f6` completed in 43.1 seconds with one worker attempt, no retries, no human messages during execution, passing required checks, a goal-supervisor review, and independent reviewer approval. The explicit plan targeted one additional first-local-duplicate regression; it was not a claim that the entire application was built autonomously. The installed Codex CLI returned an owned unified diff from supplied source, using `fileEditing: false`. Its command policy remained read-only. The coordinator applied the patch and ran the checks. CLI token usage was unavailable and is recorded as unknown.

The successful diff changed only `src/lib/libraryMerge.ts`. It was fast-forwarded into `codex/music-swarm-validation` at `2951980`. The final app passed **21 unit tests, 8 browser tests, TypeScript, and a production build**. An additional live browser check played a real Apple preview, loading a 30.019-second clip and advancing playback time. Both repositories reported zero npm audit findings.

Browser tests now always start an isolated Vite server on port 5175 with explicit local PeerJS settings; they cannot accidentally reuse the interactive development server on port 5173. The final local-transport suite passed again with that isolation.

The framework suite passed **107 tests across 17 files**, plus type checking, build, lint, and formatting. Targeted follow-up coverage verifies that planning-room requests include persisted check and review evidence. The planner chat was also exercised through the live HTTP endpoint. The dashboard was inspected on desktop and mobile without horizontal overflow or browser page errors.

Subsequent focused Qwen and Mistral trials produced incorrect or ineffective changes and were stopped, with their evidence retained. An initial Codex CLI editing trial correctly reported its command-policy blocker. A read-only patch capability setting solved that integration limitation without changing its permissions. None of these stopped runs are counted as successful trials or a complete model comparison.

The local scheduled configuration now defaults to the checked Codex patch profile; the original Ollama and exploratory Mistral profiles remain selectable. This uses the existing Codex login. The broader application required operator implementation and corrections, and the initial local-model benchmark below remains a caution against assuming that more agents automatically produce better code.

## Initial controlled benchmark

Ten synthetic music-domain helper cases each ran in direct, one-worker pipeline, and two-worker pipeline modes. Both pipeline modes used the same explicit two-task graph, model, and acceptance checker. The direct mode had no planner/reviewer; pipeline modes included independent review. No human fixed an individual trial.

| Mode                | Checked successes | Trials | Total elapsed | Reported tokens |
| ------------------- | ----------------: | -----: | ------------: | --------------: |
| Direct              |                 4 |     10 | 139.3 seconds |          10,159 |
| Pipeline, 1 worker  |                 1 |     10 | 542.6 seconds |          59,699 |
| Pipeline, 2 workers |                 2 |     10 | 443.1 seconds |          57,522 |

These are results from the original patch-response path, not evidence that the finished framework improves a model's coding ability. They expose patch-format and coordination overhead. Additional native-tool trials found and helped reproduce the placeholder-patch defect; those exploratory trials were interrupted to isolate model capacity for application validation and are not a complete comparative benchmark. The reproducible driver remains `scripts/benchmark.ts`; set `SWARM_BENCHMARK_TOOLS=1` for the native Ollama path. Raw local evidence is retained under ignored `artifacts/`.

The current driver assigns one protected, scoped acceptance command to each module task before handoff and runs both commands on final results. The generated checker accepts `left` or `right`, defaulting to both. Direct trials use the same protected checker and verify that its accepted commit and Git working tree remain unchanged by checks. This updates the experiment protocol for coordinator task verification; the historical numbers above have not been rerun under that protocol.

Local transport tests establish functionality, not public relay uptime, NAT traversal across arbitrary networks, or benchmark generality. The live agents remain trusted host processes, not an operating-system sandbox.
