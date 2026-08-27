// packages/core/src/skills/relation-identity.ts
//
// Shared identity & equivalence helpers for skill relations.
//
// One source of truth for "what is a relation" and "what makes two
// relations equivalent". Used by:
//   - ExplicitRelationCandidate extractor (explicit-relations.ts)
//   - supersedeCanonicalDuplicates / reconcileCanonicalDuplicates (relation-proposal.ts)
//   - Active proposal equivalence checks
//
// Rules per relation type:
//   - related_to:    symmetric  (A->B == B->A)
//   - requires:      directional
//   - uses:          directional
//   - extends:       directional
//   - supersedes:    directional
//   - produces:      directional
//   - consumes:      directional
//   - conflicts_with:directional (kept as-is; we do not infer a new
//                          symmetry here without a dedicated review)
import type { SkillRelationType } from './graph.js';

export type RelationIdentity = {
  sourceSkillId: string;
  sourceVersion: number;
  targetSkillId: string;
  targetVersion: number | null;
  relationType: SkillRelationType;
};

/**
 * Stable key used for de-duplication and equivalence checks. Symmetric for
 * `related_to`, directional for everything else.
 */
export function normalizeRelationIdentity(identity: RelationIdentity): string {
  const [a, b] = identity.relationType === 'related_to'
    ? [identity.sourceSkillId, identity.targetSkillId].sort()
    : [identity.sourceSkillId, identity.targetSkillId];
  return pairKey(a, b, identity.relationType);
}

/**
 * Directional key (always source -> target). Used for symmetric types
 * like `related_to` to compare both directions as equivalent and for
 * directional types when the direction matters.
 */
export function directionalRelationKey(identity: Pick<RelationIdentity, 'sourceSkillId' | 'targetSkillId' | 'relationType'>): string {
  return pairKey(identity.sourceSkillId, identity.targetSkillId, identity.relationType);
}

function pairKey(a: string, b: string, type: string): string {
  return `${type}@${a}->${b}`;
}

/**
 * True iff the two identities refer to the same effective relation under
 * the per-type rules above.
 */
export function isRelationEquivalent(a: RelationIdentity, b: Pick<RelationIdentity, 'sourceSkillId' | 'targetSkillId' | 'relationType'>): boolean {
  if (a.relationType !== b.relationType) return false;
  return normalizeRelationIdentity(a) === normalizeRelationIdentity({
    ...b,
    sourceVersion: a.sourceVersion,
    targetVersion: a.targetVersion,
  });
}

/**
 * True iff the relation type is symmetric (only `related_to` currently).
 */
export function isSymmetricRelationType(relationType: SkillRelationType): boolean {
  return relationType === 'related_to';
}
