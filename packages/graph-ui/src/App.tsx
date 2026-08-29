import { useExplorerState } from './state/useExplorerState';
import { Toolbar } from './Toolbar';
import { FilterPanel } from './FilterPanel';
import { GraphCanvas } from './GraphCanvas';
import { Inspector } from './Inspector';
import { StatusBar } from './StatusBar';
import { RelationProposalQueue } from './RelationProposalQueue';
import { ExplicitRelationQueue } from './ExplicitRelationQueue';
import { ManualRelationDialog } from './ManualRelationDialog';
import { RelationProposalApplyPreview } from './RelationProposalApplyPreview';
import { MarkdownViewer } from './MarkdownViewer';
import { api } from './api';
import './styles.css';

export function App() {
  const s = useExplorerState();
  const { graph, visible, canvasGraph, renderProposals, selectedProposal } = s;
  return <main className="app-shell">
    <Toolbar view={s.view} switchView={s.switchView} search={s.search} setSearch={s.setSearch} results={s.results} focusSkill={s.focusSkill} filtersOpen={s.filtersOpen} setFiltersOpen={s.setFiltersOpen} theme={s.theme} setTheme={s.setTheme} onRefresh={() => void s.load()} layout={s.layout} setLayout={s.setLayout} versions={s.versions} setVersions={s.setVersions} mode={s.mode} setMode={s.setMode} depth={s.depth} setDepth={s.setDepth} proposalLayer={s.filters.proposalLayer ?? 'both'} setProposalLayer={(proposalLayer) => s.setFilters({ ...s.filters, proposalLayer })} semanticNeighborhood={s.semanticNeighborhood} setSemanticNeighborhood={s.setSemanticNeighborhood} activeFilters={[
      ...(s.filters.query ? [{ label: `query:${s.filters.query}`, onRemove: () => s.setFilters({ ...s.filters, query: '' }) }] : []),
      ...(s.filters.owner ? [{ label: `owner:${s.filters.owner}`, onRemove: () => s.setFilters({ ...s.filters, owner: '' }) }] : []),
      ...(s.filters.scope ? [{ label: `scope:${s.filters.scope}`, onRemove: () => s.setFilters({ ...s.filters, scope: '' }) }] : []),
      ...(s.filters.tag ? [{ label: `tag:${s.filters.tag}`, onRemove: () => s.setFilters({ ...s.filters, tag: '' }) }] : []),
      ...(s.filters.lifecycle !== 'all' ? [{ label: `lifecycle:${s.filters.lifecycle}`, onRemove: () => s.setFilters({ ...s.filters, lifecycle: 'all' }) }] : []),
      ...(s.filters.proposalLayer !== 'both' ? [{ label: `layer:${s.filters.proposalLayer}`, onRemove: () => s.setFilters({ ...s.filters, proposalLayer: 'both' }) }] : []),
    ]} />
    <section className={`workspace ${s.filtersOpen ? 'filters-open' : ''} ${s.inspector || selectedProposal ? 'inspector-open' : ''}`}>
      <FilterPanel view={s.view} filtersOpen={s.filtersOpen} filters={s.filters} setFilters={s.setFilters} toggleRelation={s.toggleRelation} layout={s.layout} setLayout={s.setLayout} mode={s.mode} setMode={s.setMode} depth={s.depth} setDepth={s.setDepth} versions={s.versions} setVersions={s.setVersions} retrievals={s.retrievals} selectedRetrievalId={s.selectedId} onSelectRetrieval={(id) => { s.setSelectedId?.(id); s.navigate(`/retrievals/${encodeURIComponent(id)}`); }} />
      <RelationProposalQueue items={s.visibleProposals} selectedId={selectedProposal?.id} onSelect={(proposal) => { s.setProposalInspector(proposal); s.navigate(`/proposals/${encodeURIComponent(proposal.id)}`); }} onReview={(ids, status, reason) => void s.review(ids, status, reason)} onPreview={(ids) => void s.generatePreview(ids)} canReview={s.canReview} canApply={s.canApply} />
      <ExplicitRelationQueue canStage={s.canReview} onError={s.setError} />
      <GraphCanvas graph={canvasGraph} proposals={renderProposals} layout={s.layout} rootSkillId={s.view === 'skill' ? s.selectedId : undefined} loading={s.loading} error={s.error} truncated={graph.metadata.truncated} command={s.command} inspector={s.inspector?.kind === 'node' ? s.inspector : null} view={s.view} selectedId={s.selectedId} debug={s.debug} debugEnabled={s.debugEnabled} onNode={s.selectNode} onEdge={s.selectEdge} onClear={s.clearSelection} onDebug={s.setDebug} onFit={() => s.setCommand(`fit:${Date.now()}`)} onCenter={(id) => s.setCommand(`center:${id}:${Date.now()}`)} onDiscover={(id) => void s.discover(id)} onDismissError={() => s.setError('')} />
      <Inspector open={Boolean(s.inspector || selectedProposal)} inspector={s.inspector} selectedProposal={selectedProposal} clearSelection={s.clearSelection} graph={graph} proposals={s.proposals} skill={s.skill} resources={s.resources} onOpenBody={() => void s.openBody()} onExpandNeighbors={s.focusSkill} onAddRelation={s.setManualSource} onDiscover={(id) => void s.discover(id)} onOpenResource={(resource) => void s.openResource(resource)} canReview={s.canReview} canApply={s.canApply} onReviewProposal={(status, reason, changes) => void s.review([selectedProposal!.id], status, reason, changes)} onPreviewProposal={() => void s.generatePreview([selectedProposal!.id])} onDiscoverProposal={(id) => void s.discover(id)} />
    </section>
    <StatusBar health={s.health} runtimeStorage={s.runtimeStorage} runtimeCapabilities={s.runtimeCapabilities} runtimeStatus={s.runtimeStatus} graphNodes={visible.nodes.length} canonical={graph.edges.length} proposed={s.proposals.length} stats={s.stats} />
    {s.preview && <div className="modal" role="dialog" aria-modal="true" aria-label={s.preview.title}><div className="modal-card"><header><h2>{s.preview.title}</h2><button onClick={() => s.setPreview(undefined)}>Close</button></header><MarkdownViewer content={s.preview.content} /></div></div>}
    {s.manualSource && <ManualRelationDialog sourceSkillId={s.manualSource} searchSkills={(query) => api.search(query).then((result) => result.items)} onCreate={s.createManual} onClose={() => s.setManualSource(undefined)} />}
    {s.applyPreview && <RelationProposalApplyPreview data={s.applyPreview.data} onClose={() => s.setApplyPreview(undefined)} onApply={() => void s.applyReviewedPlan()} />}
  </main>;
}
