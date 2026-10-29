import { openDatabase } from "../../src/db/connection.js";
import { Store } from "../../src/db/store.js";

const dbPath = process.argv[2];
const jobId = process.argv[3];
const profileId = process.argv[4];
if (!dbPath || !jobId || !profileId) {
  process.stderr.write("usage: claim-once <db> <jobId> <profileId>\n");
  process.exit(2);
}

const store = new Store(openDatabase(dbPath));
try {
  const claims = store.claimReady(jobId, 1, profileId);
  const first = claims[0];
  process.stdout.write(
    JSON.stringify({
      claimed: claims.length,
      taskId: first?.task.id ?? null,
      runId: first?.run.id ?? null,
    }),
  );
} finally {
  store.close();
}
