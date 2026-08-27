import { afterEach, describe, expect, it } from 'vitest';
import type { Core, EdgeSingular } from 'cytoscape';
import { applyEdgeFocus, applyNodeFocus, clearGraphFocus, layoutOptions, materializeGraph } from './GraphView';
import type { GraphData } from './types';

const graph: GraphData = {
  nodes: [
    { id: 'a', skillId: 'a', version: 1, name: 'A', kind: 'skill', logicalKey: 'skill:a', lifecycle: 'active', totalSize: 1, resources: [], bodySha256: 'a'.repeat(64) },
    { id: 'b', skillId: 'b', version: 1, name: 'B', kind: 'skill', logicalKey: 'skill:b', lifecycle: 'active', totalSize: 1, resources: [], bodySha256: 'b'.repeat(64) },
    { id: 'c', skillId: 'c', version: 1, name: 'C', kind: 'tool', logicalKey: 'tool:c', lifecycle: 'active', totalSize: 1, resources: [], bodySha256: 'c'.repeat(64) },
  ],
  edges: [
    { source: 'a', sourceVersion: 1, type: 'requires', target: 'b', targetVersion: 1, constraint: '=1', direction: 'dependencies' },
    { source: 'a', sourceVersion: 1, type: 'related_to', target: 'c', targetVersion: 1, constraint: null, direction: 'bidirectional' },
  ],
  metadata: { nodes: 3, edges: 2, truncated: false, truncatedNodes: 0, truncatedEdges: 0, limits: { maxDepth: 4, maxNodes: 200, maxEdges: 1000 }, generatedAt: 'now', includeHistory: false },
};

let cy: Core | undefined;
afterEach(() => cy?.destroy());

describe('Cytoscape materialization', () => {
  it('materializes every valid endpoint edge received from the Graph endpoint', () => {
    const instance = materializeGraph(graph);
    cy = instance;
    expect(instance.nodes().length).toBe(graph.nodes.length);
    expect(instance.edges().length).toBe(graph.edges.length);
    expect(instance.edges().map((edge: EdgeSingular) => [edge.data('source'), edge.data('target')])).toEqual([
      ['a', 'b'],
      ['a', 'c'],
    ]);
  });

  it('focuses a selected node, its neighbors, and its connected edges', () => {
    const instance = materializeGraph(graph);
    cy = instance;
    applyNodeFocus(instance, 'a');
    expect(instance.$id('a').hasClass('selected-node')).toBe(true);
    expect(instance.$id('b').hasClass('neighbor-node')).toBe(true);
    expect(instance.$id('c').hasClass('neighbor-node')).toBe(true);
    expect(instance.edges('.focused-edge').length).toBe(2);
    expect(instance.elements('.dimmed').length).toBe(0);

    clearGraphFocus(instance);
    expect(instance.elements('.selected-node, .neighbor-node, .focused-edge, .dimmed').length).toBe(0);
  });

  it('focuses an edge and only its two endpoints', () => {
    const instance = materializeGraph(graph);
    cy = instance;
    const edge = instance.edges()[0]!;
    applyEdgeFocus(instance, edge.id());
    expect(edge.hasClass('selected-edge')).toBe(true);
    expect(instance.$id('a').hasClass('edge-endpoint')).toBe(true);
    expect(instance.$id('b').hasClass('edge-endpoint')).toBe(true);
    expect(instance.$id('c').hasClass('dimmed')).toBe(true);
  });

  it('uses organic force-directed layout by default without preset positions', () => {
    expect(layoutOptions('force')).toEqual(expect.objectContaining({
      name: 'fcose',
      fit: true,
      avoidOverlap: true,
      nodeDimensionsIncludeLabels: true,
      randomize: true,
      tile: false,
      idealEdgeLength: 210,
    }));
  });
});
