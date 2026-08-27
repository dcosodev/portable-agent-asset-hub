import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { filterGraph, filterProposals, RELATIONS } from './graph-model';
import { GraphView } from './GraphView';
import type { GraphDebugSnapshot } from './GraphView';
import { MarkdownViewer } from './MarkdownViewer';
import { RelationProposalApplyPreview } from './RelationProposalApplyPreview';
import { RelationProposalInspector } from './RelationProposalInspector';
import { RelationProposalQueue } from './RelationProposalQueue';
import { ManualRelationDialog } from './ManualRelationDialog';
import { ExplicitRelationQueue } from './ExplicitRelationQueue';
import type { Filters, GraphData, GraphEdge, GraphNode, RelationProposal, ProposalRenderEdge, RelationType, ResourceMeta, RetrievalSummary, SearchHit, SkillDetail } from './types';

const empty: GraphData = { nodes: [], edges: [], metadata: { nodes: 0, edges: 0, truncated: false, truncatedNodes: 0, truncatedEdges: 0, limits: { maxDepth: 4, maxNodes: 200, maxEdges: 1000 }, generatedAt: '', includeHistory: false } };
type View = 'global' | 'skill' | 'retrieval';
type Inspector = { kind: 'node'; node: GraphNode } | { kind: 'edge'; edge: GraphEdge; proposal?: RelationProposal } | { kind: 'retrieval'; metadata: Record<string, unknown> } | null;

function pathState(): { view: View; id?: string; proposalId?: string } {
  const proposal = location.pathname.match(/^\/proposals\/([^/]+)$/u);
  if (proposal) return { view: 'global', proposalId: decodeURIComponent(proposal[1]!) };
  const skill = location.pathname.match(/^\/skills\/([^/]+)$/u);
  if (skill) return { view: 'skill', id: decodeURIComponent(skill[1]!) };
  if (location.pathname === '/skills') return { view: 'skill' };
  const retrieval = location.pathname.match(/^\/retrievals\/([^/]+)$/u);
  if (retrieval) return { view: 'retrieval', id: decodeURIComponent(retrieval[1]!) };
  if (location.pathname === '/retrievals') return { view: 'retrieval' };
  return { view: 'global' };
}
function navigate(path: string) { history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }
function hasCapability(health: Record<string, unknown>, capability: string): boolean { return JSON.stringify(health).includes(capability); }
function toRenderEdge(proposal: RelationProposal): ProposalRenderEdge { return { proposalId: proposal.id, sourceSkillId: proposal.sourceSkillId, sourceVersion: proposal.sourceVersion, targetSkillId: proposal.targetSkillId, targetVersion: proposal.targetVersionSnapshot, relationType: proposal.relationType, targetVersionConstraint: proposal.targetVersionConstraint, confidence: proposal.confidence, detector: proposal.detector, status: proposal.status }; }

export function App() {
  const initial = pathState();
  const [view, setView] = useState<View>(initial.view);
  const [graph, setGraph] = useState<GraphData>(empty);
  const [selectedId, setSelectedId] = useState<string | undefined>(initial.id);
  const [inspector, setInspector] = useState<Inspector>(null);
  const [proposalInspector, setProposalInspector] = useState<RelationProposal>();
  const [manualSource, setManualSource] = useState<string>();
  const [proposals, setProposals] = useState<RelationProposal[]>([]);
  const [layout, setLayout] = useState<'force' | 'hierarchical' | 'grouped' | 'radial'>('force');
  const [mode, setMode] = useState('both');
  const [depth, setDepth] = useState(3);
  const [versions, setVersions] = useState('heads');
  const [theme, setTheme] = useState<'system' | 'dark' | 'light'>('system');
  const [filters, setFilters] = useState<Filters>({ relations: new Set(RELATIONS), lifecycle: 'all', query: '', owner: '', scope: '', tag: '', profile: '', kind: 'all', proposalLayer: 'both', proposalStatuses: new Set(['proposed']), proposalMinConfidence: 0, proposalDetectors: new Set(), proposalDomain: 'both' });
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<SearchHit[]>([]);
  const [retrievals, setRetrievals] = useState<RetrievalSummary[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [command, setCommand] = useState('');
  const [health, setHealth] = useState<Record<string, unknown>>({});
  const [skill, setSkill] = useState<SkillDetail>();
  const [resources, setResources] = useState<ResourceMeta[]>([]);
  const [preview, setPreview] = useState<{ title: string; content: string }>();
  const [applyPreview, setApplyPreview] = useState<{ proposalIds: string[]; data: { changes: Array<Record<string, unknown>>; planDigest: string; validation?: Record<string, unknown> } }>();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [debug, setDebug] = useState<GraphDebugSnapshot>();
  const debugEnabled = import.meta.env.DEV;
  const canRead = hasCapability(health, 'skill.relation.proposal.read');
  const canReview = hasCapability(health, 'skill.relation.proposal.review');
  const canApply = hasCapability(health, 'skill.relation.proposal.apply');

  const loadProposals = useCallback(async () => {
    if (!api.proposals) return;
    try { const result = await api.proposals(); setProposals(result.items); const deep = pathState().proposalId; if (deep) { const found = result.items.find((item) => item.id === deep); if (found) setProposalInspector(found); } } catch (e) { if (canRead) setError(e instanceof Error ? e.message : 'Unable to load proposals'); }
  }, [canRead]);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      if (view === 'global') setGraph(await api.globalGraph(versions));
      else if (view === 'skill' && selectedId) {
        const data = await api.skillGraph(selectedId, mode, depth, versions); setGraph(data);
        const root = data.nodes.find((node) => node.skillId === selectedId);
        if (root) { setInspector({ kind: 'node', node: root }); setCommand(`select:${root.id}:${Date.now()}`); const [detail, res] = await Promise.all([api.skill(root.skillId), api.resources(root.skillId)]); setSkill(detail); setResources(res.items); }
      } else if (view === 'retrieval') {
        const list = await api.retrievals(); setRetrievals(list.items);
        if (selectedId) { const data = await api.retrievalGraph(selectedId); setGraph(data); setInspector({ kind: 'retrieval', metadata: data.metadata as unknown as Record<string, unknown> }); }
      }
      await loadProposals();
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to load graph'); } finally { setLoading(false); }
  }, [view, selectedId, mode, depth, versions, loadProposals]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { Promise.all([api.status(), api.capabilities()]).then(([status, capabilities]) => setHealth({ status, capabilities })).catch(() => setHealth({ status: 'offline' })); }, []);
  useEffect(() => { const handler = () => { const next = pathState(); setView(next.view); setSelectedId(next.id); if (next.proposalId) { const found = proposals.find((item) => item.id === next.proposalId); if (found) setProposalInspector(found); } }; addEventListener('popstate', handler); return () => removeEventListener('popstate', handler); }, [proposals]);
  useEffect(() => { if (search.trim().length < 2) { setResults([]); return; } const timer = setTimeout(() => { api.search(search).then((data) => setResults(data.items)).catch(() => setResults([])); }, 220); return () => clearTimeout(timer); }, [search]);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);

  const visible = useMemo(() => filterGraph(graph, filters), [graph, filters]);
  const canvasGraph = useMemo(() => filters.proposalLayer === 'proposed' ? { ...visible, edges: [], metadata: { ...visible.metadata, edges: 0 } } : visible, [filters.proposalLayer, visible]);
  const visibleProposals = useMemo(() => filterProposals(proposals, filters), [proposals, filters]);
  const renderProposals = useMemo(() => filters.proposalLayer === 'canonical' ? [] : visibleProposals.map(toRenderEdge), [filters.proposalLayer, visibleProposals]);
  const runtimeStatus = (health.status && typeof health.status === 'object' ? health.status : {}) as Record<string, unknown>;
  const runtimeCapabilities = (health.capabilities && typeof health.capabilities === 'object' ? health.capabilities : {}) as Record<string, unknown>;
  const capabilityAuth = (runtimeCapabilities.auth && typeof runtimeCapabilities.auth === 'object' ? runtimeCapabilities.auth : {}) as Record<string, unknown>;
  const runtimeStorage = (runtimeCapabilities.storage && typeof runtimeCapabilities.storage === 'object' ? runtimeCapabilities.storage : runtimeStatus.storage && typeof runtimeStatus.storage === 'object' ? runtimeStatus.storage : {}) as Record<string, unknown>;
  const selectNode = useCallback((node: GraphNode) => { setInspector({ kind: 'node', node }); setCommand(`center:${node.id}`); Promise.all([api.skill(node.skillId), api.resources(node.skillId)]).then(([detail, res]) => { setSkill(detail); setResources(res.items); }).catch((e) => setError(e instanceof Error ? e.message : 'Inspector unavailable')); }, []);
  const selectEdge = useCallback((edge: GraphEdge, renderProposal?: ProposalRenderEdge) => { const proposal = renderProposal ? proposals.find((item) => item.id === renderProposal.proposalId) : undefined; if (proposal) { setProposalInspector(proposal); navigate(`/proposals/${encodeURIComponent(proposal.id)}`); } else setInspector({ kind: 'edge', edge }); }, [proposals]);
  const clearSelection = useCallback(() => { setInspector(null); setProposalInspector(undefined); setSkill(undefined); setResources([]); setCommand(`clear:${Date.now()}`); }, []);
  function switchView(next: View) { setView(next); setInspector(null); setSelectedId(undefined); navigate(next === 'global' ? '/' : next === 'retrieval' ? '/retrievals' : '/skills'); }
  function focusSkill(id: string) { setResults([]); setSearch(''); setSelectedId(id); setView('skill'); navigate(`/skills/${encodeURIComponent(id)}`); }
  function toggleRelation(relation: RelationType) { setFilters((current) => { const relations = new Set(current.relations); if (relations.has(relation)) relations.delete(relation); else relations.add(relation); return { ...current, relations }; }); }
  async function review(ids: string[], status: 'approved' | 'rejected', reason?: string, changes?: { relationType?: string; reverseDirection?: boolean; constraint?: string | null }) { try { const safeIds = !changes && status === 'approved' ? ids.filter((id) => !proposals.find((proposal) => proposal.id === id)?.reviewModified) : ids; for (const id of safeIds) await api.reviewProposal(id, status, reason, changes); await loadProposals(); } catch (e) { setError(e instanceof Error ? e.message : 'Unable to review proposal'); } }
  async function createManual(input: { sourceSkillId: string; targetSkillId: string; relationType: RelationType; constraint: string | null }) { try { const created = await api.createManualProposal(input); setManualSource(undefined); await Promise.all([load(), loadProposals()]); setProposalInspector(created); navigate(`/proposals/${encodeURIComponent(created.id)}`); } catch (e) { setError(e instanceof Error ? e.message : 'Unable to create relation proposal'); } }
  async function discover(skillId: string) { try { const result = await api.discover(skillId); setError(`Discovery: ${result.candidatePairs} candidates · ${result.proposalsCreated} proposals · high ${result.highConfidence} · medium ${result.mediumConfidence} · operational ${result.operational} · semantic ${result.semantic}`); await loadProposals(); } catch (e) { setError(e instanceof Error ? e.message : 'Unable to discover relations'); } }
  async function generatePreview(ids: string[]) { try { setApplyPreview({ proposalIds: ids, data: await api.previewApply(ids) }); } catch (e) { setError(e instanceof Error ? e.message : 'Unable to generate apply preview'); } }
  async function applyReviewedPlan() { if (!applyPreview) return; try { await api.apply(applyPreview.proposalIds, applyPreview.data.planDigest); setApplyPreview(undefined); await Promise.all([load(), loadProposals()]); } catch (e) { setError(e instanceof Error ? e.message : 'Unable to apply reviewed plan'); } }
  async function openBody() { if (skill) setPreview({ title: `${skill.name} · SKILL.md`, content: skill.body ?? '' }); }
  async function openResource(resource: ResourceMeta) { if (!skill) return; if (resource.size > 262144 || !(resource.mime.startsWith('text/') || ['application/json', 'application/markdown'].includes(resource.mime))) { setError('Binary or oversized resources are metadata-only in the explorer.'); return; } try { const data = await api.resource(skill.id, resource.relativePath); let content = data.content ?? ''; const encoded = (data as unknown as { bytesBase64?: string }).bytesBase64 ?? data.bytes; if (!content && encoded) content = atob(encoded); setPreview({ title: resource.relativePath, content }); } catch (e) { setError(e instanceof Error ? e.message : 'Resource unavailable'); } }

  const selectedProposal = proposalInspector;
  const stats = { canonicalConnected: new Set(graph.edges.flatMap((edge) => [edge.source, edge.target])).size, isolated: graph.nodes.filter((node) => !graph.edges.some((edge) => edge.source === node.id || edge.target === node.id)).length, high: proposals.filter((item) => item.confidence >= 0.85).length, medium: proposals.filter((item) => item.confidence >= 0.6 && item.confidence < 0.85).length, operational: proposals.filter((item) => item.relationType !== 'related_to').length, semantic: proposals.filter((item) => item.relationType === 'related_to').length };
  return <main className="app-shell">
    <header><div className="brand"><span className="brand-mark">PA</span><strong>Graph Explorer</strong></div><nav aria-label="Explorer views">{(['global', 'skill', 'retrieval'] as View[]).map((item) => <button key={item} className={view === item ? 'active' : ''} onClick={() => switchView(item)}>{item === 'global' ? 'Global Graph' : item === 'skill' ? 'Skill Graph' : 'Retrieval Explorer'}</button>)}</nav><button className="panel-toggle" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((open) => !open)}>Filters</button><div className="search-wrap"><input aria-label="Search skills" placeholder="Search skills…" value={search} onChange={(e) => setSearch(e.target.value)} />{results.length > 0 && <ul className="search-results">{results.map((result) => <li key={result.id}><button onClick={() => focusSkill(result.id)}>{result.name}<small>{result.summary}</small></button></li>)}</ul>}</div><button onClick={() => void load()}>Refresh</button><select aria-label="Theme" value={theme} onChange={(e) => setTheme(e.target.value as typeof theme)}><option value="system">System</option><option value="dark">Dark</option><option value="light">Light</option></select></header>
    <section className={`workspace ${filtersOpen ? 'filters-open' : ''} ${inspector || selectedProposal ? 'inspector-open' : ''}`}>
      <aside className={`left-panel ${filtersOpen ? 'open' : ''}`}><h2>{view === 'retrieval' ? 'Retrievals' : 'Filters'}</h2>{view === 'retrieval' ? <ul className="retrieval-list">{retrievals.map((item) => <li key={item.requestId}><button onClick={() => { setSelectedId(item.requestId); navigate(`/retrievals/${encodeURIComponent(item.requestId)}`); }}><span>{item.redactedQuery ?? item.requestId}</span><small>{item.classification.primary} · {item.counts.selectedSkills} skills</small></button></li>)}</ul> : <>
        <label>Layout<select value={layout} onChange={(e) => setLayout(e.target.value as typeof layout)}><option value="force">Force-directed</option><option value="hierarchical">Hierarchical</option><option value="grouped">Grouped</option><option value="radial">Radial</option></select></label>
        {view === 'skill' && <><label>Direction<select aria-label="Direction" value={mode} onChange={(e) => setMode(e.target.value)}><option value="dependencies">Dependencies</option><option value="dependents">Dependents</option><option value="both">Both</option></select></label><label>Depth<input aria-label="Depth" type="number" min="1" max="32" value={depth} onChange={(e) => setDepth(Number(e.target.value))} /></label></>}
        <label>Versions<select aria-label="Versions" value={versions} onChange={(e) => setVersions(e.target.value)}><option value="heads">HEAD only</option><option value="history">Show versions</option></select></label><label>Node type<select aria-label="Node type" value={filters.kind} onChange={(e) => setFilters({ ...filters, kind: e.target.value as Filters['kind'] })}><option value="all">All types</option><option value="skill">Skills</option><option value="tool">Tools</option></select></label><label>Lifecycle<select aria-label="Lifecycle" value={filters.lifecycle} onChange={(e) => setFilters({ ...filters, lifecycle: e.target.value })}><option value="all">All visible</option><option value="active">Published / active</option></select></label><label>Owner<input aria-label="Owner filter" value={filters.owner} onChange={(e) => setFilters({ ...filters, owner: e.target.value })} /></label><label>Scope<input aria-label="Scope filter" value={filters.scope} onChange={(e) => setFilters({ ...filters, scope: e.target.value })} /></label><label>Profile<input aria-label="Profile filter" value={filters.profile} onChange={(e) => setFilters({ ...filters, profile: e.target.value })} /></label><label>Tag<input aria-label="Tag filter" value={filters.tag} onChange={(e) => setFilters({ ...filters, tag: e.target.value })} /></label>
        <label className="check"><input type="checkbox" aria-label="Show isolated skills" checked={filters.isolatedOnly ?? false} onChange={(e) => setFilters({ ...filters, isolatedOnly: e.target.checked })} />Show isolated skills</label><label>Graph layer<select aria-label="Graph layer" value={filters.proposalLayer} onChange={(e) => setFilters({ ...filters, proposalLayer: e.target.value as Filters['proposalLayer'] })}><option value="both">Canonical + Proposed</option><option value="canonical">Canonical only</option><option value="proposed">Proposed only</option></select></label><label>Relation domain<select aria-label="Relation domain" value={filters.proposalDomain} onChange={(e) => setFilters({ ...filters, proposalDomain: e.target.value as Filters['proposalDomain'] })}><option value="both">Operational + Semantic</option><option value="operational">Operational</option><option value="semantic">Semantic</option></select></label><label>Proposal confidence ≥<input aria-label="Proposal confidence threshold" type="number" min="0" max="1" step="0.05" value={filters.proposalMinConfidence} onChange={(e) => setFilters({ ...filters, proposalMinConfidence: Number(e.target.value) })} /></label>
        <fieldset><legend>Proposal statuses</legend>{(['proposed', 'approved', 'rejected', 'stale', 'superseded'] as const).map((status) => <label className="check" key={status}><input type="checkbox" checked={filters.proposalStatuses?.has(status) ?? false} onChange={() => setFilters((current) => { const proposalStatuses = new Set(current.proposalStatuses ?? []); if (proposalStatuses.has(status)) proposalStatuses.delete(status); else proposalStatuses.add(status); return { ...current, proposalStatuses }; })} />{status}</label>)}</fieldset>
        <fieldset><legend>Relations</legend>{RELATIONS.map((relation) => <label className="check" key={relation}><input type="checkbox" checked={filters.relations.has(relation)} onChange={() => toggleRelation(relation)} /><span className={`relation-swatch ${relation}`} />{relation}</label>)}</fieldset>
      </>}</aside>
      <RelationProposalQueue items={proposals} selectedId={selectedProposal?.id} onSelect={(proposal) => { setProposalInspector(proposal); navigate(`/proposals/${encodeURIComponent(proposal.id)}`); }} onReview={(ids, status, reason) => void review(ids, status, reason)} onPreview={(ids) => void generatePreview(ids)} canReview={canReview} canApply={canApply} />
      <ExplicitRelationQueue canStage={canReview} onError={setError} />
      <section className="graph-panel">{loading && <div className="overlay">Loading graph…</div>}{error && <div role="alert" className="error">{error}<button onClick={() => setError('')}>×</button></div>}{graph.metadata.truncated && <div className="truncated">Graph limited to {graph.metadata.nodes} nodes / {graph.metadata.edges} edges. Narrow filters or choose a root.</div>}<div className="graph-actions"><button onClick={() => setCommand(`fit:${Date.now()}`)}>Fit</button>{inspector?.kind === 'node' && <button onClick={() => setCommand(`center:${inspector.node.id}:${Date.now()}`)}>Center selected</button>}{(inspector || selectedProposal) && <button onClick={clearSelection}>Clear selection</button>}{view === 'skill' && selectedId && <button onClick={() => void discover(selectedId)}>Discover relations</button>}</div><GraphView graph={canvasGraph} proposals={renderProposals} layout={layout} rootSkillId={view === 'skill' ? selectedId : undefined} onNode={selectNode} onEdge={selectEdge} onClear={clearSelection} onDebug={debugEnabled ? setDebug : undefined} command={command} />{debugEnabled && debug && <aside className="debug-overlay" aria-label="Graph debug"><strong>Graph debug</strong><span>Nodes received: {debug.receivedNodes}</span><span>Edges received: {debug.receivedEdges}</span><span>Cytoscape nodes: {debug.cytoscapeNodes}</span><span>Cytoscape edges: {debug.cytoscapeEdges}</span></aside>}<div className="graph-count">{visible.nodes.length} nodes · {visible.edges.length} canonical edges · {renderProposals.length} proposed edges</div></section>
      <aside className={`inspector ${inspector || selectedProposal ? 'open' : ''}`}><div className="inspector-heading"><h2>Inspector</h2>{(inspector || selectedProposal) && <button onClick={clearSelection}>Clear selection</button>}</div>{!inspector && !selectedProposal && <p>Select a node or edge.</p>}{selectedProposal && <RelationProposalInspector proposal={selectedProposal} canReview={canReview} canApply={canApply} onReview={(status, reason, changes) => void review([selectedProposal.id], status, reason, changes)} onPreview={() => void generatePreview([selectedProposal.id])} onDiscover={() => void discover(selectedProposal.sourceSkillId)} />}{inspector?.kind === 'node' && <><dl><dt>Name</dt><dd>{inspector.node.name}</dd><dt>Skill ID</dt><dd>{inspector.node.skillId}</dd><dt>Version</dt><dd>v{inspector.node.version}</dd><dt>Lifecycle</dt><dd>{inspector.node.lifecycle}</dd><dt>Canonical neighbors</dt><dd>{graph.edges.filter((edge) => edge.source === inspector.node.id || edge.target === inspector.node.id).length}</dd><dt>Proposed neighbors</dt><dd>{proposals.filter((item) => item.sourceSkillId === inspector.node.skillId || item.targetSkillId === inspector.node.skillId).length}</dd></dl><div className="inspector-actions"><button onClick={() => void openBody()}>View SKILL.md</button><button onClick={() => focusSkill(inspector.node.skillId)}>Expand neighbors</button><button onClick={() => setManualSource(inspector.node.skillId)}>Add relation</button><button onClick={() => void discover(inspector.node.skillId)}>Discover relations</button></div><h3>Resources</h3><ul className="resources">{resources.map((resource) => <li key={resource.relativePath}><button onClick={() => void openResource(resource)}>{resource.relativePath}</button><small>{resource.mime} · {resource.size} B</small></li>)}</ul></>}{inspector?.kind === 'edge' && <dl><dt>Canonical relation</dt><dd>{inspector.edge.type}</dd><dt>Source</dt><dd>{inspector.edge.source}@{inspector.edge.sourceVersion}</dd><dt>Target</dt><dd>{inspector.edge.target}@{inspector.edge.targetVersion}</dd><dt>Constraint</dt><dd>{inspector.edge.constraint ?? 'snapshot HEAD'}</dd></dl>}{inspector?.kind === 'retrieval' && <pre className="metadata">{JSON.stringify(inspector.metadata, null, 2)}</pre>}</aside>
    </section><footer><span className={health.status === 'offline' ? 'offline' : 'online'} />REST {health.status === 'offline' ? 'offline' : 'connected'} · {runtimeStorage.mode === 'temporary' ? 'TEMPORARY DATABASE · Canonical apply disabled' : `DB ${String(runtimeStorage.mode ?? 'unknown')}`} · schema {String(runtimeCapabilities.schemaVersion ?? runtimeStatus.schemaVersion ?? 'unknown')} · auth {String(runtimeStatus.authMode ?? capabilityAuth.mode ?? 'unknown')} · {graph.metadata.nodes} skills · canonical {graph.edges.length} · proposed {proposals.length} · high {stats.high} · medium {stats.medium} · operational {stats.operational} · semantic {stats.semantic} · isolated {stats.isolated}</footer>{preview && <div className="modal" role="dialog" aria-modal="true" aria-label={preview.title}><div className="modal-card"><header><h2>{preview.title}</h2><button onClick={() => setPreview(undefined)}>Close</button></header><MarkdownViewer content={preview.content} /></div></div>}{manualSource && <ManualRelationDialog sourceSkillId={manualSource} searchSkills={(query) => api.search(query).then((result) => result.items)} onCreate={createManual} onClose={() => setManualSource(undefined)} />}{applyPreview && <RelationProposalApplyPreview data={applyPreview.data} onClose={() => setApplyPreview(undefined)} onApply={() => void applyReviewedPlan()} />}</main>;
}
