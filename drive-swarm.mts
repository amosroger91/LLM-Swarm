import {
  loadConfig,
  databasePath,
  openDatabase,
  Store,
  GitWorkspace,
  Orchestrator,
  configProviderResolver,
} from "./dist/index.js";
import { createLogger } from "./dist/logging/logger.js";

const config = loadConfig("C:/Users/roger/dev/swarm-music-config.yaml");
const db = openDatabase(databasePath(config));
const store = new Store(db);
const logger = createLogger(config.logLevel, (t) => t);
const workspace = new GitWorkspace({
  authorName: config.gitAuthorName,
  authorEmail: config.gitAuthorEmail,
  timeoutMs: config.providerTimeoutMs,
  policy: config.git,
  maxContextChars: config.maxPromptChars,
});
const orchestrator = new Orchestrator(store, config, workspace, configProviderResolver(), {
  logger,
  recoverOnStart: true,
});

const task = `Build a complete, polished single-page iTunes music search and playback web app in this repository.

Requirements:
- Use Vite + React + TypeScript + Tailwind CSS for a modern, beautiful UI (dark mode, glassmorphism, smooth animations, responsive).
- Search the iTunes Search API (https://itunes.apple.com/search) for songs, albums, artists; show results with cover art, preview play buttons, artist/album/genre.
- A playable audio player with play/pause, seek bar, volume, current/time duration, and a queue.
- Integrate GunJS for peer-to-peer sync of liked tracks, playlists, and listening state across peers.
- Integrate PeerJS for WebRTC peer connections so users can discover and connect to peers.
- Nostr accounts: users can create/import a Nostr keypair (nostr-tools), sign in, publish their liked tracks/playlists as Nostr events, and follow other Nostr users to see their music.
- Persist preferences with localStorage.
- "Looks really nice": polished CSS, gradients, backdrop blur, nice typography, hover states, loading spinners, empty states, mobile-friendly.
- Include package.json with gun, peerjs, nostr-tools, react, react-dom, lucide-react, clsx, tailwind-merge and dev deps for vite, tailwind, postcss, autoprefixer, typescript.
- Include index.html, tailwind.config.js, postcss.config.js, tsconfig.json, vite.config.ts.
- Source files under src/: App.tsx, main.tsx, index.css, components/, pages/, hooks/, lib/ (gun, peerjs, nostr helpers).
- Everything must compile: run tsc --noEmit and vite build successfully as the acceptance check.

Workers: split the work into disjoint file areas (UI/theme, iTunes search + player, gun/peerjs networking, nostr auth, app wiring). Each worker edits only its assigned file areas. The reviewer approves when the app compiles and all features are wired.

Return a working, good-looking music app.`;

const start = await orchestrator.startJob({
  task,
  repoPath: "C:/Users/roger/dev/itunes-music-app",
  baseBranch: "master",
  workerCount: 3,
});
console.log("STARTED", JSON.stringify(start, null, 2));

process.stdout.write("Waiting for job to finish...\n");
await orchestrator.waitFor(start.job_id);
console.log("DONE");

const result = orchestrator.result(start.job_id);
console.log("RESULT", JSON.stringify(result, null, 2));
const status = orchestrator.status(start.job_id);
console.log("STATUS", JSON.stringify(status, null, 2));

store.close();
process.exit(result.ready ? 0 : 1);
