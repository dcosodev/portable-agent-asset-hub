-- Relation proposals are inferred facts kept separate from canonical skill_relations.
CREATE TABLE skill_relation_proposals (
  id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  scope_agent_id TEXT NOT NULL,
  source_skill_id TEXT NOT NULL,
  source_version INTEGER NOT NULL CHECK(source_version >= 1),
  target_skill_id TEXT NOT NULL,
  target_version_snapshot INTEGER NOT NULL CHECK(target_version_snapshot >= 1),
  relation_type TEXT NOT NULL,
  target_version_constraint TEXT,
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  detector TEXT NOT NULL,
  detector_version TEXT NOT NULL,
  model TEXT,
  evidence_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('proposed','approved','rejected','superseded','stale')),
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT,
  rejection_reason TEXT,
  proposal_fingerprint TEXT NOT NULL,
  PRIMARY KEY(id),
  UNIQUE(owner_user_id, scope_agent_id, proposal_fingerprint),
  FOREIGN KEY(source_skill_id, owner_user_id, scope_agent_id, source_version)
    REFERENCES skill_versions(id, owner_user_id, scope_agent_id, version),
  FOREIGN KEY(target_skill_id, owner_user_id, scope_agent_id, target_version_snapshot)
    REFERENCES skill_versions(id, owner_user_id, scope_agent_id, version)
);
CREATE INDEX skill_relation_proposals_source_version ON skill_relation_proposals(owner_user_id, scope_agent_id, source_skill_id, source_version);
CREATE INDEX skill_relation_proposals_target ON skill_relation_proposals(owner_user_id, scope_agent_id, target_skill_id);
CREATE INDEX skill_relation_proposals_review ON skill_relation_proposals(owner_user_id, scope_agent_id, status, confidence DESC);
CREATE INDEX skill_relation_proposals_type ON skill_relation_proposals(owner_user_id, scope_agent_id, relation_type);
CREATE TRIGGER skill_relation_proposals_immutable_identity
BEFORE UPDATE OF owner_user_id, scope_agent_id, source_skill_id, source_version, target_skill_id, target_version_snapshot, relation_type, target_version_constraint, evidence_json, proposal_fingerprint ON skill_relation_proposals
BEGIN SELECT RAISE(ABORT, 'proposal identity is immutable'); END;
