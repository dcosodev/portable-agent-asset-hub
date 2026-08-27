-- packages/storage-sqlite/src/migrations/0015_skills.sql
--
-- Phase 1: skill versioned storage.
--
-- Tables added contiguously on top of 0014 without touching the
-- existing catalog schema. The runner enforces the sequence 0001..
-- 0015 with no gaps; this migration is #15.
--
--   * skill_entries          (logical + scope key, mirrors catalog)
--   * skill_versions         (immutable, monotonic version per id)
--   * skill_resources        (per-version resources, ordered by path)
--   * skill_active_head      (current_version pointer per (scope,id))
--   * skill_fts              (FTS5 for active skills; resources NOT indexed)
--
-- All FKs are scoped by (owner_user_id, scope_agent_id) so the
-- existing catalog CAS / audit lines remain intact.
--
-- FTS maintenance model:
--
--   The previous design wired AFTER INSERT/UPDATE triggers on
--   skill_entries, which fired BEFORE the matching skill_versions
--   row was committed by the write path. The SELECT against
--   skill_versions therefore returned NULL, leaving the FTS body
--   column empty and every FTS5 search failing on the happy path.
--
--   The new model wires an AFTER INSERT trigger on skill_versions so
--   the body is guaranteed to be present when it refreshes the FTS row.
--   BEFORE UPDATE/DELETE triggers enforce immutable version history.
--   Lifecycle transitions out of
--   'active' (the only lifecycle that should be indexed) are handled
--   by AFTER UPDATE triggers on skill_entries that simply drop the
--   matching FTS row when NEW.lifecycle != 'active'.
--
--   Resource bytes are NEVER indexed.

CREATE TABLE IF NOT EXISTS skill_entries (
  id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  scope_agent_id TEXT NOT NULL,
  logical_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('skill','tool')),
  name TEXT NOT NULL,
  summary TEXT,
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('candidate','active','stale','rejected')),
  current_version INTEGER NOT NULL CHECK(current_version >= 1),
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(id, owner_user_id, scope_agent_id),
  UNIQUE(owner_user_id, scope_agent_id, logical_key)
);

CREATE TABLE IF NOT EXISTS skill_versions (
  id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  scope_agent_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  body BLOB NOT NULL,
  body_sha256 TEXT NOT NULL,
  total_size INTEGER NOT NULL CHECK(total_size >= 0),
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(id, owner_user_id, scope_agent_id, version),
  FOREIGN KEY(id, owner_user_id, scope_agent_id)
    REFERENCES skill_entries(id, owner_user_id, scope_agent_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS skill_versions_entry
  ON skill_versions(owner_user_id, scope_agent_id, id, version);

CREATE TABLE IF NOT EXISTS skill_resources (
  id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  scope_agent_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  relative_path TEXT NOT NULL,
  mode INTEGER NOT NULL CHECK(mode IN (420, 493)),
  mime TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size >= 0),
  sha256 TEXT NOT NULL,
  bytes BLOB NOT NULL,
  PRIMARY KEY(id, owner_user_id, scope_agent_id, version, relative_path),
  FOREIGN KEY(id, owner_user_id, scope_agent_id, version)
    REFERENCES skill_versions(id, owner_user_id, scope_agent_id, version)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS skill_resources_path
  ON skill_resources(owner_user_id, scope_agent_id, id, version, relative_path);

CREATE TABLE IF NOT EXISTS skill_active_head (
  id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  scope_agent_id TEXT NOT NULL,
  current_version INTEGER NOT NULL CHECK(current_version >= 1),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(id, owner_user_id, scope_agent_id),
  FOREIGN KEY(id, owner_user_id, scope_agent_id)
    REFERENCES skill_entries(id, owner_user_id, scope_agent_id)
    ON DELETE CASCADE
);

CREATE VIRTUAL TABLE IF NOT EXISTS skill_fts USING fts5(
  id UNINDEXED,
  owner_user_id UNINDEXED,
  scope_agent_id UNINDEXED,
  lifecycle UNINDEXED,
  logical_key,
  name,
  summary,
  tags,
  body,
  tokenize = 'unicode61'
);

-- AFTER INSERT on skill_versions: the body is now guaranteed to exist.
-- Index only when the matching entry is active.
CREATE TRIGGER IF NOT EXISTS skill_fts_versions_insert
AFTER INSERT ON skill_versions
BEGIN
  DELETE FROM skill_fts
    WHERE skill_fts.id = NEW.id
      AND skill_fts.owner_user_id = NEW.owner_user_id
      AND skill_fts.scope_agent_id = NEW.scope_agent_id;
  INSERT INTO skill_fts(id, owner_user_id, scope_agent_id, lifecycle, logical_key, name, summary, tags, body)
  SELECT NEW.id, NEW.owner_user_id, NEW.scope_agent_id, e.lifecycle,
         e.logical_key, e.name, COALESCE(e.summary, ''),
         COALESCE(json_extract(e.metadata_json, '$.tags'), ''),
         NEW.body
  FROM skill_entries e
  WHERE e.id = NEW.id
    AND e.owner_user_id = NEW.owner_user_id
    AND e.scope_agent_id = NEW.scope_agent_id
    AND e.lifecycle = 'active'
    AND NEW.version = e.current_version;
END;

-- Persisted versions are immutable. Corrections append a new version
-- through the CAS write path; in-place edits would invalidate hashes,
-- provenance and replay.
CREATE TRIGGER IF NOT EXISTS skill_versions_immutable_update
BEFORE UPDATE ON skill_versions
BEGIN
  SELECT RAISE(ABORT, 'skill_versions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS skill_versions_immutable_delete
BEFORE DELETE ON skill_versions
BEGIN
  SELECT RAISE(ABORT, 'skill_versions are immutable');
END;

-- Lifecycle transitions: the only event we react to here is the
-- entry leaving 'active' (we drop the FTS row). Re-entry into 'active'
-- is handled by the AFTER INSERT trigger on skill_versions when the
-- matching version row is written immediately after the entry UPDATE,
-- so this trigger deliberately does NOT try to re-index on transitions
-- stale->active / rejected->active. Doing so would force the trigger
-- to read skill_versions BEFORE the new row exists and leave the FTS
-- body column NULL.
CREATE TRIGGER IF NOT EXISTS skill_fts_lifecycle_update
AFTER UPDATE OF lifecycle ON skill_entries
WHEN NEW.lifecycle IS NOT OLD.lifecycle AND NEW.lifecycle != 'active'
BEGIN
  DELETE FROM skill_fts
    WHERE skill_fts.id = NEW.id
      AND skill_fts.owner_user_id = NEW.owner_user_id
      AND skill_fts.scope_agent_id = NEW.scope_agent_id;
END;

-- AFTER DELETE on skill_entries: drop the FTS row when the entry goes away.
CREATE TRIGGER IF NOT EXISTS skill_fts_entries_delete
AFTER DELETE ON skill_entries
BEGIN
  DELETE FROM skill_fts
    WHERE skill_fts.id = OLD.id
      AND skill_fts.owner_user_id = OLD.owner_user_id
      AND skill_fts.scope_agent_id = OLD.scope_agent_id;
END;

-- Backfill: index any pre-existing active entries (none expected on a
-- fresh install, but the migration must be idempotent and complete on
-- any DB that pre-dated 0015).
INSERT INTO skill_fts(id, owner_user_id, scope_agent_id, lifecycle, logical_key, name, summary, tags, body)
SELECT e.id, e.owner_user_id, e.scope_agent_id, e.lifecycle, e.logical_key, e.name,
       COALESCE(e.summary, ''),
       COALESCE(json_extract(e.metadata_json, '$.tags'), ''),
       (SELECT v.body FROM skill_versions v
         WHERE v.id = e.id AND v.owner_user_id = e.owner_user_id AND v.scope_agent_id = e.scope_agent_id AND v.version = e.current_version)
FROM skill_entries e
WHERE e.lifecycle = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM skill_fts f
    WHERE f.id = e.id AND f.owner_user_id = e.owner_user_id AND f.scope_agent_id = e.scope_agent_id
  );
