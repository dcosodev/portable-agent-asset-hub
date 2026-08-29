import { describe, expect, it } from 'vitest';
import { autoApprovableExplicitCandidates } from '@portable-agent-asset-hub/core';
import type { ExplicitRelationCandidate } from '@portable-agent-asset-hub/core';

function candidate(overrides: Partial<ExplicitRelationCandidate> = {}): ExplicitRelationCandidate {
  return {
    pairKey: 'related_to:a->b',
    sourceSkillId: 'a',
    sourceLogicalKey: 'a',
    sourceVersion: 1,
    targetSkillId: 'b',
    targetLogicalKey: 'b',
    targetVersion: 1,
    relationType: 'related_to',
    sourceDeclaresTarget: true,
    targetDeclaredSource: true,
    reciprocal: true,
    status: 'READY_FOR_REVIEW',
    activeProposalIds: [],
    canonicalRelationId: null,
    evidence: {
      metadataField: 'metadata.hermes.related_skills',
      sourceDeclaredTarget: true,
      targetDeclaredSource: true,
      reciprocal: true,
    },
    ...overrides,
  };
}

describe('autoApprovableExplicitCandidates', () => {
  it('eligibiliza un candidato recíproco y resuelto', () => {
    const result = autoApprovableExplicitCandidates([candidate()]);
    expect(result.eligible).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it('rechaza un candidato unidireccional', () => {
    const result = autoApprovableExplicitCandidates([candidate({ reciprocal: false, targetDeclaredSource: false })]);
    expect(result.eligible).toHaveLength(0);
    expect(result.rejected[0]?.reason).toMatch(/reciprocal/i);
  });

  it('rechaza AMBIGUOUS aunque sea recíproco', () => {
    const result = autoApprovableExplicitCandidates([candidate({ status: 'AMBIGUOUS' })]);
    expect(result.eligible).toHaveLength(0);
    expect(result.rejected[0]?.reason).toMatch(/ambiguous/i);
  });

  it('rechaza UNRESOLVED y candidatos sin target', () => {
    const result = autoApprovableExplicitCandidates([
      candidate({ status: 'UNRESOLVED', targetSkillId: null }),
    ]);
    expect(result.eligible).toHaveLength(0);
    expect(result.rejected[0]?.reason).toMatch(/unresolved|target/i);
  });
});
