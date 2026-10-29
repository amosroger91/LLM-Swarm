import { afterEach, describe, expect, it } from "vitest";
import { SwarmError } from "../src/errors.js";
import { openStore, removeTemp, tempDir } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) removeTemp(dir);
  }
});

function jobWithDecision(
  policy: "owner" | "majority" | "unanimous",
  quorum = 1,
): {
  dir: string;
  close: () => void;
  jobId: string;
  decisionId: string;
  store: ReturnType<typeof openStore>["store"];
} {
  const dir = tempDir("swarm-vote-");
  dirs.push(dir);
  const { store } = openStore(dir);
  const job = store.createJob({
    task: "decide",
    repoPath: dir,
    baseBranch: "main",
    workerCount: 1,
    configProfile: null,
    dryRun: false,
    maxAttempts: 2,
    maxReviewRounds: 3,
  });
  const decision = store.createDecision({
    jobId: job.id,
    question: "Ship it?",
    options: ["yes", "no"],
    proposer: "worker",
    policy,
    quorum,
    ownerRole: "reviewer",
  });
  return { dir, close: () => store.close(), jobId: job.id, decisionId: decision.id, store };
}

describe("decisions and chat", () => {
  it("keeps an owner decision open until the owner resolves it", () => {
    const { store, decisionId, jobId, close } = jobWithDecision("owner");
    store.upsertVote({ decisionId, voter: "ada", option: "yes", rationale: "looks good" });
    store.upsertVote({ decisionId, voter: "bea", option: "yes" });
    expect(store.mustDecision(decisionId).status).toBe("open");
    expect(() =>
      store.resolveDecision({
        decisionId,
        option: "yes",
        rationale: "workers agreed",
        actor: "ada",
        actorRole: "worker",
      }),
    ).toThrow(SwarmError);
    const resolved = store.resolveDecision({
      decisionId,
      option: "yes",
      rationale: "reviewer accepts",
      actor: "reviewer-1",
      actorRole: "reviewer",
    });
    expect(resolved.status).toBe("resolved");
    expect(resolved.finalOption).toBe("yes");
    expect(resolved.votes).toHaveLength(2);
    const message = store.postMessage({
      jobId,
      sender: "ada",
      role: "worker",
      messageType: "proposal",
      decisionId,
      content: "Ship it?",
      maxChars: 16_000,
    });
    expect(message.messageType).toBe("proposal");
    expect(store.listMessages(jobId).some((item) => item.id === message.id)).toBe(true);
    close();
  });

  it("replaces a voter's previous option and keeps an audit event", () => {
    const { store, decisionId, jobId, close } = jobWithDecision("owner");
    store.upsertVote({ decisionId, voter: "ada", option: "no" });
    store.upsertVote({ decisionId, voter: "ada", option: "yes", rationale: "changed my mind" });
    const votes = store.listVotes(decisionId);
    expect(votes).toHaveLength(1);
    expect(votes[0]?.option).toBe("yes");
    const events = store.listEvents(jobId, 20).filter((event) => event.type === "decision.voted");
    expect(events).toHaveLength(2);
    const latest = events[1]?.payload as { replaced?: boolean; previous?: string; option?: string };
    expect(latest.replaced).toBe(true);
    expect(latest.previous).toBe("no");
    expect(latest.option).toBe("yes");
    close();
  });

  it("auto-resolves majority and unanimous votes only when the rule is met", () => {
    const majority = jobWithDecision("majority", 2);
    majority.store.upsertVote({ decisionId: majority.decisionId, voter: "ada", option: "yes" });
    expect(majority.store.mustDecision(majority.decisionId).status).toBe("open");
    majority.store.upsertVote({ decisionId: majority.decisionId, voter: "bea", option: "yes" });
    expect(majority.store.mustDecision(majority.decisionId).status).toBe("resolved");
    expect(majority.store.mustDecision(majority.decisionId).resolvedBy).toBe("policy:majority");
    majority.close();

    const split = jobWithDecision("unanimous", 2);
    split.store.upsertVote({ decisionId: split.decisionId, voter: "ada", option: "yes" });
    split.store.upsertVote({ decisionId: split.decisionId, voter: "bea", option: "no" });
    expect(split.store.mustDecision(split.decisionId).status).toBe("open");
    split.close();

    const agreed = jobWithDecision("unanimous", 2);
    agreed.store.upsertVote({ decisionId: agreed.decisionId, voter: "ada", option: "no" });
    agreed.store.upsertVote({ decisionId: agreed.decisionId, voter: "bea", option: "no" });
    expect(agreed.store.mustDecision(agreed.decisionId).finalOption).toBe("no");
    agreed.close();
  });

  it("rejects an option that was not proposed and a vote on a closed decision", () => {
    const { store, decisionId, close } = jobWithDecision("owner");
    expect(() => store.upsertVote({ decisionId, voter: "ada", option: "maybe" })).toThrow(
      SwarmError,
    );
    store.resolveDecision({
      decisionId,
      option: "no",
      rationale: "stop",
      actor: "reviewer",
      actorRole: "reviewer",
    });
    expect(() => store.upsertVote({ decisionId, voter: "ada", option: "yes" })).toThrow(
      /already resolved/,
    );
    close();
  });

  it("records a chat message and truncates it to the configured size", () => {
    const dir = tempDir("swarm-chat-");
    dirs.push(dir);
    const { store } = openStore(dir);
    const job = store.createJob({
      task: "chat",
      repoPath: dir,
      baseBranch: "main",
      workerCount: 1,
      configProfile: null,
      dryRun: false,
      maxAttempts: 1,
      maxReviewRounds: 1,
    });
    const message = store.postMessage({
      jobId: job.id,
      sender: "mcp-client",
      role: "caller",
      channel: "general",
      messageType: "chat",
      content: "x".repeat(50),
      maxChars: 16,
    });
    expect(message.messageType).toBe("chat");
    expect(message.content.endsWith("[truncated]")).toBe(true);
    expect(message.content.length).toBeLessThan(50);
    store.close();
  });
});
