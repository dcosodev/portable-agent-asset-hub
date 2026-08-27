import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DeterministicRelationClassifier, confidenceBand, proposalFingerprint, resolveEffectiveProposal, validateClassification, validateDirection } from '@portable-agent-asset-hub/core';

type GoldCase = {
  id: string;
  relation: string;
  proposedRelation?: string;
  target: string;
  body: string;
  metadata?: Record<string, unknown>;
  expectedConstraint?: string | null;
  expectedConfidence?: 'high' | 'medium' | 'low';
  label: string;
};

const gold = JSON.parse(readFileSync(new URL('../fixtures/relation-discovery-operational-gold.json', import.meta.url), 'utf8')) as GoldCase[];
const classifier = new DeterministicRelationClassifier();
const targetFor = (name: string) => ({ id: `skill:${name}`, version: 3, logicalKey: name, name, summary: '', metadata: {}, bodyExcerpt: '' });
const classify = (item: GoldCase) => classifier.classify({
  source: { id: `source:${item.id}`, version: 1, logicalKey: `skill:${item.id}`, name: item.id, summary: '', metadata: item.metadata ?? {}, bodyExcerpt: item.body },
  target: targetFor(item.target),
  signals: { explicit: true, ftsScore: 0, sharedTags: [] },
});

describe('relation proposal classifier', () => {
  it('executes every persisted gold case against the productive classifier', () => {
    const results = gold.map((item) => ({ item, result: classify(item) }));
    const correct = results.filter(({ item, result }) => result.relation === item.relation && (item.expectedConstraint === undefined || result.targetVersionConstraint === item.expectedConstraint)).length;
    const operational = results.filter(({ item }) => item.relation !== 'none');
    const predictedOperational = results.filter(({ result }) => result.relation !== 'none');
    const falsePositive = results.filter(({ item, result }) => item.relation === 'none' && result.relation !== 'none');
    const precision = predictedOperational.length ? (predictedOperational.length - falsePositive.length) / predictedOperational.length : 1;
    expect(results).toHaveLength(gold.length);
    expect(correct).toBeGreaterThanOrEqual(15);
    expect(precision).toBeGreaterThanOrEqual(0.9);
    expect(operational.length).toBeGreaterThan(0);
  });

  it.each(gold.filter((item) => item.relation === 'none'))('abstains for $label', (item) => {
    expect(classify(item).relation).toBe('none');
  });

  it('keeps requires and uses semantically distinct', () => {
    expect(classify(gold.find((item) => item.id === 'positive-requires')!).relation).toBe('requires');
    expect(classify(gold.find((item) => item.id === 'positive-uses')!).relation).toBe('uses');
    expect(classify(gold.find((item) => item.id === 'wrong-type')!).relation).toBe('requires');
    expect(gold.find((item) => item.id === 'wrong-type')!.proposedRelation).toBe('uses');
  });

  it('records explicit constraints only when tied to the target reference', () => {
    expect(classify(gold.find((item) => item.id === 'requires-v3')!).targetVersionConstraint).toBe('>=3');
    expect(classify(gold.find((item) => item.id === 'requires-version')!).targetVersionConstraint).toBe('=4');
    expect(classify(gold.find((item) => item.id === 'no-invented-constraint')!).targetVersionConstraint).toBeNull();
  });

  it('classifies explicit prerequisite and records provenance', () => {
    const result = classify(gold.find((item) => item.id === 'positive-requires')!);
    expect(result.relation).toBe('requires');
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    expect(result.evidence[0]).toMatchObject({ kind: 'source_text', source: 'body' });
    expect(result.evidence[0]?.targetMentionOffset).toBeTypeOf('number');
  });

  it('uses related_to for similarity and none for weak pairs', () => {
    const base = { id: 'deploy', version: 4, logicalKey: 'deploy-eks', name: 'deploy-eks', summary: '', metadata: {}, bodyExcerpt: '' };
    const target = { id: 'aws', version: 2, logicalKey: 'aws-auth', name: 'aws-auth', summary: '', metadata: {}, bodyExcerpt: 'AWS authentication.' };
    expect(classifier.classify({ source: base, target, signals: { explicit: false, ftsScore: 0.4, sharedTags: [] } }).relation).toBe('related_to');
    expect(classifier.classify({ source: { ...base, name: 'unrelated', logicalKey: 'unrelated' }, target, signals: { explicit: false, ftsScore: 0, sharedTags: [] } }).relation).toBe('none');
  });

  it('validates relation direction against the local predicate', () => {
    expect(validateDirection('Run aws-auth before deploying.', 'aws-auth', 'requires')).toBe(true);
    expect(validateDirection('aws-auth uses this skill.', 'aws-auth', 'uses')).toBe(false);
  });

  it('resolves reviewed values without overwriting original suggestion', () => {
    expect(resolveEffectiveProposal({ sourceSkillId: 'a', targetSkillId: 'b', relationType: 'requires', targetVersionConstraint: '>=3', reviewedSourceSkillId: 'b', reviewedTargetSkillId: 'a', reviewedRelationType: 'uses', reviewedConstraint: null, reviewedConstraintSet: true })).toEqual({ sourceSkillId: 'b', targetSkillId: 'a', relationType: 'uses', targetVersionConstraint: null });
  });

  it('rejects invalid structured output and bands confidence', () => {
    expect(() => validateClassification({ relation: 'not-supported', confidence: 1, reason: 'x', evidence: [] })).toThrow();
    expect(confidenceBand(0.9)).toBe('high');
    expect(confidenceBand(0.7)).toBe('medium');
    expect(confidenceBand(0.2)).toBe('low');
  });

  it('fingerprint is stable', () => {
    const input = { scope: { ownerUserId: 'u', agentId: 'a' }, sourceSkillId: 's', sourceVersion: 1, targetSkillId: 't', relationType: 'related_to' as const, targetVersionConstraint: null, evidence: [], detectorVersion: 'v1' };
    expect(proposalFingerprint(input)).toBe(proposalFingerprint({ ...input }));
  });
});
