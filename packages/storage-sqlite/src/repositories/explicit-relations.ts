// packages/storage-sqlite/src/repositories/explicit-relations.ts
//
// SQLite adapter for the explicit-relation extractor. The adapter
// implements `ExplicitRelationSource` from core and reads the
// `metadata_json` column on `skill_entries` plus the proposal and
// canonical relation tables. It does not depend on Relation Discovery.
import type { DatabaseSync } from 'node:sqlite';
import {
  type CanonicalRelationRow,
  type ExplicitRelationCandidate,
  type ExplicitRelationSource,
  type ExplicitSkillHead,
  type RelationProposal,
  type RelationProposalOrigin,
  type RelationProposalStatus,
  type Scope,
  type SkillRelationType,
  listExplicitCandidates,
} from '@portable-agent-asset-hub/core';

export class SqliteExplicitRelationSource implements ExplicitRelationSource {
  public constructor(private readonly db: DatabaseSync) {}

  public listActiveHeads(scope: Scope): ExplicitSkillHead[] {
    const rows = this.db
      .prepare(
        `SELECT e.id, e.logical_key, e.current_version, e.metadata_json, v.body
         FROM skill_entries e
         JOIN skill_versions v
           ON v.id = e.id AND v.owner_user_id = e.owner_user_id AND v.scope_agent_id = e.scope_agent_id
          AND v.version = e.current_version
         WHERE e.owner_user_id = ? AND e.scope_agent_id = ? AND e.lifecycle = 'active'
         ORDER BY e.logical_key, e.id`,
      )
      .all(scope.ownerUserId, scope.agentId) as Array<{
        id: string;
        logical_key: string;
        current_version: number;
        metadata_json: string;
        body: Buffer;
      }>;
    return rows.map((row) => {
      let metadata: unknown;
      try {
        metadata = JSON.parse(String(row.metadata_json));
      } catch {
        metadata = null;
      }
      return {
        id: String(row.id),
        logicalKey: String(row.logical_key),
        version: Number(row.current_version),
        body: Buffer.from(row.body),
        metadata,
      };
    });
  }

  public listActiveProposals(
    scope: Scope,
    filters: { status?: RelationProposalStatus; origin?: RelationProposalOrigin } = {},
  ): RelationProposal[] {
    const where: string[] = ['owner_user_id = ?', 'scope_agent_id = ?'];
    const params: Array<string> = [scope.ownerUserId, scope.agentId];
    if (filters.status) {
      where.push('status = ?');
      params.push(filters.status);
    }
    if (filters.origin) {
      where.push('origin = ?');
      params.push(filters.origin);
    }
    const rows = this.db
      .prepare(
        `SELECT id, source_skill_id, source_version, target_skill_id, target_version_snapshot, relation_type, target_version_constraint, confidence, detector, detector_version, model, evidence_json, reason, status, origin, created_at, reviewed_at, reviewed_by, rejection_reason, proposal_fingerprint, candidate_score
         FROM skill_relation_proposals
         WHERE ${where.join(' AND ')}`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapProposal(row));
  }

  public listCanonicalRelations(scope: Scope): CanonicalRelationRow[] {
    const rows = this.db
      .prepare(
        `SELECT source_skill_id, source_version, relation_type, target_skill_id
         FROM skill_relations
         WHERE owner_user_id = ? AND scope_agent_id = ?`,
      )
      .all(scope.ownerUserId, scope.agentId) as Array<{
        source_skill_id: string;
        source_version: number;
        relation_type: string;
        target_skill_id: string;
      }>;
    return rows.map((row, index) => ({
      id: `${row.source_skill_id}@${row.source_version}@${row.relation_type}@${row.target_skill_id}@${index}`,
      sourceSkillId: String(row.source_skill_id),
      sourceVersion: Number(row.source_version),
      relationType: String(row.relation_type) as SkillRelationType,
      targetSkillId: String(row.target_skill_id),
    }));
  }

  public listCandidates(
    scope: Scope,
    options: Parameters<typeof listExplicitCandidates>[2] = {},
  ): {
    items: ExplicitRelationCandidate[];
    summary: ReturnType<typeof listExplicitCandidates>['summary'];
    nextCursor: string | null;
  } {
    return listExplicitCandidates(this, scope, options);
  }

  private mapProposal(row: Record<string, unknown>): RelationProposal {
    return {
      id: String(row.id),
      scope: { ownerUserId: String(row.owner_user_id ?? 'usr_local'), agentId: String(row.scope_agent_id ?? 'agt_local') },
      sourceSkillId: String(row.source_skill_id),
      sourceVersion: Number(row.source_version),
      targetSkillId: String(row.target_skill_id),
      targetVersionSnapshot: Number(row.target_version_snapshot),
      relationType: String(row.relation_type) as SkillRelationType,
      targetVersionConstraint: row.target_version_constraint === null ? null : String(row.target_version_constraint),
      reviewedRelationType: null,
      reviewedSourceSkillId: null,
      reviewedTargetSkillId: null,
      reviewedConstraint: null,
      reviewedConstraintSet: false,
      reviewModified: false,
      origin: (String(row.origin) === 'discovered' || String(row.origin) === 'manual' ? String(row.origin) : 'manual') as 'discovered' | 'manual',
      candidateScore: row.candidate_score === null ? null : Number(row.candidate_score),
      confidence: Number(row.confidence),
      detector: String(row.detector),
      detectorVersion: String(row.detector_version),
      model: row.model === null ? null : String(row.model),
      evidence: [],
      reason: String(row.reason),
      status: String(row.status) as RelationProposalStatus,
      createdAt: String(row.created_at),
      reviewedAt: row.reviewed_at === null ? null : String(row.reviewed_at),
      reviewedBy: row.reviewed_by === null ? null : String(row.reviewed_by),
      rejectionReason: row.rejection_reason === null ? null : String(row.rejection_reason),
      proposalFingerprint: String(row.proposal_fingerprint),
    };
  }
}
