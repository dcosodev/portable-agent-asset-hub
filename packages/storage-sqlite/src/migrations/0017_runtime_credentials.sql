CREATE TABLE runtime_credentials (
  id TEXT PRIMARY KEY CHECK(id GLOB 'cred_*'),
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
  fingerprint TEXT NOT NULL UNIQUE CHECK(length(fingerprint)=16),
  user_id TEXT NOT NULL REFERENCES users(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  runtime TEXT NOT NULL,
  profile TEXT NOT NULL,
  harness_id TEXT REFERENCES harnesses(id),
  role TEXT NOT NULL CHECK(role IN ('user','agent','admin')),
  capabilities_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX runtime_credentials_actor ON runtime_credentials(user_id, agent_id);
CREATE TABLE auth_events (
  id TEXT PRIMARY KEY,
  credential_id TEXT,
  actor_user_id TEXT,
  actor_agent_id TEXT,
  runtime TEXT,
  profile TEXT,
  request_id TEXT NOT NULL,
  result TEXT NOT NULL CHECK(result IN ('authenticated','rejected','revoked','capability_denied','scope_denied')),
  created_at TEXT NOT NULL,
  FOREIGN KEY(credential_id) REFERENCES runtime_credentials(id)
);
CREATE INDEX auth_events_created ON auth_events(created_at DESC);