-- S1 schema marker: 001-skills
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS skills (
  id TEXT NOT NULL,
  version_id TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  head INTEGER NOT NULL CHECK (head IN (0, 1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (id, version),
  UNIQUE (slug, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_head ON skills(slug) WHERE head = 1;
CREATE INDEX IF NOT EXISTS skills_slug_version ON skills(slug, version);
CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(slug, title, body);
INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', '001-skills');
