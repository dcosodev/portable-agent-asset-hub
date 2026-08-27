import { readFileSync } from 'node:fs';
import { DeterministicRelationClassifier } from '@portable-agent-asset-hub/core';

const gold = JSON.parse(readFileSync(new URL('../tests/fixtures/relation-discovery-operational-gold.json', import.meta.url), 'utf8'));
const classifier = new DeterministicRelationClassifier();
const targetFor = (name) => ({ id: `skill:${name}`, version: 3, logicalKey: name, name, summary: '', metadata: {}, bodyExcerpt: '' });
const classify = (item) => classifier.classify({
  source: { id: `source:${item.id}`, version: 1, logicalKey: `skill:${item.id}`, name: item.id, summary: '', metadata: item.metadata ?? {}, bodyExcerpt: item.body },
  target: targetFor(item.target),
  signals: { explicit: true, ftsScore: 0, sharedTags: [] },
});
const results = gold.map((item) => ({ item, result: classify(item) }));
const expected = (item) => item.relation;
const correct = results.filter(({ item, result }) => result.relation === expected(item) && (item.expectedConstraint === undefined || result.targetVersionConstraint === item.expectedConstraint));
const predictedOperational = results.filter(({ result }) => result.relation !== 'none');
const expectedOperational = results.filter(({ item }) => expected(item) !== 'none');
const falsePositives = results.filter(({ item, result }) => expected(item) === 'none' && result.relation !== 'none');
const falseNegatives = results.filter(({ item, result }) => expected(item) !== 'none' && result.relation === 'none');
const wrongDirection = results.filter(({ item }) => item.label === 'wrong_direction' && classify(item).relation !== 'none');
const wrongRelation = results.filter(({ item, result }) => item.label === 'wrong_relation_type' && item.proposedRelation !== result.relation);
const report = {
  total: results.length,
  correct: correct.length,
  wrongRelation: wrongRelation.length,
  wrongDirection: wrongDirection.length,
  falsePositive: falsePositives.length,
  falseNegative: falseNegatives.length,
  operationalExpected: expectedOperational.length,
  operationalPredicted: predictedOperational.length,
  precision: predictedOperational.length ? Number(((predictedOperational.length - falsePositives.length) / predictedOperational.length).toFixed(4)) : 1,
  recall: expectedOperational.length ? Number(((expectedOperational.length - falseNegatives.length) / expectedOperational.length).toFixed(4)) : 1,
  results: results.map(({ item, result }) => ({ id: item.id, label: item.label, expected: expected(item), actual: result.relation, confidence: result.confidence, constraint: result.targetVersionConstraint, reason: result.reason })),
};
console.log(JSON.stringify(report, null, 2));
