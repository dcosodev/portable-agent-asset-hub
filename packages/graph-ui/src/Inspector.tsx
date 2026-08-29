import { RelationProposalInspector } from './RelationProposalInspector';
import { SkillReader } from './SkillReader';
import type { Inspector as InspectorState } from './state/useExplorerState';
import type { GraphData, GraphEdge, GraphNode, RelationProposal, ResourceMeta, SkillDetail } from './types';

type Props = {
  open: boolean;
  inspector: InspectorState;
  selectedProposal?: RelationProposal;
  clearSelection: () => void;
  // node inspector dependencies
  graph: GraphData;
  proposals: RelationProposal[];
  skill?: SkillDetail;
  resources: ResourceMeta[];
  onOpenBody: () => void;
  onExpandNeighbors: (skillId: string) => void;
  onAddRelation: (skillId: string) => void;
  onDiscover: (skillId: string) => void;
  onOpenResource: (resource: ResourceMeta) => void;
  // proposal inspector dependencies
  canReview: boolean;
  canApply: boolean;
  onReviewProposal: (status: 'approved' | 'rejected', reason?: string, changes?: { relationType?: string; reverseDirection?: boolean; constraint?: string | null }) => void;
  onPreviewProposal: () => void;
  onDiscoverProposal: (skillId: string) => void;
};

/**
 * Inspector — W0 refactor of the `<aside className="inspector">` that was
 * previously the last child of the workspace. It mirrors the original three
 * rendering branches (selectedProposal, inspector.node, inspector.edge,
 * inspector.retrieval, none). The DLs, action buttons, resource list and
 * the empty-state copy are preserved exactly so App.test.tsx keeps finding
 * "View SKILL.md", "Clear selection", and the rendered counts.
 */
export function Inspector(props: Props) {
  const { open, inspector, selectedProposal, clearSelection } = props;
  const className = `inspector ${open ? 'open' : ''}`;
  return (
    <aside className={className}>
      <div className="inspector-heading">
        <h2>Inspector</h2>
        {open && <button onClick={clearSelection}>Clear selection</button>}
      </div>
      {!inspector && !selectedProposal && <p>Select a node or edge.</p>}
      {selectedProposal && (
        <RelationProposalInspector
          proposal={selectedProposal}
          canReview={props.canReview}
          canApply={props.canApply}
          onReview={(status, reason, changes) => props.onReviewProposal(status, reason, changes)}
          onPreview={props.onPreviewProposal}
          onDiscover={() => props.onDiscoverProposal(selectedProposal.sourceSkillId)}
        />
      )}
      {inspector?.kind === 'node' && (
        <NodeInspectorBody
          node={inspector.node}
          skill={props.skill}
          graph={props.graph}
          proposals={props.proposals}
          resources={props.resources}
          onOpenBody={props.onOpenBody}
          onExpandNeighbors={props.onExpandNeighbors}
          onAddRelation={props.onAddRelation}
          onDiscover={props.onDiscover}
          onOpenResource={props.onOpenResource}
        />
      )}
      {inspector?.kind === 'edge' && <EdgeInspectorBody edge={inspector.edge} />}
      {inspector?.kind === 'retrieval' && (
        <pre className="metadata">{JSON.stringify(inspector.metadata, null, 2)}</pre>
      )}
    </aside>
  );
}

function NodeInspectorBody({
  node,
  skill,
  graph,
  proposals,
  resources,
  onOpenBody,
  onExpandNeighbors,
  onAddRelation,
  onDiscover,
  onOpenResource,
}: {
  node: GraphNode;
  skill?: SkillDetail;
  graph: GraphData;
  proposals: RelationProposal[];
  resources: ResourceMeta[];
  onOpenBody: () => void;
  onExpandNeighbors: (skillId: string) => void;
  onAddRelation: (skillId: string) => void;
  onDiscover: (skillId: string) => void;
  onOpenResource: (resource: ResourceMeta) => void;
}) {
  const canonicalNeighbors = graph.edges.filter(
    (edge) => edge.source === node.id || edge.target === node.id,
  ).length;
  const proposedNeighbors = proposals.filter(
    (item) => item.sourceSkillId === node.skillId || item.targetSkillId === node.skillId,
  ).length;
  return (
    <>
      <dl>
        <dt>Name</dt>
        <dd>{node.name}</dd>
        <dt>Skill ID</dt>
        <dd>{node.skillId}</dd>
        <dt>Version</dt>
        <dd>v{node.version}</dd>
        <dt>Lifecycle</dt>
        <dd>{node.lifecycle}</dd>
        <dt>Canonical neighbors</dt>
        <dd>{canonicalNeighbors}</dd>
        <dt>Proposed neighbors</dt>
        <dd>{proposedNeighbors}</dd>
      </dl>
      <div className="inspector-actions">
        <button onClick={() => void onOpenBody()}>View SKILL.md</button>
        <button onClick={() => onExpandNeighbors(node.skillId)}>Expand neighbors</button>
        <button onClick={() => onAddRelation(node.skillId)}>Add relation</button>
        <button onClick={() => void onDiscover(node.skillId)}>Discover relations</button>
      </div>
      {skill && <SkillReader skill={skill} resources={resources} onOpenResource={onOpenResource} />}
      <h3>Resources</h3>
      <ul className="resources">
        {resources.map((resource) => (
          <li key={resource.relativePath}>
            <button onClick={() => void onOpenResource(resource)}>{resource.relativePath}</button>
            <small>
              {resource.mime} · {resource.size} B
            </small>
          </li>
        ))}
      </ul>
    </>
  );
}

function EdgeInspectorBody({ edge }: { edge: GraphEdge }) {
  return (
    <dl>
      <dt>Canonical relation</dt>
      <dd>{edge.type}</dd>
      <dt>Source</dt>
      <dd>
        {edge.source}@{edge.sourceVersion}
      </dd>
      <dt>Target</dt>
      <dd>
        {edge.target}@{edge.targetVersion}
      </dd>
      <dt>Constraint</dt>
      <dd>{edge.constraint ?? 'snapshot HEAD'}</dd>
    </dl>
  );
}
