import { useMemo, useState } from 'react';
import type { ProposalDomain, ProposalStatus, RelationProposal } from './types';

const statuses: ProposalStatus[] = ['proposed', 'approved', 'rejected', 'stale', 'superseded'];

export function RelationProposalQueue({
  items,
  selectedId,
  onSelect,
  onReview,
  onPreview,
  canReview,
  canApply,
}: {
  items: RelationProposal[];
  selectedId?: string;
  onSelect: (proposal: RelationProposal) => void;
  onReview: (ids: string[], status: 'approved' | 'rejected', reason?: string) => void;
  onPreview: (ids: string[]) => void;
  canReview: boolean;
  canApply: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<ProposalStatus | 'all'>('proposed');
  const [domain, setDomain] = useState<ProposalDomain>('both');
  const [minimum, setMinimum] = useState(0);
  const [origin, setOrigin] = useState<'all' | 'discovered' | 'manual'>('all');
  const [detector, setDetector] = useState('all');
  const detectors = useMemo(() => [...new Set(items.map((item) => item.detector))].sort(), [items]);
  const visible = items.filter((item) => (status === 'all' || item.status === status) && item.confidence >= minimum &&
    (detector === 'all' || item.detector === detector) && (origin === 'all' || (item.origin ?? 'discovered') === origin) && (domain === 'both' || (domain === 'semantic' ? item.relationType === 'related_to' : item.relationType !== 'related_to')));
  const toggle = (id: string) => setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const selectedIds = [...selected].filter((id) => visible.some((item) => item.id === id));
  return <section aria-label="Relation Proposals" className="proposal-queue">
    <div className="proposal-heading"><h2>Relation Proposals</h2><span>{visible.length}/{items.length}</span></div>
    <div className="proposal-filters">
      <label>Status<select aria-label="Proposal status filter" value={status} onChange={(event) => setStatus(event.target.value as ProposalStatus | 'all')}><option value="all">All statuses</option>{statuses.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
      <label>Domain<select aria-label="Proposal domain filter" value={domain} onChange={(event) => setDomain(event.target.value as ProposalDomain)}><option value="both">Operational + Semantic</option><option value="operational">Operational</option><option value="semantic">Semantic</option></select></label>
      <label>Confidence ≥ <input aria-label="Proposal confidence filter" type="number" min="0" max="1" step="0.05" value={minimum} onChange={(event) => setMinimum(Number(event.target.value))} /></label>
      <label>Origin<select aria-label="Proposal origin filter" value={origin} onChange={(event) => setOrigin(event.target.value as typeof origin)}><option value="all">All origins</option><option value="discovered">Discovery</option><option value="manual">Manual</option></select></label><label>Detector<select aria-label="Proposal detector filter" value={detector} onChange={(event) => setDetector(event.target.value)}><option value="all">All detectors</option>{detectors.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
    </div>
    {selectedIds.length > 0 && <div className="proposal-batch-actions"><span>{selectedIds.length} selected</span><button disabled={!canReview} onClick={() => onReview(selectedIds, 'approved')}>Approve selected</button><button disabled={!canReview} onClick={() => onReview(selectedIds, 'rejected')}>Reject selected</button><button disabled={!canApply} onClick={() => onPreview(selectedIds)}>Generate Apply Preview</button></div>}
    {visible.length === 0 ? <p>No proposals match the current filters.</p> : <ul>{visible.map((item) => <li key={item.id} className={selectedId === item.id ? 'selected' : ''}>
      <input aria-label={`Select proposal ${item.id}`} type="checkbox" checked={selected.has(item.id)} onChange={() => toggle(item.id)} />
      <button className="proposal-item" onClick={() => onSelect(item)}><strong>{item.relationType}{item.status === 'proposed' ? '?' : ''}</strong><span>{item.sourceSkillId}@{item.sourceVersion} → {item.targetSkillId}@{item.targetVersionSnapshot}</span><small>{item.status} · confidence {item.confidence.toFixed(2)} · {item.detector}</small></button>
    </li>)}</ul>}
  </section>;
}
