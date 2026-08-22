CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  capability TEXT,
  actor_user_id TEXT NOT NULL,
  actor_agent_id TEXT NOT NULL,
  actor_harness_id TEXT,
  owner_user_id TEXT NOT NULL,
  scope_agent_id TEXT NOT NULL,
  target TEXT,
  request_digest TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_scope ON audit(owner_user_id, scope_agent_id);
