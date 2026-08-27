import { describe, expect, it } from 'vitest';
import { filterGraph, filterProposals, graphElements, graphProposalElements, graphStyles, parseGraph, RELATIONS } from './graph-model';
import type { GraphData } from './types';

const graph: GraphData = {
  nodes: [
    { id: 'a', skillId: 'a', version: 2, name: 'A', kind: 'skill', logicalKey: 'skill:a', lifecycle: 'active', totalSize: 1, resources: [], bodySha256: 'a'.repeat(64), history: [1, 2] },
    { id: 'b', skillId: 'b', version: 1, name: 'B', kind: 'skill', logicalKey: 'skill:b', lifecycle: 'stale', totalSize: 1, resources: [], bodySha256: 'b'.repeat(64) },
  ],
  edges: [{ source: 'a', sourceVersion: 2, type: 'requires', target: 'b', targetVersion: 1, constraint: '>=1', direction: 'dependencies' }],
  metadata: { nodes: 2, edges: 1, truncated: false, truncatedNodes: 0, truncatedEdges: 0, limits: { maxDepth: 4, maxNodes: 200, maxEdges: 1000 }, generatedAt: '2026-01-01T00:00:00Z', includeHistory: true },
};

describe('graph DTO/model', () => {
  it('parses graph DTO and rejects malformed or dangling graph data', () => {
    expect(parseGraph(graph)).toBe(graph);
    expect(() => parseGraph({ nodes: [{}], edges: [], metadata: {} })).toThrow('Invalid graph node');
    expect(() => parseGraph({ ...graph, edges: [{ ...graph.edges[0]!, target: 'missing' }] })).toThrow('Dangling graph edge');
  });

  it('renders node and directed labelled edge elements including version state', () => {
    const elements = graphElements(graph);
    expect(elements[0]?.data).toEqual(expect.objectContaining({ id: 'a', label: 'A · 2 versions' }));
    expect(elements[2]?.data).toEqual(expect.objectContaining({ source: 'a', target: 'b', label: 'requires >=1', relation: 'requires' }));
  });

  it('filters relation and lifecycle without dangling edges', () => {
    const filtered = filterGraph(graph, { relations: new Set(RELATIONS), lifecycle: 'active', query: '' });
    expect(filtered.nodes.map((node) => node.id)).toEqual(['a']);
    expect(filtered.edges).toEqual([]);
    const isolated = filterGraph(graph, { relations: new Set(RELATIONS), lifecycle: 'all', query: '', isolatedOnly: true });
    expect(isolated.nodes.map((node) => node.id)).toEqual([]);

  });

  it('renders proposed edges as separate dotted elements and filters them without changing canonical edges', () => {
    const proposal = { id: 'p1', sourceSkillId: 'a', sourceVersion: 2, targetSkillId: 'b', targetVersionSnapshot: 1, relationType: 'requires' as const, targetVersionConstraint: '>=1', confidence: 0.94, detector: 'explicit-reference-v1', reason: 'explicit', status: 'proposed' as const, evidence: [], createdAt: 'now' };
    const filtered = filterProposals([proposal], { relations: new Set(RELATIONS), lifecycle: 'all', query: '', proposalStatuses: new Set(['proposed']), proposalMinConfidence: 0.85, proposalDomain: 'operational' });
    expect(filtered).toHaveLength(1);
    const elements = graphProposalElements(graph, filtered.map((item) => ({ proposalId: item.id, sourceSkillId: item.sourceSkillId, sourceVersion: item.sourceVersion, targetSkillId: item.targetSkillId, targetVersion: item.targetVersionSnapshot, relationType: item.relationType, targetVersionConstraint: item.targetVersionConstraint, confidence: item.confidence, detector: item.detector, status: item.status })));
    expect(elements[0]?.data).toEqual(expect.objectContaining({ id: 'proposal:p1', proposed: 'yes', proposalId: 'p1', confidence: 0.94 }));
    expect(graphElements(graph).filter((element) => element.data?.proposed === 'yes')).toHaveLength(0);
  });

  it('encodes relation semantics and zoom-aware labels in Cytoscape styles', () => {
    const style = (selector: string) => {
      const rule = graphStyles.find((candidate) => 'selector' in candidate && String(candidate.selector).split(',').map((part) => part.trim()).includes(selector)) as { style?: Record<string, unknown> } | undefined;
      return rule?.style ?? {};
    };
    expect(style('node').label).toBe('');
    expect(style('node.selected-node').label).toBe('data(label)');
    expect(style('edge[relation = "requires"]')).toMatchObject({ 'line-style': 'solid', 'target-arrow-shape': 'triangle' });
    expect(style('edge[relation = "uses"]')).toMatchObject({ 'line-style': 'solid', 'target-arrow-shape': 'triangle' });
    expect(style('edge[relation = "extends"]')).toMatchObject({ 'target-arrow-shape': 'diamond' });
    expect(style('edge[relation = "supersedes"]')).toMatchObject({ 'line-style': 'solid', width: 2.2, 'target-arrow-shape': 'tee' });
    expect(style('edge[relation = "conflicts_with"]')).toMatchObject({ 'line-style': 'solid', width: 2.8, 'target-arrow-shape': 'diamond' });
    expect(style('edge[relation = "related_to"]')).toMatchObject({ 'line-style': 'solid', 'target-arrow-shape': 'none' });
    expect(style('edge[relation = "produces"]')).toMatchObject({ 'target-arrow-shape': 'triangle' });
    expect(style('edge[relation = "consumes"]')).toMatchObject({ 'line-style': 'solid', 'target-arrow-shape': 'triangle' });
  });
});
