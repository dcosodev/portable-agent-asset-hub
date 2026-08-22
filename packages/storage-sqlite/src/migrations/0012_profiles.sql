CREATE TABLE IF NOT EXISTS profiles (
  id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  scope_agent_id TEXT NOT NULL,
  current_version INTEGER NOT NULL CHECK(current_version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(id, owner_user_id, scope_agent_id)
);
CREATE TABLE IF NOT EXISTS profile_versions (
  id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  scope_agent_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  blocks_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(id, owner_user_id, scope_agent_id, version),
  FOREIGN KEY(id, owner_user_id, scope_agent_id)
    REFERENCES profiles(id, owner_user_id, scope_agent_id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS profile_import_previews (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  scope_agent_id TEXT NOT NULL,
  expected_version INTEGER NOT NULL CHECK(expected_version >= 1),
  digest TEXT NOT NULL CHECK(length(digest) = 64),
  target_digest TEXT NOT NULL CHECK(length(target_digest) = 64),
  expires_at INTEGER NOT NULL CHECK(expires_at >= 0),
  used INTEGER NOT NULL DEFAULT 0 CHECK(used IN (0, 1)),
  blocks_json TEXT NOT NULL,
  FOREIGN KEY(profile_id, owner_user_id, scope_agent_id, expected_version)
    REFERENCES profile_versions(id, owner_user_id, scope_agent_id, version) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS profile_materializations (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  scope_agent_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  target TEXT NOT NULL,
  digest TEXT NOT NULL CHECK(length(digest) = 64),
  bytes BLOB NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(profile_id, owner_user_id, scope_agent_id, version)
    REFERENCES profile_versions(id, owner_user_id, scope_agent_id, version) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS profiles_scope ON profiles(owner_user_id, scope_agent_id);
CREATE INDEX IF NOT EXISTS profile_materializations_scope
  ON profile_materializations(profile_id, owner_user_id, scope_agent_id);
