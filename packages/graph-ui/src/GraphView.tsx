import { useEffect, useRef, useState } from 'react';
import cytoscape, { type Core, type EdgeSingular, type EventObject, type LayoutOptions, type NodeSingular } from 'cytoscape';
import fcose from 'cytoscape-fcose';
import { edgeId, graphElements, graphStyles, proposalEdgeId } from './graph-model';
import type { GraphData, GraphEdge, GraphNode, ProposalRenderEdge } from './types';

type Layout = 'force' | 'hierarchical' | 'grouped' | 'radial';
type Tooltip = { text: string; x: number; y: number };
type Focus = { kind: 'node' | 'edge'; id: string } | undefined;

cytoscape.use(fcose);

declare global {
  interface Window {
    __GRAPH_CY__?: Core;
  }
}

export type GraphDebugSnapshot = {
  receivedNodes: number;
  receivedEdges: number;
  cytoscapeNodes: number;
  cytoscapeEdges: number;
  selected?: string;
  neighbors: string[];
};

const focusClasses = [
  'dimmed',
  'selected-node',
  'neighbor-node',
  'focused-edge',
  'selected-edge',
  'edge-endpoint',
  'hover-node',
  'hover-neighbor',
  'hover-edge',
].join(' ');
export function graphDebugSnapshot(cy: Core, graph: GraphData, focus: Focus): GraphDebugSnapshot {
  const focusedNode = focus?.kind === 'node' ? cy.$id(focus.id) : undefined;
  const focusedEdge = focus?.kind === 'edge' ? cy.$id(focus.id) : undefined;
  return {
    receivedNodes: graph.nodes.length,
    receivedEdges: graph.edges.length,
    cytoscapeNodes: cy.nodes().length,
    cytoscapeEdges: cy.edges().length,
    selected: focus?.id,
    neighbors: focusedNode?.neighborhood('node').map((node) => node.id())
      ?? (focusedEdge?.isEdge() ? [focusedEdge.source().id(), focusedEdge.target().id()] : []),
  };
}

export function clearGraphFocus(cy: Core): void {
  cy.elements().removeClass(focusClasses);
}

export function applyNodeFocus(cy: Core, nodeId: string, hover = false): string[] {
  clearGraphFocus(cy);
  const node = cy.$id(nodeId);
  if (!node.isNode()) return [];
  const neighbors = node.neighborhood('node');
  const edges = node.connectedEdges();
  cy.elements().addClass('dimmed');
  node.removeClass('dimmed').addClass(hover ? 'hover-node' : 'selected-node');
  neighbors.removeClass('dimmed').addClass(hover ? 'hover-neighbor' : 'neighbor-node');
  edges.removeClass('dimmed').addClass(hover ? 'hover-edge' : 'focused-edge');
  return neighbors.map((neighbor) => neighbor.id());
}

export function applyEdgeFocus(cy: Core, edgeIdValue: string, hover = false): string[] {
  clearGraphFocus(cy);
  const edge = cy.$id(edgeIdValue);
  if (!edge.isEdge()) return [];
  const endpoints = edge.connectedNodes();
  cy.elements().addClass('dimmed');
  edge.removeClass('dimmed').addClass(hover ? 'hover-edge' : 'selected-edge');
  endpoints.removeClass('dimmed').addClass('edge-endpoint');
  return endpoints.map((node) => node.id());
}

export function layoutOptions(layout: Layout): LayoutOptions {
  if (layout === 'hierarchical') {
    return { name: 'breadthfirst', directed: true, fit: true, padding: 70, spacingFactor: 1.35, animate: true, animationDuration: 450 };
  }
  if (layout === 'radial') {
    return { name: 'circle', fit: true, padding: 70, avoidOverlap: true, spacingFactor: 1.1, animate: true, animationDuration: 450 };
  }
  if (layout === 'grouped') {
    return { name: 'concentric', fit: true, padding: 70, avoidOverlap: true, minNodeSpacing: 42, animate: true, animationDuration: 450 };
  }
  return {
    name: 'fcose',
    quality: 'default',
    fit: true,
    padding: 85,
    randomize: true,
    animate: true,
    animationDuration: 850,
    avoidOverlap: true,
    nodeDimensionsIncludeLabels: true,
    nodeRepulsion: 8000,
    idealEdgeLength: 210,
    edgeElasticity: 0.45,
    nestingFactor: 0.1,
    gravity: 0.32,
    gravityRange: 4.2,
    numIter: 2500,
    tile: false,
  } as unknown as LayoutOptions;
}

export function materializeGraph(graph: GraphData, proposals: ProposalRenderEdge[] = [], container?: HTMLDivElement): Core {
  return cytoscape({
    ...(container ? { container } : { headless: true }),
    elements: graphElements(graph, proposals),
    style: graphStyles,
    minZoom: 0.08,
    maxZoom: 4,
    boxSelectionEnabled: false,
  });
}

function restoreFocus(cy: Core, focus: Focus): string[] {
  if (!focus) {
    clearGraphFocus(cy);
    return [];
  }
  return focus.kind === 'node' ? applyNodeFocus(cy, focus.id) : applyEdgeFocus(cy, focus.id);
}

export function GraphView({
  graph,
  layout,
  rootSkillId,
  onNode,
  onEdge,
  onClear,
  onDebug,
  command,
  proposals = [],
}: {
  graph: GraphData;
  proposals?: ProposalRenderEdge[];
  layout: Layout;
  rootSkillId?: string;
  onNode: (node: GraphNode) => void;
  onEdge: (edge: GraphEdge, proposal?: ProposalRenderEdge) => void;
  onClear?: () => void;
  onDebug?: (snapshot: GraphDebugSnapshot) => void;
  command?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | undefined>(undefined);
  const focusRef = useRef<Focus>(undefined);
  const [tooltip, setTooltip] = useState<Tooltip>();

  useEffect(() => {
    if (!ref.current) return;
    const cy = materializeGraph(graph, proposals, ref.current);
    cyRef.current = cy;
    if (import.meta.env.DEV) window.__GRAPH_CY__ = cy;
    focusRef.current = undefined;
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    const edgeById = new Map(graph.edges.map((edge) => [edgeId(edge), edge]));
    const proposalByEdgeId = new Map(proposals.map((proposal) => [proposalEdgeId(proposal), proposal]));

    const report = () => onDebug?.(graphDebugSnapshot(cy, graph, focusRef.current));
    const initialRoot = rootSkillId
      ? cy.nodes().filter((node) => node.data('skillId') === rootSkillId).first()
      : cy.nodes('.root').first();
    if (initialRoot.isNode()) {
      focusRef.current = { kind: 'node', id: initialRoot.id() };
      applyNodeFocus(cy, initialRoot.id());
    }
    const updateLabelDensity = () => cy.nodes().toggleClass('labels-visible', cy.zoom() >= 0.82);
    const runLayout = cy.layout(layoutOptions(layout));
    runLayout.on('layoutstop', () => {
      updateLabelDensity();
      report();
    });
    runLayout.run();
    updateLabelDensity();
    report();

    cy.on('zoom', updateLabelDensity);
    cy.on('tap', 'node', (event: EventObject) => {
      const target = event.target as NodeSingular;
      focusRef.current = { kind: 'node', id: target.id() };
      applyNodeFocus(cy, target.id());
      report();
      const node = nodeById.get(target.id());
      if (node) onNode(node);
    });
    cy.on('tap', 'edge', (event: EventObject) => {
      const target = event.target as EdgeSingular;
      focusRef.current = { kind: 'edge', id: target.id() };
      applyEdgeFocus(cy, target.id());
      report();
      const edge = edgeById.get(target.id());
      const proposal = proposalByEdgeId.get(target.id());
      if (edge || proposal) onEdge(edge ?? { source: target.data('sourceSkillId'), sourceVersion: 0, type: target.data('relation'), target: target.data('targetSkillId'), targetVersion: 0, constraint: null, direction: 'outgoing' }, proposal);
    });
    cy.on('tap', (event: EventObject) => {
      if (event.target !== cy) return;
      focusRef.current = undefined;
      clearGraphFocus(cy);
      report();
      onClear?.();
    });
    cy.on('mouseover', 'node', (event: EventObject) => {
      const target = event.target as NodeSingular;
      if (!focusRef.current) applyNodeFocus(cy, target.id(), true);
      setTooltip({
        text: `${String(target.data('label'))} · ${target.degree()} relation${target.degree() === 1 ? '' : 's'}`,
        x: event.renderedPosition.x,
        y: event.renderedPosition.y,
      });
    });
    cy.on('mouseout', 'node', () => {
      restoreFocus(cy, focusRef.current);
      setTooltip(undefined);
    });
    cy.on('mouseover', 'edge', (event: EventObject) => {
      const target = event.target as EdgeSingular;
      if (!focusRef.current) applyEdgeFocus(cy, target.id(), true);
      setTooltip({ text: target.data('proposed') === 'yes' ? `${String(target.data('relation'))}? · confidence ${Number(target.data('confidence')).toFixed(2)} · ${String(target.data('detector'))} · ${String(target.data('status'))}` : String(target.data('label')), x: event.renderedPosition.x, y: event.renderedPosition.y });
    });
    cy.on('mouseout', 'edge', () => {
      restoreFocus(cy, focusRef.current);
      setTooltip(undefined);
    });

    return () => {
      cy.destroy();
      if (window.__GRAPH_CY__ === cy) delete window.__GRAPH_CY__;
      if (cyRef.current === cy) cyRef.current = undefined;
    };
  }, [graph, layout, onClear, onDebug, onEdge, onNode, proposals, rootSkillId]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !command) return;
    const [action, id] = command.split(':');
    if (action === 'fit') {
      cy.animate({ fit: { eles: cy.elements(), padding: 80 } }, { duration: 350 });
      return;
    }
    if (action === 'clear') {
      focusRef.current = undefined;
      clearGraphFocus(cy);
      onDebug?.({
        receivedNodes: graph.nodes.length,
        receivedEdges: graph.edges.length,
        cytoscapeNodes: cy.nodes().length,
        cytoscapeEdges: cy.edges().length,
        neighbors: [],
      });
      return;
    }
    if (!id) return;
    const node = cy.$id(id);
    if (!node.isNode()) return;
    if (action === 'select') {
      focusRef.current = { kind: 'node', id };
      const neighbors = applyNodeFocus(cy, id);
      onDebug?.({
        receivedNodes: graph.nodes.length,
        receivedEdges: graph.edges.length,
        cytoscapeNodes: cy.nodes().length,
        cytoscapeEdges: cy.edges().length,
        selected: id,
        neighbors,
      });
    }
    cy.animate({ center: { eles: node }, zoom: 1.15 }, { duration: 380 });
  }, [command, graph.edges.length, graph.nodes.length, onDebug]);

  return (
    <div className="cy-wrap">
      <div ref={ref} className="cy-canvas" aria-label="Interactive skill graph" />
      {tooltip && <div className="graph-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>{tooltip.text}</div>}
    </div>
  );
}
