import { GraphView } from './GraphView';
import type { GraphDebugSnapshot } from './GraphView';
import type { GraphData, GraphEdge, GraphNode, ProposalRenderEdge } from './types';

export function GraphCanvas({ graph, proposals, layout, rootSkillId, loading, error, truncated, command, inspector, view, selectedId, debug, debugEnabled, onNode, onEdge, onClear, onDebug, onFit, onCenter, onDiscover, onDismissError }: {
  graph: GraphData;
  proposals: ProposalRenderEdge[];
  layout: 'force' | 'hierarchical' | 'grouped' | 'radial';
  rootSkillId?: string;
  loading: boolean;
  error: string;
  truncated: boolean;
  command: string;
  inspector: { kind: 'node'; node: GraphNode } | null;
  view: 'global' | 'skill' | 'retrieval';
  selectedId?: string;
  debug?: GraphDebugSnapshot;
  debugEnabled: boolean;
  onNode: (node: GraphNode) => void;
  onEdge: (edge: GraphEdge, proposal?: ProposalRenderEdge) => void;
  onClear: () => void;
  onDebug: (snapshot: GraphDebugSnapshot) => void;
  onFit: () => void;
  onCenter: (id: string) => void;
  onDiscover: (id: string) => void;
  onDismissError: () => void;
}) {
  return <section className="graph-panel">
    {loading && <div className="overlay">Loading graph…</div>}
    {error && <div role="alert" className="error">{error}<button onClick={onDismissError}>×</button></div>}
    {truncated && <div className="truncated">Graph limited to {graph.metadata.nodes} nodes / {graph.metadata.edges} edges. Narrow filters or choose a root.</div>}
    <div className="graph-actions">
      <button onClick={onFit}>Fit</button>
      {inspector?.kind === 'node' && <button onClick={() => onCenter(inspector.node.id)}>Center selected</button>}
      {(inspector || selectedId) && <button onClick={onClear}>Clear selection</button>}
      {view === 'skill' && rootSkillId && <button onClick={() => onDiscover(rootSkillId)}>Discover relations</button>}
    </div>
    <GraphView graph={graph} proposals={proposals} layout={layout} rootSkillId={rootSkillId} onNode={onNode} onEdge={onEdge} onClear={onClear} onDebug={debugEnabled ? onDebug : undefined} command={command} />
    {debugEnabled && debug && <aside className="debug-overlay" aria-label="Graph debug"><strong>Graph debug</strong><span>Nodes received: {debug.receivedNodes}</span><span>Edges received: {debug.receivedEdges}</span><span>Cytoscape nodes: {debug.cytoscapeNodes}</span><span>Cytoscape edges: {debug.cytoscapeEdges}</span></aside>}
    <div className="graph-count">{graph.nodes.length} nodes · {graph.edges.length} canonical edges · {proposals.length} proposed edges</div>
  </section>;
}
