import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  loadConfig,
  openDatabase,
  Store,
  GitWorkspace,
  Orchestrator,
  configProviderResolver,
  databasePath,
} from "../src/index.js";
import { createChecksRunner } from "../src/orchestration/checks.js";
import { workspaceTools } from "../src/orchestration/tools.js";
import { coerceWorkerResult, WorkerResultSchema } from "../src/orchestration/planner.js";
import { extractJsonValue } from "../src/providers/parse.js";
import { workerSystem } from "../src/orchestration/prompts.js";

// Two independent modules per case let 1- and 2-worker runs share the exact same graph.
const cases = [
  [
    "playback bounds",
    "Clamp a finite volume to [0,1]; non-finite values return 1",
    [
      [-2, 0],
      [0.4, 0.4],
      [8, 1],
      [null, 1],
    ],
    "Return the next queue index, wrapping; empty queues return -1. Args: index,length",
    [
      [[0, 3], 1],
      [[2, 3], 0],
      [[0, 0], -1],
    ],
  ],
  [
    "time labels",
    "Format nonnegative seconds as m:ss; negative or non-finite values return 0:00",
    [
      [0, "0:00"],
      [65, "1:05"],
      [-3, "0:00"],
      [null, "0:00"],
    ],
    "Format a track count: 1 track, otherwise N tracks",
    [
      [0, "0 tracks"],
      [1, "1 track"],
      [3, "3 tracks"],
    ],
  ],
  [
    "queue identities",
    "Deduplicate an array of objects by numeric trackId, preserving first occurrences",
    [
      [
        [{ trackId: 1 }, { trackId: 1 }, { trackId: 2 }],
        [{ trackId: 1 }, { trackId: 2 }],
      ],
      [[], []],
    ],
    "Return previous queue index, wrapping; empty returns -1. Args: index,length",
    [
      [[0, 3], 2],
      [[2, 3], 1],
      [[0, 0], -1],
    ],
  ],
  [
    "search terms",
    "Trim a search string and collapse consecutive whitespace to one space",
    [
      ["  hello   world  ", "hello world"],
      ["", ""],
    ],
    "Return true only for entity values song, album, musicArtist",
    [
      ["song", true],
      ["album", true],
      ["musicArtist", true],
      ["all", false],
    ],
  ],
  [
    "playlist edits",
    "Rename playlist by id without mutation; args: playlists,id,name",
    [
      [[[{ id: "a", name: "old" }], "a", "new"], [{ id: "a", name: "new" }]],
      [[[], "x", "new"], []],
    ],
    "Remove every occurrence of a numeric ID from an array; args: ids,id",
    [
      [[[1, 2, 1], 1], [2]],
      [[[], 3], []],
    ],
  ],
  [
    "safe preferences",
    "Parse a JSON string; return the supplied fallback on invalid JSON. Args: text,fallback",
    [
      [["{", []], []],
      [['{"volume":0.5}', {}], { volume: 0.5 }],
    ],
    "Return only unique nonempty trimmed strings from an array",
    [
      [
        [" a ", "a", "", "b"],
        ["a", "b"],
      ],
      [[], []],
    ],
  ],
  [
    "track filtering",
    "Keep only tracks with nonempty string previewUrl",
    [
      [
        [
          { trackId: 1, previewUrl: "" },
          { trackId: 2, previewUrl: "https://a" },
        ],
        [{ trackId: 2, previewUrl: "https://a" }],
      ],
    ],
    "Return artwork URL replacing 100x100 with 600x600; non-string input returns empty string",
    [
      ["https://a/100x100bb.jpg", "https://a/600x600bb.jpg"],
      [null, ""],
    ],
  ],
  [
    "library merge",
    "Union two numeric ID arrays preserving order of first occurrence; args: left,right",
    [
      [
        [
          [1, 2],
          [2, 3],
        ],
        [1, 2, 3],
      ],
      [[[], []], []],
    ],
    "Find track by numeric trackId; return null when missing. Args: tracks,id",
    [
      [[[{ trackId: 2 }], 2], { trackId: 2 }],
      [[[], 4], null],
    ],
  ],
  [
    "peer input",
    "Trim peer id and accept only 1-64 ASCII letters,digits,underscore,hyphen; invalid returns null",
    [
      [" peer-1 ", "peer-1"],
      ["../bad", null],
      ["", null],
    ],
    "Return true only for a 64-character hexadecimal string",
    [
      ["a".repeat(64), true],
      ["z".repeat(64), false],
      ["abc", false],
    ],
  ],
  [
    "display metadata",
    "Return artistName when a nonempty string, otherwise Unknown artist",
    [
      [{ artistName: "Ada" }, "Ada"],
      [{}, "Unknown artist"],
    ],
    "Return total finite positive trackTimeMillis from an array, in seconds",
    [
      [[{ trackTimeMillis: 1000 }, { trackTimeMillis: 2500 }, { trackTimeMillis: -1 }], 3.5],
      [[], 0],
    ],
  ],
] as const;

const config = loadConfig(process.argv[2]);
config.maintenance.enabled = false;
config.recovery.enabled = false;
if (process.env.SWARM_BENCHMARK_TOOLS === "1") {
  for (const provider of Object.values(config.providers))
    if (provider.type === "openai_compatible") {
      provider.protocol = "ollama";
      provider.contextTokens = 16384;
      provider.maxToolRounds = 12;
      provider.maxOutputTokens = 2048;
      provider.temperature = 0;
      provider.capabilities.toolCalling = true;
    }
}
config.writeSnapshot = false;
config.providerTimeoutMs = 180000;
config.jobTimeoutMs = 900000;
const output = path.resolve(process.argv[3] ?? "artifacts/benchmark");
fs.mkdirSync(output, { recursive: true });
config.dataDir = output;
config.database = path.join(output, "swarm.db");
const store = new Store(openDatabase(databasePath(config)));
const workspace = new GitWorkspace({
  authorName: config.gitAuthorName,
  authorEmail: config.gitAuthorEmail,
  timeoutMs: 30000,
  policy: config.git,
  maxContextChars: 30000,
});
const results: Record<string, unknown>[] = [];
const git = (root: string, args: string[]): void => {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=Swarm benchmark",
      "-c",
      "user.email=benchmark@localhost",
      "-c",
      "core.hooksPath=",
      ...args,
    ],
    { cwd: root, encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) throw new Error(result.stderr);
};
try {
  for (const [caseIndex, testCase] of cases.entries()) {
    const [name, left, leftTests, right, rightTests] = testCase;
    for (const mode of ["direct", "pipeline-1", "pipeline-2"] as const) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-benchmark-"));
      fs.mkdirSync(path.join(root, "src"));
      for (const side of ["left", "right"])
        fs.writeFileSync(
          path.join(root, `src/${side}.mjs`),
          "export default function() { throw new Error('Not implemented'); }\n",
        );
      const tests = { left: leftTests, right: rightTests };
      fs.writeFileSync(
        path.join(root, "verify.mjs"),
        `import assert from 'node:assert/strict';\nconst tests=${JSON.stringify(tests)};\nconst selected=process.argv[2];\nassert.ok(!selected || ['left','right'].includes(selected), 'Expected left or right');\nfor(const side of selected ? [selected] : ['left','right']) {const fn=(await import('./src/'+side+'.mjs')).default; for(const [input, expected] of tests[side]) {const multi = ${JSON.stringify([left, right])}[side==='left'?0:1].includes('Args:') || ${JSON.stringify([left, right])}[side==='left'?0:1].includes('args:'); assert.deepEqual(fn(...(multi?input:[input])),expected);}}\n`,
      );
      fs.writeFileSync(
        path.join(root, "README.md"),
        `${name}\nleft: ${left}\nright: ${right}\nImplement both default-exported JavaScript functions. verify.mjs contains acceptance examples.\n`,
      );
      git(root, ["init", "-b", "main"]);
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "benchmark fixture"]);
      config.checks = ["left", "right"].map((side) => ({
        name: `${side} acceptance`,
        command: process.execPath,
        args: ["verify.mjs", side],
        protectedPaths: ["verify.mjs"],
      }));
      config.requireChecks = true;
      const plan = {
        goal: name,
        completionCriteria: ["Both functions pass verify.mjs"],
        questions: [],
        contracts: ["Each module exports one default function"],
        tasks: [left, right].map((instruction, i) => ({
          id: i ? "right" : "left",
          title: instruction,
          instructions: `${instruction}. Read verify.mjs. Export a default function from src/${i ? "right" : "left"}.mjs.`,
          acceptanceCriteria: ["Pass acceptance examples"],
          verificationChecks: [i],
          fileAreas: [`src/${i ? "right" : "left"}.mjs`],
          dependencies: [],
        })),
      };
      const task = `Implement both modules: left: ${left}; right: ${right}. Read verify.mjs and preserve it. Return status done with a unified diff, or a files array of {path,content} for both modules. No other files may change.`;
      const started = Date.now();
      let jobId = "";
      let status = "failed";
      let error: string | undefined;
      const orchestrator = new Orchestrator(store, config, workspace, configProviderResolver(), {
        recoverOnStart: false,
      });
      try {
        if (mode === "direct") {
          const base = await workspace.assertRepo(root, "main");
          const job = store.createJob({
            task,
            repoPath: root,
            baseBranch: "main",
            baseCommit: base.baseCommit,
            workerCount: 1,
            configProfile: config.defaultProfile,
            dryRun: false,
            maxAttempts: 1,
            maxReviewRounds: 1,
          });
          jobId = job.id;
          store.pinVerification(jobId, { checks: config.checks, requireChecks: true });
          const profile = config.profiles[config.defaultProfile]!;
          const agent = config.agents[profile.worker]!;
          const providerConfig = config.providers[agent.provider]!;
          const provider = (await import("../src/providers/registry.js")).createProvider(
            agent.provider,
            providerConfig,
            (text) => text,
          );
          const tree = await workspace.createRunWorkspace({
            repoRoot: root,
            dataDir: output,
            jobId,
            stableId: "direct",
            attempt: 1,
            baseCommit: base.baseCommit,
          });
          const signal = AbortSignal.timeout(config.providerTimeoutMs);
          const response = await provider.complete({
            system: workerSystem(
              provider.capabilities,
              undefined,
              provider.capabilities.toolCalling,
            ),
            prompt: task + "\n" + (await workspace.readContext(root, base.baseCommit, [], 20000)),
            cwd: tree.path,
            signal,
            expectJson: true,
            tools: workspaceTools({
              root: tree.path,
              allowedPaths: ["src/left.mjs", "src/right.mjs"],
              protectedPaths: ["verify.mjs"],
              store,
              config,
              jobId,
              sender: "direct",
              signal,
            }),
            onCall: (call) => store.recordProviderCall({ ...call, jobId, role: "worker" }),
          });
          const result = WorkerResultSchema.parse(
            coerceWorkerResult(response.structured ?? extractJsonValue(response.text)),
          );
          if (result.status !== "done") throw new Error(result.summary);
          const finalized = await workspace.finalizeRun({
            repoRoot: root,
            workspace: tree,
            message: "direct result",
            patch: result.patch,
            allowedPaths: ["src/left.mjs", "src/right.mjs"],
            forbiddenPaths: ["verify.mjs"],
            signal,
          });
          const check = await createChecksRunner(config)(tree.path, signal);
          if (!check.ok) throw new Error(check.summary);
          if (!finalized.headCommit) throw new Error("Direct result has no commit to verify");
          await workspace.verifySnapshot(tree.path, finalized.headCommit, signal);
          store.transitionJob(jobId, "completed");
          status = "completed";
        } else {
          const startedJob = await orchestrator.startJob({
            task,
            repoPath: root,
            plan,
            workerCount: mode === "pipeline-1" ? 1 : 2,
          });
          jobId = startedJob.job_id;
          await orchestrator.waitFor(jobId);
          const job = store.mustJob(jobId);
          status = job.status;
          error = job.error ?? undefined;
        }
      } catch (caught) {
        error = String(caught);
        if (jobId && !["failed", "completed"].includes(store.mustJob(jobId).status))
          store.transitionJob(jobId, "failed", { error });
      } finally {
        await orchestrator.shutdown();
      }
      const row = {
        caseIndex,
        name,
        mode,
        jobId,
        status,
        error,
        elapsedMs: Date.now() - started,
        ...(jobId ? store.measurements(jobId) : {}),
        repo: root,
      };
      results.push(row);
      fs.writeFileSync(
        path.join(output, "results.json"),
        JSON.stringify(
          {
            method:
              "Controlled two-task plan with protected acceptance checks; direct has no planner/reviewer; pipeline modes use scoped task checks and share final checks and reviewer. All accepted results preserve the checked commit. Synthetic music-domain helpers, not whole-app tasks. No human fixes during a trial.",
            results,
          },
          null,
          2,
        ),
      );
      console.log(JSON.stringify({ case: name, mode, status, error, elapsedMs: row.elapsedMs }));
    }
  }
} finally {
  store.close();
}
