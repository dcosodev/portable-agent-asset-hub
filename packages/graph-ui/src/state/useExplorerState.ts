import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { FTS_SEMANTIC_PROPOSAL_DETECTOR, filterGraph, filterProposals } from '../graph-model';
import type { GraphDebugSnapshot } from '../GraphView';
import { useFilters } from './useFilters';
import type {
  GraphData,
  GraphEdge,
  GraphNode,
  ProposalRenderEdge,
  RelationProposal,
  RelationType,
  ResourceMeta,
  RetrievalSummary,
  SearchHit,
  SkillDetail,
} from '../types';

export type View = 'global' | 'skill' | 'retrieval';
export type Inspector =
  | { kind: 'node'; node: GraphNode }
  | { kind: 'edge'; edge: GraphEdge; proposal?: RelationProposal }
  | { kind: 'retrieval'; metadata: Record<string, unknown> }
  | null;

const empty: GraphData = {
  nodes: [],
  edges: [],
  metadata: {
    nodes: 0,
    edges: 0,
    truncated: false,
    truncatedNodes: 0,
    truncatedEdges: 0,
    limits: { maxDepth: 4, maxNodes: 200, maxEdges: 1000 },
    generatedAt: '',
    includeHistory: false,
  },
};

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

function navigate(path: string) {
  history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function hasCapability(health: Record<string, unknown>, capability: string): boolean {
  return JSON.stringify(health).includes(capability);
}

function toRenderEdge(proposal: RelationProposal): ProposalRenderEdge {
  return {
    proposalId: proposal.id,
    sourceSkillId: proposal.sourceSkillId,
    sourceVersion: proposal.sourceVersion,
    targetSkillId: proposal.targetSkillId,
    targetVersion: proposal.targetVersionSnapshot,
    relationType: proposal.relationType,
    targetVersionConstraint: proposal.targetVersionConstraint,
    confidence: proposal.confidence,
    detector: proposal.detector,
    status: proposal.status,
  };
}

/**
 * useExplorerState — W0 refactor of the state and business logic that was
 * previously inlined in App.tsx. This hook is intentionally a pure extraction:
 * it preserves the same handlers, the same effects, the same memoised values
 * and the same callback dependency lists. The visible behaviour, the
 * accessibility surface and the App.test.tsx suite must remain identical.
 */
export function useExplorerState() {
  const initial = pathState();
  const { filters, setFilters, toggleRelation } = useFilters();
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
  const [applyPreview, setApplyPreview] = useState<{
    proposalIds: string[];
    data: { changes: Array<Record<string, unknown>>; planDigest: string; validation?: Record<string, unknown> };
  }>();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [debug, setDebug] = useState<GraphDebugSnapshot>();
  const [semanticNeighborhood, setSemanticNeighborhood] = useState(false);

  const canRead = hasCapability(health, 'skill.relation.proposal.read');
  const canReview = hasCapability(health, 'skill.relation.proposal.review');
  const canApply = hasCapability(health, 'skill.relation.proposal.apply');

  const loadProposals = useCallback(async () => {
    if (!api.proposals) return;
    try {
      const result = await api.proposals();
      setProposals(result.items);
      const deep = pathState().proposalId;
      if (deep) {
        const found = result.items.find((item) => item.id === deep);
        if (found) setProposalInspector(found);
      }
    } catch (e) {
      if (canRead) setError(e instanceof Error ? e.message : 'Unable to load proposals');
    }
  }, [canRead]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      if (view === 'global') setGraph(await api.globalGraph(versions));
      else if (view === 'skill' && selectedId) {
        const data = await api.skillGraph(selectedId, mode, depth, versions);
        setGraph(data);
        const root = data.nodes.find((node) => node.skillId === selectedId);
        if (root) {
          setInspector({ kind: 'node', node: root });
          setCommand(`select:${root.id}:${Date.now()}`);
          const [detail, res] = await Promise.all([api.skill(root.skillId), api.resources(root.skillId)]);
          setSkill(detail);
          setResources(res.items);
        }
      } else if (view === 'retrieval') {
        const list = await api.retrievals();
        setRetrievals(list.items);
        if (selectedId) {
          const data = await api.retrievalGraph(selectedId);
          setGraph(data);
          setInspector({ kind: 'retrieval', metadata: data.metadata as unknown as Record<string, unknown> });
        }
      }
      await loadProposals();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to load graph');
    } finally {
      setLoading(false);
    }
  }, [view, selectedId, mode, depth, versions, loadProposals]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    Promise.all([api.status(), api.capabilities()])
      .then(([status, capabilities]) => setHealth({ status, capabilities }))
      .catch(() => setHealth({ status: 'offline' }));
  }, []);

  useEffect(() => {
    const handler = () => {
      const next = pathState();
      setView(next.view);
      setSelectedId(next.id);
      if (next.proposalId) {
        const found = proposals.find((item) => item.id === next.proposalId);
        if (found) setProposalInspector(found);
      }
    };
    addEventListener('popstate', handler);
    return () => removeEventListener('popstate', handler);
  }, [proposals]);

  useEffect(() => {
    if (search.trim().length < 2) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      api.search(search).then((data) => setResults(data.items)).catch(() => setResults([]));
    }, 220);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const visible = useMemo(() => filterGraph(graph, filters), [graph, filters]);
  const canvasGraph = useMemo(
    () =>
      filters.proposalLayer === 'proposed'
        ? { ...visible, edges: [], metadata: { ...visible.metadata, edges: 0 } }
        : visible,
    [filters.proposalLayer, visible],
  );
  const visibleProposals = useMemo(() => filterProposals(proposals, filters), [proposals, filters]);
  const semanticGhostProposals = useMemo(
    () => semanticNeighborhood
      ? proposals.filter((proposal) => proposal.detector === FTS_SEMANTIC_PROPOSAL_DETECTOR && proposal.status === 'proposed' && filters.relations.has(proposal.relationType))
      : [],
    [filters.relations, proposals, semanticNeighborhood],
  );
  const renderProposals = useMemo(
    () => (filters.proposalLayer === 'canonical' ? [] : [...visibleProposals, ...semanticGhostProposals].map(toRenderEdge)),
    [filters.proposalLayer, semanticGhostProposals, visibleProposals],
  );

  const runtimeStatus = (health.status && typeof health.status === 'object' ? health.status : {}) as Record<string, unknown>;
  const runtimeCapabilities = (health.capabilities && typeof health.capabilities === 'object' ? health.capabilities : {}) as Record<string, unknown>;
  const capabilityAuth = (runtimeCapabilities.auth && typeof runtimeCapabilities.auth === 'object' ? runtimeCapabilities.auth : {}) as Record<string, unknown>;
  const runtimeStorage = (runtimeCapabilities.storage && typeof runtimeCapabilities.storage === 'object'
    ? runtimeCapabilities.storage
    : runtimeStatus.storage && typeof runtimeStatus.storage === 'object'
      ? runtimeStatus.storage
      : {}) as Record<string, unknown>;

  const selectNode = useCallback((node: GraphNode) => {
    setInspector({ kind: 'node', node });
    setCommand(`center:${node.id}`);
    Promise.all([api.skill(node.skillId), api.resources(node.skillId)])
      .then(([detail, res]) => {
        setSkill(detail);
        setResources(res.items);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Inspector unavailable'));
  }, []);

  const selectEdge = useCallback(
    (edge: GraphEdge, renderProposal?: ProposalRenderEdge) => {
      const proposal = renderProposal
        ? proposals.find((item) => item.id === renderProposal.proposalId)
        : undefined;
      if (proposal) {
        setProposalInspector(proposal);
        navigate(`/proposals/${encodeURIComponent(proposal.id)}`);
      } else {
        setInspector({ kind: 'edge', edge });
      }
    },
    [proposals],
  );

  const clearSelection = useCallback(() => {
    setInspector(null);
    setProposalInspector(undefined);
    setSkill(undefined);
    setResources([]);
    setCommand(`clear:${Date.now()}`);
  }, []);

  function switchView(next: View) {
    setView(next);
    setInspector(null);
    setSelectedId(undefined);
    navigate(next === 'global' ? '/' : next === 'retrieval' ? '/retrievals' : '/skills');
  }

  function focusSkill(id: string) {
    setResults([]);
    setSearch('');
    setSelectedId(id);
    setView('skill');
    navigate(`/skills/${encodeURIComponent(id)}`);
  }

  async function review(
    ids: string[],
    status: 'approved' | 'rejected',
    reason?: string,
    changes?: { relationType?: string; reverseDirection?: boolean; constraint?: string | null },
  ) {
    try {
      const safeIds =
        !changes && status === 'approved'
          ? ids.filter((id) => !proposals.find((proposal) => proposal.id === id)?.reviewModified)
          : ids;
      for (const id of safeIds) await api.reviewProposal(id, status, reason, changes);
      await loadProposals();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to review proposal');
    }
  }

  async function createManual(input: { sourceSkillId: string; targetSkillId: string; relationType: RelationType; constraint: string | null }) {
    try {
      const created = await api.createManualProposal(input);
      setManualSource(undefined);
      await Promise.all([load(), loadProposals()]);
      setProposalInspector(created);
      navigate(`/proposals/${encodeURIComponent(created.id)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to create relation proposal');
    }
  }

  async function discover(skillId: string) {
    try {
      const result = await api.discover(skillId);
      setError(
        `Discovery: ${result.candidatePairs} candidates · ${result.proposalsCreated} proposals · high ${result.highConfidence} · medium ${result.mediumConfidence} · operational ${result.operational} · semantic ${result.semantic}`,
      );
      await loadProposals();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to discover relations');
    }
  }

  async function generatePreview(ids: string[]) {
    try {
      setApplyPreview({ proposalIds: ids, data: await api.previewApply(ids) });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to generate apply preview');
    }
  }

  async function applyReviewedPlan() {
    if (!applyPreview) return;
    try {
      await api.apply(applyPreview.proposalIds, applyPreview.data.planDigest);
      setApplyPreview(undefined);
      await Promise.all([load(), loadProposals()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to apply reviewed plan');
    }
  }

  async function openBody() {
    if (skill) setPreview({ title: `${skill.name} · SKILL.md`, content: skill.body ?? '' });
  }

  async function openResource(resource: ResourceMeta) {
    if (!skill) return;
    if (
      resource.size > 262144 ||
      !(resource.mime.startsWith('text/') || ['application/json', 'application/markdown'].includes(resource.mime))
    ) {
      setError('Binary or oversized resources are metadata-only in the explorer.');
      return;
    }
    try {
      const data = await api.resource(skill.id, resource.relativePath);
      let content = data.content ?? '';
      const encoded = (data as unknown as { bytesBase64?: string }).bytesBase64 ?? data.bytes;
      if (!content && encoded) content = atob(encoded);
      setPreview({ title: resource.relativePath, content });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Resource unavailable');
    }
  }

  const selectedProposal = proposalInspector;
  const stats = {
    canonicalConnected: new Set(graph.edges.flatMap((edge) => [edge.source, edge.target])).size,
    isolated: graph.nodes.filter((node) => !graph.edges.some((edge) => edge.source === node.id || edge.target === node.id)).length,
    high: proposals.filter((item) => item.confidence >= 0.85).length,
    medium: proposals.filter((item) => item.confidence >= 0.6 && item.confidence < 0.85).length,
    operational: proposals.filter((item) => item.relationType !== 'related_to').length,
    semantic: proposals.filter((item) => item.relationType === 'related_to').length,
  };

  return {
    // routing / view
    view,
    switchView,
    focusSkill,
    navigate,
    // data
    graph,
    proposals,
    retrievals,
    visible,
    canvasGraph,
    renderProposals,
    visibleProposals,
    semanticNeighborhood,
    setSemanticNeighborhood,
    // selection
    selectedId,
    setSelectedId,
    inspector,
    selectedProposal,
    selectNode,
    selectEdge,
    clearSelection,
    setProposalInspector,
    // view controls
    layout,
    setLayout,
    mode,
    setMode,
    depth,
    setDepth,
    versions,
    setVersions,
    theme,
    setTheme,
    // filters
    filters,
    setFilters,
    toggleRelation,
    // search
    search,
    setSearch,
    results,
    // errors / loading
    error,
    setError,
    loading,
    // commands / debug
    command,
    setCommand,
    debug,
    setDebug,
    debugEnabled: import.meta.env.DEV,
    // capabilities
    canRead,
    canReview,
    canApply,
    // health
    health,
    runtimeStatus,
    runtimeCapabilities,
    capabilityAuth,
    runtimeStorage,
    // inspector resources
    skill,
    resources,
    preview,
    setPreview,
    // manual creation
    manualSource,
    setManualSource,
    createManual,
    // apply preview
    applyPreview,
    setApplyPreview,
    generatePreview,
    applyReviewedPlan,
    // panel toggles
    filtersOpen,
    setFiltersOpen,
    // actions
    review,
    discover,
    openBody,
    openResource,
    load,
    // stats
    stats,
  } as const;
}
