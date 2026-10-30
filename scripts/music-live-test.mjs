import fs from "node:fs";
const origin = process.env.SWARM_DASHBOARD_URL ?? "http://127.0.0.1:4317";
const page = await (await fetch(origin)).text();
const token = /name="swarm-token" content="([^"]+)"/.exec(page)[1];
async function api(route, input) {
  const response = await fetch(`${origin}${route}`, {
    headers: { "x-swarm-token": token, ...(input ? { "content-type": "application/json" } : {}) },
    ...(input ? { method: "POST", body: JSON.stringify(input) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}
const contracts = [
  "Use the existing Track and Playlist interfaces from src/types.ts. Keep exported names and argument types exact.",
  "src/lib/playback.ts exports formatTime(seconds:number):string, clampVolume(value:number):number, nextQueueIndex(index:number,length:number):number.",
  "src/lib/libraryMerge.ts exports mergeTracks(local:Track[],remote:Track[]):Track[], mergePlaylists(local:Playlist[],remote:Playlist[]):Playlist[]. Preserve first local metadata and local playlist names; union tracks for matching playlist IDs without mutating inputs.",
  "Only the wiring task edits src/store/player.ts and src/components/Player.tsx. Both utility tasks run independently; wiring depends on both.",
];
const task =
  "Harden the existing music app's playback helpers and peer-library merging. Replace the two utility stubs with working implementations, then wire them into the existing player store and Player component. Pass all existing and src/lib/swarm-contracts.test.ts acceptance tests, TypeScript, and Vite build. Preserve the existing UI, search, peer networking, Nostr features, and public store actions. Do not change tests, package manifests, or unrelated files. Native tools are available; edit assigned files directly and OMIT the patch field from final JSON. If a full-app check fails in an intermediate independent branch, do not edit another worker's files: its dependency task or final integration owns that work.";
const plan = {
  goal: "Reliable playback and lossless peer-library merging",
  completionCriteria: [
    "All 20 music app unit tests pass, including the peer import regression",
    "TypeScript and Vite production build succeed",
    "Player and store use the implemented helpers without changing their public APIs",
  ],
  questions: [],
  contracts,
  tasks: [
    {
      id: "playback-utils",
      title: "Implement bounded playback helpers",
      instructions:
        "Read src/lib/playback.ts and src/lib/swarm-contracts.test.ts. Implement formatTime: floor nonnegative finite seconds into m:ss (minutes may exceed 59), invalid values return 0:00. clampVolume clamps finite values to [0,1], non-finite values return 0.7. nextQueueIndex returns (index+1) modulo length, with -1 for empty length; index -1 starts at 0. Use write_file on your assigned file. Return final JSON with summary and status done; omit patch.",
      fileAreas: ["src/lib/playback.ts"],
      acceptanceCriteria: ["The playback helper tests pass"],
      dependencies: [],
    },
    {
      id: "library-merge",
      title: "Merge shared libraries without losing local tracks",
      instructions:
        "Read src/types.ts, src/lib/libraryMerge.ts and src/lib/swarm-contracts.test.ts. Implement mergeTracks as a stable, immutable union by numeric trackId, with local metadata winning duplicates. Implement mergePlaylists as a stable, immutable union by playlist id; keep local names and union the tracks of matching IDs using mergeTracks. Include new remote playlists. Use write_file on your assigned file and return done without a patch.",
      fileAreas: ["src/lib/libraryMerge.ts"],
      acceptanceCriteria: ["Pure helper merging tests pass without mutating local or remote data"],
      dependencies: [],
    },
    {
      id: "wire-utils",
      title: "Wire utilities into playback and peer imports",
      instructions:
        "Dependencies contain implemented helper files. Read them and the two assigned files. In src/components/Player.tsx import formatTime from ../lib/playback instead of defining it inline; preserve any existing named export if callers use it. In src/store/player.ts import clampVolume and nextQueueIndex for existing volume and next actions, and mergeTracks/mergePlaylists for importLibrary. Preserve every store action, UI behavior, persistence, and notices. Peer imports must keep local track metadata and merge tracks for matching playlist IDs rather than replacing an entire playlist. Run configured check 0. Only edit your assigned two files, then return status done and summary without patch.",
      fileAreas: ["src/store/player.ts", "src/components/Player.tsx"],
      acceptanceCriteria: [
        "All 20 unit tests pass including live store peer import regression",
        "TypeScript and Vite build pass",
      ],
      dependencies: ["playback-utils", "library-merge"],
    },
  ],
};
const job = await api("/api/jobs", {
  task,
  repoPath: "C:/Users/roger/dev/itunes-music-app",
  baseBranch: "codex/music-swarm-validation",
  workerCount: 2,
  plan,
});
fs.mkdirSync("artifacts/music-testing", { recursive: true });
fs.writeFileSync("artifacts/music-testing/live-job.json", JSON.stringify(job, null, 2));
console.log("Started", JSON.stringify(job));
let last = "";
for (;;) {
  const detail = await api(`/api/jobs/${job.job_id}`);
  const snapshot = JSON.stringify({
    status: detail.job.status,
    review: detail.job.reviewState,
    counts: detail.status.task_counts,
    active: detail.status.active_workers.length,
    questions: detail.status.pending_decisions,
    blockers: detail.status.blockers
      .filter((item) => item.status !== "resolved")
      .map((item) => ({ summary: item.summary, next: item.nextAction })),
  });
  if (snapshot !== last) {
    console.log(snapshot);
    last = snapshot;
  }
  if (["completed", "failed", "cancelled", "interrupted"].includes(detail.job.status)) {
    fs.writeFileSync("artifacts/music-testing/live-result.json", JSON.stringify(detail, null, 2));
    process.exitCode = detail.job.status === "completed" ? 0 : 1;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
