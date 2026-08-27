CREATE VIRTUAL TABLE IF NOT EXISTS catalog_fts USING fts5(
 entry_id UNINDEXED,
 owner_user_id UNINDEXED,
 scope_agent_id UNINDEXED,
 kind UNINDEXED,
 logical_key,
 name,
 summary,
 metadata_text,
 tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS catalog_fts_insert AFTER INSERT ON catalog_entries
WHEN NEW.lifecycle = 'active'
BEGIN
 INSERT INTO catalog_fts VALUES(NEW.id,NEW.owner_user_id,NEW.scope_agent_id,NEW.kind,NEW.logical_key,NEW.name,COALESCE(NEW.summary,''),NEW.metadata_json);
END;

CREATE TRIGGER IF NOT EXISTS catalog_fts_update AFTER UPDATE ON catalog_entries
BEGIN
 DELETE FROM catalog_fts WHERE entry_id=OLD.id AND owner_user_id=OLD.owner_user_id AND scope_agent_id=OLD.scope_agent_id;
 INSERT INTO catalog_fts
 SELECT NEW.id,NEW.owner_user_id,NEW.scope_agent_id,NEW.kind,NEW.logical_key,NEW.name,COALESCE(NEW.summary,''),NEW.metadata_json
 WHERE NEW.lifecycle = 'active';
END;

CREATE TRIGGER IF NOT EXISTS catalog_fts_delete AFTER DELETE ON catalog_entries
BEGIN
 DELETE FROM catalog_fts WHERE entry_id=OLD.id AND owner_user_id=OLD.owner_user_id AND scope_agent_id=OLD.scope_agent_id;
END;

INSERT INTO catalog_fts(entry_id,owner_user_id,scope_agent_id,kind,logical_key,name,summary,metadata_text)
SELECT e.id,e.owner_user_id,e.scope_agent_id,e.kind,e.logical_key,e.name,COALESCE(e.summary,''),e.metadata_json
FROM catalog_entries e
WHERE e.lifecycle='active'
AND NOT EXISTS (
 SELECT 1 FROM catalog_fts f WHERE f.entry_id=e.id AND f.owner_user_id=e.owner_user_id AND f.scope_agent_id=e.scope_agent_id
);