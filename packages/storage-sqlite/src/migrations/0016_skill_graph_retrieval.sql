-- Version-aware skill relation graph and mandatory retrieval audit.
-- Relations are immutable constituents of the source skill version. The
-- resolved target version is snapshotted when the relation is published,
-- so resolving skill@vN remains reproducible even after target heads advance.

CREATE TABLE skill_relations (
  source_skill_id TEXT NOT NULL,
  source_version INTEGER NOT NULL CHECK(source_version >= 1),
  owner_user_id TEXT NOT NULL,
  scope_agent_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  target_skill_id TEXT NOT NULL,
  target_version_constraint TEXT,
  resolved_target_version INTEGER NOT NULL CHECK(resolved_target_version >= 1),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  PRIMARY KEY(source_skill_id, owner_user_id, scope_agent_id, source_version, relation_type, target_skill_id),
  FOREIGN KEY(source_skill_id, owner_user_id, scope_agent_id, source_version)
    REFERENCES skill_versions(id, owner_user_id, scope_agent_id, version),
  FOREIGN KEY(target_skill_id, owner_user_id, scope_agent_id, resolved_target_version)
    REFERENCES skill_versions(id, owner_user_id, scope_agent_id, version)
);

CREATE INDEX skill_relations_source
  ON skill_relations(owner_user_id, scope_agent_id, source_skill_id, source_version);
CREATE INDEX skill_relations_target
  ON skill_relations(owner_user_id, scope_agent_id, target_skill_id, relation_type);
CREATE INDEX skill_relations_type
  ON skill_relations(owner_user_id, scope_agent_id, relation_type);

CREATE TRIGGER skill_relations_immutable_update
BEFORE UPDATE ON skill_relations
BEGIN
  SELECT RAISE(ABORT, 'skill_relations are immutable');
END;

CREATE TRIGGER skill_relations_immutable_delete
BEFORE DELETE ON skill_relations
BEGIN
  SELECT RAISE(ABORT, 'skill_relations are immutable');
END;

CREATE TABLE retrieval_events (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  actor_agent_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  scope_agent_id TEXT NOT NULL,
  profile TEXT NOT NULL,
  query_redacted TEXT NOT NULL,
  query_sha256 TEXT NOT NULL CHECK(length(query_sha256) = 64),
  classification_json TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  candidates_json TEXT NOT NULL,
  selected_skills_json TEXT NOT NULL,
  selected_memories_json TEXT NOT NULL,
  graph_expansions_json TEXT NOT NULL,
  no_match INTEGER NOT NULL CHECK(no_match IN (0,1)),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_retrieval_events_scope_created
  ON retrieval_events(owner_user_id, scope_agent_id, created_at DESC);

CREATE TRIGGER retrieval_events_immutable_update
BEFORE UPDATE ON retrieval_events
BEGIN
  SELECT RAISE(ABORT, 'retrieval events are append-only');
END;

CREATE TRIGGER retrieval_events_immutable_delete
BEFORE DELETE ON retrieval_events
BEGIN
  SELECT RAISE(ABORT, 'retrieval events are append-only');
END;
CREATE INDEX retrieval_events_request
  ON retrieval_events(request_id);
