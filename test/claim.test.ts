import { spawn } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/db/store.js";
import { openDatabase } from "../src/db/connection.js";
import {
  openStore,
  plannedTasks,
  projectRoot,
  removeTemp,
  seedProfiles,
  tempDir,
} from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) removeTemp(dir);
  }
});

function claimOnce(
  dbPath: string,
  jobId: string,
  profileId: string,
): Promise<{ claimed: number; taskId: string | null }> {
  const fixture = path.join(projectRoot, "test", "fixtures", "claim-once.ts");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", fixture, dbPath, jobId, profileId], {
      cwd: projectRoot,
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`claim-once exited ${code}: ${stderr || stdout}`));
        return;
      }
      resolve(JSON.parse(stdout) as { claimed: number; taskId: string | null });
    });
  });
}

describe("cross-process claim", () => {
  it("lets exactly one of two processes claim the only ready task", async () => {
    const dir = tempDir("swarm-race-");
    dirs.push(dir);
    const { store, dbPath } = openStore(dir);
    const job = store.createJob({
      task: "race",
      repoPath: dir,
      baseBranch: "main",
      workerCount: 2,
      configProfile: null,
      dryRun: false,
      maxAttempts: 2,
      maxReviewRounds: 3,
    });
    seedProfiles(store, job.id);
    store.replacePlan(
      job.id,
      {
        goal: "race",
        completionCriteria: ["a"],
        assumptions: [],
        risks: [],
        questions: [],
        raw: "{}",
      },
      plannedTasks([{ id: "only" }]),
      2,
    );
    const profileId = store.profileForRole(job.id, "worker").id;
    const [left, right] = await Promise.all([
      claimOnce(dbPath, job.id, profileId),
      claimOnce(dbPath, job.id, profileId),
    ]);
    const claimed = [left, right].map((item) => item.claimed);
    expect(claimed.reduce((sum, value) => sum + value, 0)).toBe(1);
    expect(claimed.sort()).toEqual([0, 1]);
    const again = new Store(openDatabase(dbPath));
    const task = again.listTasks(job.id)[0];
    expect(task?.status).toBe("running");
    expect(task?.attemptCount).toBe(1);
    expect(again.listRuns(job.id)).toHaveLength(1);
    again.close();
    store.close();
  });
});
