export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  // Additive migrations preserve existing runs and worktree evidence.
  {
    version: 1,
    name: "initial",
    sql: `
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  integration_branch TEXT,
  worker_count INTEGER NOT NULL,
  config_profile TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'planning', 'running', 'review', 'completed', 'failed', 'cancel_requested', 'cancelled', 'interrupted'
  )),
  dry_run INTEGER NOT NULL DEFAULT 0 CHECK (dry_run IN (0, 1)),
  goal TEXT,
  completion_criteria_json TEXT,
  plan_json TEXT,
  planner_output TEXT,
  assumptions_json TEXT,
  risks_json TEXT,
  questions_json TEXT,
  review_state TEXT,
  review_round INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  max_review_rounds INTEGER NOT NULL,
  error TEXT,
  final_report TEXT,
  snapshot_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  cancel_requested_at TEXT,
  completed_at TEXT
);

CREATE TABLE agent_profiles (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('planner', 'worker', 'reviewer')),
  provider_type TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  model TEXT,
  config_json TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  system_prompt TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  stable_id TEXT NOT NULL,
  title TEXT NOT NULL,
  instructions TEXT NOT NULL,
  acceptance_criteria_json TEXT NOT NULL,
  suggested_role TEXT,
  file_areas_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'blocked', 'ready', 'running', 'review', 'revision', 'done', 'failed', 'cancelled'
  )),
  kind TEXT NOT NULL CHECK (kind IN ('implementation', 'revision')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  result_summary TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (job_id, stable_id)
);

CREATE TABLE task_dependencies (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_task_id)
);

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  agent_profile_id TEXT REFERENCES agent_profiles(id),
  role TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled', 'interrupted'
  )),
  provider_name TEXT,
  model TEXT,
  worktree_path TEXT,
  branch_name TEXT,
  base_commit TEXT,
  head_commit TEXT,
  output_summary TEXT,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  context TEXT,
  options_json TEXT NOT NULL,
  proposer TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  deadline TEXT,
  resolution_policy TEXT NOT NULL CHECK (resolution_policy IN ('owner', 'majority', 'unanimous')),
  quorum INTEGER NOT NULL,
  owner_role TEXT NOT NULL,
  final_option TEXT,
  final_rationale TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT
);

CREATE TABLE votes (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  voter TEXT NOT NULL,
  option_value TEXT NOT NULL,
  rationale TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (decision_id, voter)
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  sender TEXT NOT NULL,
  role TEXT NOT NULL,
  channel TEXT NOT NULL,
  message_type TEXT NOT NULL CHECK (message_type IN (
    'status', 'question', 'finding', 'proposal', 'handoff', 'result', 'chat'
  )),
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  decision_id TEXT REFERENCES decisions(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  round INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('approved', 'rejected')),
  summary TEXT NOT NULL,
  findings_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  type TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  payload_json TEXT NOT NULL
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  path TEXT,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE worktrees (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  path TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  base_commit TEXT,
  head_commit TEXT,
  cleanup_state TEXT NOT NULL CHECK (cleanup_state IN ('active', 'preserved', 'removed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_tasks_job_status ON tasks(job_id, status);
CREATE INDEX idx_tasks_job_stable ON tasks(job_id, stable_id);
CREATE INDEX idx_runs_job_status ON agent_runs(job_id, status);
CREATE INDEX idx_messages_job_time ON messages(job_id, created_at);
CREATE INDEX idx_events_job_time ON events(job_id, created_at);
CREATE INDEX idx_decisions_job_status ON decisions(job_id, status);
CREATE INDEX idx_votes_decision ON votes(decision_id);
CREATE INDEX idx_worktrees_job ON worktrees(job_id);
CREATE INDEX idx_artifacts_job ON artifacts(job_id);
`,
  },
  {
    version: 2,
    name: "scheduler_ownership_and_pinned_base",
    sql: `
ALTER TABLE jobs ADD COLUMN base_commit TEXT;
CREATE TABLE scheduler_owner (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  token TEXT NOT NULL,
  pid INTEGER NOT NULL,
  hostname TEXT NOT NULL
);
`,
  },
  {
    version: 3,
    name: "coordination_and_measurements",
    sql: `
ALTER TABLE decisions ADD COLUMN blocking INTEGER NOT NULL DEFAULT 0;
CREATE TABLE provider_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  task_id TEXT,
  role TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  duration_ms INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_calls_job ON provider_calls(job_id);
`,
  },
  {
    version: 4,
    name: "blockers_and_recovery",
    sql: `CREATE TABLE blockers (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      task_id TEXT, run_id TEXT, category TEXT NOT NULL, fingerprint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open', summary TEXT NOT NULL, details TEXT NOT NULL,
      next_action TEXT NOT NULL, attempts_json TEXT NOT NULL DEFAULT '[]',
      occurrences INTEGER NOT NULL DEFAULT 1, assists INTEGER NOT NULL DEFAULT 0,
      decision_id TEXT REFERENCES decisions(id), resolution TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(job_id, fingerprint)
    );
    CREATE INDEX idx_blockers_job ON blockers(job_id, status);`,
  },
  {
    version: 5,
    name: "planner_task_proposals",
    sql: `
    CREATE TABLE task_proposals (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id),
      message TEXT NOT NULL, reply TEXT NOT NULL, tasks_json TEXT NOT NULL, contracts_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL);
  `,
  },
  {
    version: 6,
    name: "immutable_human_goal",
    sql: `ALTER TABLE jobs ADD COLUMN human_goal TEXT; UPDATE jobs SET human_goal = task;`,
  },
  {
    version: 7,
    name: "clear_resolved_task_errors",
    sql: `UPDATE tasks SET error=NULL WHERE status IN ('review','revision','done') AND EXISTS (SELECT 1 FROM agent_runs WHERE agent_runs.task_id=tasks.id AND agent_runs.status='succeeded');`,
  },
  {
    version: 8,
    name: "provider_fallback_snapshots",
    sql: `ALTER TABLE agent_profiles ADD COLUMN fallbacks_json TEXT NOT NULL DEFAULT '[]';`,
  },
  {
    version: 9,
    name: "durable_planner_chat",
    sql: `CREATE TABLE planner_chats (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      message TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','completed','failed')),
      error TEXT, started_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE UNIQUE INDEX idx_pending_planner_chat ON planner_chats(job_id) WHERE status='pending';
    CREATE INDEX idx_planner_chat_job ON planner_chats(job_id, started_at);`,
  },
  {
    version: 10,
    name: "delegations",
    sql: `
CREATE TABLE delegations (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  prompt_chars INTEGER NOT NULL,
  context_chars INTEGER NOT NULL,
  output_chars INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  duration_ms INTEGER NOT NULL,
  failover_json TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_delegations_time ON delegations(created_at);
`,
  },
];
