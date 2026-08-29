-- Approval provenance is orthogonal to workflow status: approved remains approved.
ALTER TABLE skill_relation_proposals ADD COLUMN approval_mode TEXT NOT NULL DEFAULT 'human' CHECK(approval_mode IN ('human','auto'));
ALTER TABLE skill_relation_proposals ADD COLUMN auto_approve_rule TEXT;
CREATE INDEX skill_relation_proposals_approval_mode
  ON skill_relation_proposals(owner_user_id, scope_agent_id, approval_mode, status);
