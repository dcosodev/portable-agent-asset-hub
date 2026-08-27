-- Human review fields extend staging without changing canonical skill_relations or SKILL.md.
ALTER TABLE skill_relation_proposals ADD COLUMN reviewed_relation_type TEXT;
ALTER TABLE skill_relation_proposals ADD COLUMN reviewed_source_skill_id TEXT;
ALTER TABLE skill_relation_proposals ADD COLUMN reviewed_target_skill_id TEXT;
ALTER TABLE skill_relation_proposals ADD COLUMN reviewed_constraint TEXT;
ALTER TABLE skill_relation_proposals ADD COLUMN reviewed_constraint_set INTEGER NOT NULL DEFAULT 0 CHECK(reviewed_constraint_set IN (0,1));
ALTER TABLE skill_relation_proposals ADD COLUMN review_modified INTEGER NOT NULL DEFAULT 0 CHECK(review_modified IN (0,1));
ALTER TABLE skill_relation_proposals ADD COLUMN origin TEXT NOT NULL DEFAULT 'discovered' CHECK(origin IN ('discovered','manual'));
ALTER TABLE skill_relation_proposals ADD COLUMN candidate_score REAL CHECK(candidate_score IS NULL OR (candidate_score >= 0 AND candidate_score <= 1));
CREATE INDEX skill_relation_proposals_origin ON skill_relation_proposals(owner_user_id, scope_agent_id, origin, status);
