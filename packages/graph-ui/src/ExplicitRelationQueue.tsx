import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import type { ExplicitCandidate, ExplicitCandidateStatus, ExplicitImpact } from './types';

type Props = { canStage: boolean; onError: (message: string) => void };
const statuses: Array<'all' | ExplicitCandidateStatus> = ['all', 'READY_FOR_REVIEW', 'ALREADY_STAGED', 'ALREADY_CANONICAL', 'UNRESOLVED', 'AMBIGUOUS'];

export function ExplicitRelationQueue({ canStage, onError }: Props) {
  const [items, setItems] = useState<ExplicitCandidate[]>([]);
  const [summary, setSummary] = useState<Record<string, number>>({});
  const [status, setStatus] = useState<typeof statuses[number]>('READY_FOR_REVIEW');
  const [reciprocal, setReciprocal] = useState<'all' | 'true' | 'false'>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [inspected, setInspected] = useState<ExplicitCandidate>();
  const [impact, setImpact] = useState<ExplicitImpact>();
  const [layer, setLayer] = useState(false);

  async function load() {
    try {
      const query = new URLSearchParams({ limit: '250' });
      if (status !== 'all') query.set('status', status);
      if (reciprocal !== 'all') query.set('reciprocal', reciprocal);
      const result = await api.explicitCandidates(query.toString());
      setItems(result.items);
      setSummary(result.summary as unknown as Record<string, number>);
      setSelected(new Set());
    } catch (error) { onError(error instanceof Error ? error.message : 'Unable to load explicit relation candidates'); }
  }
  useEffect(() => { void load(); }, [status, reciprocal]);
  const selectedItems = useMemo(() => items.filter((item) => selected.has(item.pairKey)), [items, selected]);
  function toggle(pairKey: string) { setSelected((current) => { const next = new Set(current); if (next.has(pairKey)) next.delete(pairKey); else next.add(pairKey); return next; }); }
  async function preview() { try { setImpact(await api.explicitImpact([...selected])); } catch (error) { onError(error instanceof Error ? error.message : 'Unable to calculate explicit relation impact'); } }
  async function stage() { try { await api.stageExplicit([...selected]); await load(); } catch (error) { onError(error instanceof Error ? error.message : 'Unable to stage explicit relations'); } }

  return <section className="proposal-queue explicit-relation-queue" aria-label="Explicit Relations">
    <header><h2>Explicit Relations</h2><button onClick={() => void load()}>Refresh</button></header>
    <div className="explicit-summary" aria-label="Explicit relation summary">
      <span>Ready {summary.ready ?? 0}</span><span>Staged {summary.alreadyStaged ?? 0}</span><span>Canonical {summary.alreadyCanonical ?? 0}</span><span>Unresolved {summary.unresolved ?? 0}</span>
    </div>
    <div className="proposal-filters">
      <label>Status<select aria-label="Explicit status filter" value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>{statuses.map((value) => <option key={value} value={value}>{value === 'all' ? 'All statuses' : value}</option>)}</select></label>
      <label>Direction<select aria-label="Explicit direction filter" value={reciprocal} onChange={(event) => setReciprocal(event.target.value as typeof reciprocal)}><option value="all">Reciprocal + one-way</option><option value="true">Reciprocal</option><option value="false">One-way</option></select></label>
      <label className="check"><input aria-label="Explicit metadata layer" type="checkbox" checked={layer} onChange={(event) => setLayer(event.target.checked)} />Explicit metadata layer</label>
    </div>
    {layer && <div className="explicit-canvas-layer" aria-label="Explicit metadata canvas layer">Ghost layer: {items.length} explicit candidate edges (canonical edges remain solid; proposals remain dotted)</div>}
    {selectedItems.length > 0 && <div className="proposal-batch-actions"><span>{selectedItems.length} selected</span><button disabled={!canStage} onClick={() => void stage()}>Stage selected</button><button onClick={() => void preview()}>Impact preview</button></div>}
    {impact && <div className="explicit-impact" aria-label="Explicit impact preview"><strong>Impact preview</strong><span>Current: {impact.current.edges} edges · {impact.current.components} components · {impact.current.isolated} isolated · largest {impact.current.largest}</span><span>After selected: {impact.afterIfApplied.edges} edges · {impact.afterIfApplied.components} components · {impact.afterIfApplied.isolated} isolated · largest {impact.afterIfApplied.largest}</span><button onClick={() => setImpact(undefined)}>Close preview</button></div>}
    {items.length === 0 ? <p>No explicit metadata candidates match the current filters.</p> : <ul>{items.map((item) => <li key={item.pairKey} className={inspected?.pairKey === item.pairKey ? 'selected' : ''}><label className="candidate-row"><input type="checkbox" aria-label={`Select ${item.sourceLogicalKey} to ${item.targetLogicalKey ?? item.unresolvedToken ?? 'unresolved'}`} checked={selected.has(item.pairKey)} disabled={item.status !== 'READY_FOR_REVIEW' && item.status !== 'ALREADY_STAGED'} onChange={() => toggle(item.pairKey)} /><button onClick={() => setInspected(item)}>{item.sourceLogicalKey} <span>related_to</span> {item.targetLogicalKey ?? item.unresolvedToken ?? 'unresolved'}</button><small>{item.status} · {item.reciprocal ? 'RECIPROCAL' : 'ONE-WAY'}</small></label></li>)}</ul>}
    {inspected && <aside className="explicit-inspector" aria-label="Explicit candidate inspector"><h3>Candidate inspector</h3><dl><dt>Pair</dt><dd>{inspected.sourceLogicalKey} ↔ {inspected.targetLogicalKey ?? inspected.unresolvedToken}</dd><dt>Status</dt><dd>{inspected.status}</dd><dt>Evidence</dt><dd>{inspected.evidence.metadataField}</dd><dt>Source declares target</dt><dd>{inspected.sourceDeclaresTarget ? 'YES' : 'NO'}</dd><dt>Target declares source</dt><dd>{inspected.targetDeclaredSource ? 'YES' : 'NO'}</dd><dt>Canonical</dt><dd>{inspected.canonicalRelationId ?? 'NO'}</dd><dt>Active proposal</dt><dd>{inspected.activeProposalIds.length ? inspected.activeProposalIds.join(', ') : 'NONE'}</dd></dl><button onClick={() => setInspected(undefined)}>Close inspector</button></aside>}
  </section>;
}
