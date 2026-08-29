import type { ElementDefinition, StylesheetJson } from 'cytoscape';
import type { Filters, GraphData, GraphEdge, ProposalRenderEdge, RelationProposal, RelationType } from './types';

export const RELATIONS: RelationType[] = [
  'requires',
  'uses',
  'extends',
  'supersedes',
  'conflicts_with',
  'related_to',
  'produces',
  'consumes',
];

export function parseGraph(value: unknown): GraphData {
  if (!value || typeof value !== 'object') throw new Error('Invalid graph DTO');
  const graph = value as Partial<GraphData>;
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !graph.metadata || typeof graph.metadata !== 'object') {
    throw new Error('Invalid graph DTO');
  }
  for (const node of graph.nodes) {
    if (!node || typeof node.id !== 'string' || typeof node.skillId !== 'string' || typeof node.version !== 'number' || typeof node.name !== 'string') {
      throw new Error('Invalid graph node');
    }
  }
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  for (const edge of graph.edges) {
    if (!edge || typeof edge.source !== 'string' || typeof edge.target !== 'string' || !RELATIONS.includes(edge.type)) {
      throw new Error('Invalid graph edge');
    }
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) throw new Error('Dangling graph edge');
  }
  return graph as GraphData;
}

export function filterGraph(graph: GraphData, filters: Filters): GraphData {
  const canonicalDegree = new Map<string, number>();
  for (const edge of graph.edges) { canonicalDegree.set(edge.source, (canonicalDegree.get(edge.source) ?? 0) + 1); canonicalDegree.set(edge.target, (canonicalDegree.get(edge.target) ?? 0) + 1); }
  const nodes = graph.nodes.filter((node) => {
    const metadata = JSON.stringify(node.metadata ?? {}).toLowerCase();
    const scope = `${node.scope?.ownerUserId ?? ''}/${node.scope?.agentId ?? ''}`.toLowerCase();
    return (
      (filters.lifecycle === 'all' || node.lifecycle === filters.lifecycle) &&
      (filters.kind === undefined || filters.kind === 'all' || node.kind === filters.kind) &&
      (!filters.isolatedOnly || (canonicalDegree.get(node.id) ?? 0) === 0) &&
      (!filters.query || `${node.name} ${node.logicalKey} ${metadata}`.toLowerCase().includes(filters.query.toLowerCase())) &&
      (!filters.owner || (node.owner ?? '').toLowerCase().includes(filters.owner.toLowerCase())) &&
      (!filters.scope || scope.includes(filters.scope.toLowerCase())) &&
      (!filters.tag || metadata.includes(filters.tag.toLowerCase())) &&
      (!filters.profile || metadata.includes(filters.profile.toLowerCase()))
    );
  });
  const ids = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => filters.relations.has(edge.type) && ids.has(edge.source) && ids.has(edge.target));
  return { ...graph, nodes, edges, metadata: { ...graph.metadata, nodes: nodes.length, edges: edges.length } };
}

export function proposalDomain(relation: RelationType): 'operational' | 'semantic' {
  return relation === 'related_to' ? 'semantic' : 'operational';
}

export const FTS_SEMANTIC_PROPOSAL_DETECTOR = 'fts-candidate-v1';

export function filterProposals(proposals: RelationProposal[], filters: Filters): RelationProposal[] {
  const statuses = filters.proposalStatuses ?? new Set(['proposed'] as const);
  const minConfidence = filters.proposalMinConfidence ?? 0;
  return proposals.filter((proposal) => proposal.detector !== FTS_SEMANTIC_PROPOSAL_DETECTOR && statuses.has(proposal.status) && proposal.confidence >= minConfidence &&
    (!filters.proposalDetectors || filters.proposalDetectors.size === 0 || filters.proposalDetectors.has(proposal.detector)) &&
    (filters.proposalDomain === undefined || filters.proposalDomain === 'both' || proposalDomain(proposal.relationType) === filters.proposalDomain) &&
    filters.relations.has(proposal.relationType));
}

export function proposalEdgeId(proposal: ProposalRenderEdge): string { return `proposal:${proposal.proposalId}`; }

export function graphProposalElements(graph: GraphData, proposals: ProposalRenderEdge[]): ElementDefinition[] {
  const nodeFor = (skillId: string, version: number) => graph.nodes.find((node) => node.skillId === skillId && node.version === version) ?? graph.nodes.find((node) => node.skillId === skillId);
  return proposals.flatMap((proposal) => {
    const source = nodeFor(proposal.sourceSkillId, proposal.sourceVersion);
    const target = nodeFor(proposal.targetSkillId, proposal.targetVersion);
    if (!source || !target) return [];
    return [{ data: { id: proposalEdgeId(proposal), source: source.id, target: target.id, label: proposal.targetVersionConstraint ? `${proposal.relationType} ${proposal.targetVersionConstraint}` : `${proposal.relationType}?`, relation: proposal.relationType, proposed: 'yes', proposalId: proposal.proposalId, confidence: proposal.confidence, confidenceBand: proposal.confidence >= 0.85 ? 'high' : proposal.confidence >= 0.6 ? 'medium' : 'low', detector: proposal.detector, status: proposal.status, sourceSkillId: proposal.sourceSkillId, targetSkillId: proposal.targetSkillId } }];
  });
}

export function edgeId(edge: GraphEdge): string {
  return `${edge.source}@${edge.sourceVersion}:${edge.type}:${edge.target}@${edge.targetVersion}`;
}

export function graphElements(graph: GraphData, proposals: ProposalRenderEdge[] = []): ElementDefinition[] {
  const degree = new Map<string, number>();
  for (const edge of graph.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  return [
    ...graph.nodes.map((node) => {
      const nodeDegree = degree.get(node.id) ?? 0;
      return {
        data: {
          id: node.id,
          label: `${node.name}${node.history ? ` · ${node.history.length} versions` : ''}`,
          kind: node.kind,
          lifecycle: node.lifecycle,
          selectionReason: node.selection?.reason ?? '',
          degree: nodeDegree,
          size: Math.min(26, 11 + nodeDegree * 3 + (node.kind === 'tool' ? 2 : 0)),
          root: graph.root?.id === node.skillId ? 'yes' : 'no',
        },
      };
    }),
    ...graph.edges.map((edge) => ({
      data: {
        id: edgeId(edge),
        source: edge.source,
        target: edge.target,
        label: edge.constraint ? `${edge.type} ${edge.constraint}` : edge.type,
        relation: edge.type,
        proposed: 'no',
      },
    })),
    ...graphProposalElements(graph, proposals),
  ];
}

const relationStyle: Record<RelationType, {
  line: 'solid' | 'dashed' | 'dotted';
  arrow: 'triangle' | 'none' | 'diamond' | 'tee';
  color: string;
  width?: number;
}> = {
  requires: { line: 'solid', arrow: 'triangle', color: '#8ab4f8', width: 1.8 },
  uses: { line: 'solid', arrow: 'triangle', color: '#81c995', width: 1.6 },
  extends: { line: 'solid', arrow: 'diamond', color: '#c58af9', width: 1.8 },
  supersedes: { line: 'solid', arrow: 'tee', color: '#fdd663', width: 2.2 },
  conflicts_with: { line: 'solid', arrow: 'diamond', color: '#f28b82', width: 2.8 },
  related_to: { line: 'solid', arrow: 'none', color: '#78d9ec', width: 1.2 },
  produces: { line: 'solid', arrow: 'triangle', color: '#56c8d8', width: 1.7 },
  consumes: { line: 'solid', arrow: 'triangle', color: '#fcad70', width: 1.7 },
};

export const graphStyles: StylesheetJson = [
  {
    selector: 'node',
    style: {
      shape: 'ellipse',
      width: 'data(size)',
      height: 'data(size)',
      'background-color': '#6f8fcb',
      'border-color': '#a9c7ff',
      'border-width': 1,
      label: '',
      color: '#dce8ff',
      'font-size': 9,
      'font-weight': 500,
      'text-valign': 'bottom',
      'text-halign': 'center',
      'text-margin-y': 5,
      'text-outline-color': '#11151f',
      'text-outline-width': 2,
      'min-zoomed-font-size': 7,
      opacity: 0.9,
      'transition-property': 'opacity, background-color, border-color, border-width',
      'transition-duration': 120,
    },
  },
  { selector: 'node[kind = "tool"]', style: { 'background-color': '#8d7ad0', 'border-color': '#d2c5ff' } },
  { selector: 'node[root = "yes"]', style: { 'background-color': '#d9a441', 'border-color': '#ffe1a0', 'border-width': 3 } },
  { selector: 'node[selectionReason = "direct_match"]', style: { 'border-color': '#b6f0ff', 'border-width': 3 } },
  { selector: 'node[selectionReason = "dependency"]', style: { 'border-style': 'dashed' } },
  {
    selector: 'node.labels-visible, node.selected-node, node.neighbor-node, node.hover-node, node.hover-neighbor, node.edge-endpoint',
    style: { label: 'data(label)' },
  },
  {
    selector: 'node.selected-node',
    style: { 'background-color': '#ffd166', 'border-color': '#fff1bd', 'border-width': 4, 'z-index': 20, opacity: 1 },
  },
  {
    selector: 'node.neighbor-node, node.hover-neighbor, node.edge-endpoint',
    style: { 'background-color': '#8db8ff', 'border-color': '#d8e6ff', 'border-width': 2, 'z-index': 12, opacity: 1 },
  },
  {
    selector: 'node.hover-node',
    style: { 'background-color': '#b8ccff', 'border-color': '#ffffff', 'border-width': 3, 'z-index': 16, opacity: 1 },
  },
  {
    selector: 'edge',
    style: {
      width: 1.5,
      label: '',
      'font-size': 8,
      'text-background-color': '#11151f',
      'text-background-opacity': 0.92,
      'text-background-padding': '3px',
      color: '#e5edff',
      'curve-style': 'bezier',
      'target-arrow-fill': 'filled',
      'arrow-scale': 0.72,
      opacity: 0.78,
      'line-color': '#70809e',
      'transition-property': 'opacity, width, line-color',
      'transition-duration': 120,
    },
  },
  ...RELATIONS.map((relation) => ({
    selector: `edge[relation = "${relation}"]`,
    style: {
      width: relationStyle[relation].width ?? 1.5,
      'line-style': relationStyle[relation].line,
      'line-color': relationStyle[relation].color,
      'target-arrow-color': relationStyle[relation].color,
      'target-arrow-shape': relationStyle[relation].arrow,
    },
  } as StylesheetJson[number])),
  { selector: 'edge[proposed = "yes"]', style: { 'line-style': 'dotted', opacity: 0.72, 'target-arrow-fill': 'hollow', 'line-dash-pattern': [2, 6], width: 1.8 } },
  { selector: 'edge[proposed = "yes"][confidenceBand = "high"]', style: { opacity: 0.92, width: 2.4 } },
  { selector: 'edge[proposed = "yes"][confidenceBand = "low"]', style: { opacity: 0.42, width: 1.2 } },
  {
    selector: 'edge.focused-edge, edge.hover-edge, edge.selected-edge',
    style: { opacity: 1, width: 4, 'z-index': 18 },
  },
  {
    selector: 'edge.hover-edge, edge.selected-edge',
    style: { label: 'data(label)', 'font-weight': 700 },
  },
  { selector: '.dimmed', style: { opacity: 0.14, 'text-opacity': 0 } },
];
