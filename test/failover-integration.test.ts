import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { SwarmError } from "../src/errors.js";
import { MemoryWorkspace } from "../src/git/workspace.js";
import {
  Orchestrator,
  configProviderResolver,
  statusPayload,
} from "../src/orchestration/service.js";
import { registerProviderBuilder } from "../src/providers/registry.js";
import {
  doneResult,
  jsonResponse,
  openStore,
  planValue,
  removeTemp,
  tempDir,
  testConfig,
} from "./helpers.js";

it.each(["configured", "local_or_free"] as const)(
  "completes under %s policy and records actual routes and calls",
  async (costPolicy) => {
    const root = tempDir("swarm-failover-integration-");
    const { store } = openStore(root);
    const config = testConfig(root);
    config.costPolicy = costPolicy;
    let deniedCalls = 0;
    const capabilities = {
      toolCalling: true,
      structuredOutput: true,
      streaming: false,
      nonInteractive: true,
    };
    registerProviderBuilder("failover-fixture", (provider, context) => ({
      name: context.name,
      capabilities,
      async complete(request) {
        if (provider.type === "custom" && provider.options.fail) {
          deniedCalls++;
          throw new SwarmError("endpoint offline", "http", true);
        }
        let result: unknown;
        switch (request.metadata?.role) {
          case "planner":
            result = planValue([{ id: "a" }]);
            break;
          case "worker":
            fs.writeFileSync(path.join(request.cwd!, "a.txt"), "implemented by backup");
            result = doneResult();
            break;
          default:
            result = { approved: true, summary: "fixture reviewed", findings: [] };
        }
        return { ...jsonResponse(result), provider: context.name, model: "fixture-model" };
      },
    }));
    config.providers.primary = {
      type: "custom",
      driver: "failover-fixture",
      options: { fail: true },
      costClass: "metered",
      timeoutMs: 1000,
      capabilities,
    };
    config.providers.backup = {
      type: "custom",
      driver: "failover-fixture",
      options: {},
      costClass: "free",
      timeoutMs: 1000,
      capabilities,
    };
    for (const agent of Object.values(config.agents)) {
      agent.provider = "primary";
      agent.fallbackProviders = ["backup"];
    }
    const orchestrator = new Orchestrator(
      store,
      config,
      new MemoryWorkspace(),
      configProviderResolver(undefined, costPolicy),
      { recoverOnStart: false },
    );
    try {
      const started = await orchestrator.startJob({ task: "write a.txt", repoPath: root });
      await orchestrator.waitFor(started.job_id);
      expect(store.mustJob(started.job_id).status).toBe("completed");
      expect(deniedCalls).toBe(costPolicy === "local_or_free" ? 0 : 1);
      expect(
        store.listEvents(started.job_id, 100).some((event) => event.type === "provider.failover"),
      ).toBe(true);
      expect(store.measurements(started.job_id).calls).toEqual(
        expect.arrayContaining([expect.objectContaining({ provider: "backup" })]),
      );
      expect(statusPayload(store, started.job_id).provider_routes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "worker",
            fallbacks: [{ provider: "backup", model: null }],
          }),
        ]),
      );
      expect(store.profileForRole(started.job_id, "worker").fallbacks).toHaveLength(1);
    } finally {
      await orchestrator.shutdown();
      store.close();
      removeTemp(root);
    }
  },
);
