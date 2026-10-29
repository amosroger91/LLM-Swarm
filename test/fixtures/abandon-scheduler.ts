import { MemoryWorkspace } from "../../src/git/workspace.js";
import { Orchestrator } from "../../src/orchestration/service.js";
import { openStore, seedRunning, testConfig } from "../helpers.js";
const root = process.argv[2]!;
const store = openStore(root).store;
new Orchestrator(
  store,
  testConfig(root),
  new MemoryWorkspace(),
  {
    forProfile() {
      throw new Error("unused");
    },
  },
  { recoverOnStart: false },
);
const id = seedRunning(store, { repo: root, workerCount: 1, tasks: [{ id: "a" }] });
store.claimReady(id, 1, store.profileForRole(id, "worker").id);
process.stdout.write(id);
// Simulate a crash: do not run Store.close()/shutdown and leave ownership in SQLite.
process.exit(0);
