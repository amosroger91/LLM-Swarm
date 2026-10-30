import fs from "node:fs";
import {
  loadConfig,
  databasePath,
  openDatabase,
  Store,
  GitWorkspace,
  Orchestrator,
  configProviderResolver,
} from "../../src/index.js";
const [configPath, repoPath, marker] = process.argv.slice(2) as [string, string, string];
const config = loadConfig(configPath);
const store = new Store(openDatabase(databasePath(config)));
const workspace = new GitWorkspace({
  authorName: config.gitAuthorName,
  authorEmail: config.gitAuthorEmail,
  timeoutMs: 20000,
  policy: config.git,
  maxContextChars: 20000,
});
const orchestrator = new Orchestrator(store, config, workspace, configProviderResolver());
const job = await orchestrator.startJob({ task: "Create a.txt then b.txt", repoPath });
fs.writeFileSync(marker, job.job_id);
await orchestrator.waitFor(job.job_id);
store.close();
