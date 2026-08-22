CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(memory_id UNINDEXED, owner_user_id UNINDEXED, agent_id UNINDEXED, version UNINDEXED, content, tokenize='unicode61');
