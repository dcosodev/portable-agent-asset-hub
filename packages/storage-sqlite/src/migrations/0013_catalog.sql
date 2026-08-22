CREATE TABLE IF NOT EXISTS catalog_entries (
 id TEXT NOT NULL, owner_user_id TEXT NOT NULL, scope_agent_id TEXT NOT NULL, logical_key TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, summary TEXT,
 lifecycle TEXT NOT NULL CHECK(lifecycle IN ('candidate','active','stale','rejected')), current_version INTEGER NOT NULL CHECK(current_version>=1), metadata_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(id,owner_user_id,scope_agent_id), UNIQUE(owner_user_id,scope_agent_id,logical_key)
);
CREATE TABLE IF NOT EXISTS catalog_entry_versions (
 entry_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, scope_agent_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>=1), snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(entry_id,owner_user_id,scope_agent_id,version), FOREIGN KEY(entry_id,owner_user_id,scope_agent_id) REFERENCES catalog_entries(id,owner_user_id,scope_agent_id)
);
CREATE TABLE IF NOT EXISTS catalog_sources (
 id TEXT NOT NULL, owner_user_id TEXT NOT NULL, scope_agent_id TEXT NOT NULL, kind TEXT NOT NULL, locator TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(id,owner_user_id,scope_agent_id), UNIQUE(owner_user_id,scope_agent_id,kind,locator)
);
CREATE TABLE IF NOT EXISTS catalog_entry_sources (
 entry_id TEXT NOT NULL, source_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, scope_agent_id TEXT NOT NULL,
 PRIMARY KEY(entry_id,source_id,owner_user_id,scope_agent_id), FOREIGN KEY(entry_id,owner_user_id,scope_agent_id) REFERENCES catalog_entries(id,owner_user_id,scope_agent_id), FOREIGN KEY(source_id,owner_user_id,scope_agent_id) REFERENCES catalog_sources(id,owner_user_id,scope_agent_id)
);
CREATE TABLE IF NOT EXISTS catalog_relations (
 owner_user_id TEXT NOT NULL, scope_agent_id TEXT NOT NULL, from_entry_id TEXT NOT NULL, relation TEXT NOT NULL, to_entry_id TEXT NOT NULL, source_id TEXT,
 PRIMARY KEY(owner_user_id,scope_agent_id,from_entry_id,relation,to_entry_id), FOREIGN KEY(from_entry_id,owner_user_id,scope_agent_id) REFERENCES catalog_entries(id,owner_user_id,scope_agent_id), FOREIGN KEY(to_entry_id,owner_user_id,scope_agent_id) REFERENCES catalog_entries(id,owner_user_id,scope_agent_id), FOREIGN KEY(source_id,owner_user_id,scope_agent_id) REFERENCES catalog_sources(id,owner_user_id,scope_agent_id)
);
CREATE TABLE IF NOT EXISTS catalog_sync_previews (
 id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, scope_agent_id TEXT NOT NULL, profile TEXT NOT NULL, roots_json TEXT NOT NULL, selectors_json TEXT NOT NULL, input_fingerprint TEXT NOT NULL, roots_fingerprint TEXT NOT NULL, catalog_fingerprint TEXT NOT NULL, profile_fingerprint TEXT NOT NULL, target_fingerprint TEXT NOT NULL, digest TEXT NOT NULL, operations_json TEXT NOT NULL, diagnostics_json TEXT NOT NULL, complete INTEGER NOT NULL CHECK(complete IN (0,1)), expires_at INTEGER NOT NULL, reviewed_digest TEXT, applied_at TEXT
);
CREATE INDEX IF NOT EXISTS catalog_relation_tuple ON catalog_relations(owner_user_id,scope_agent_id,from_entry_id,relation,to_entry_id);
