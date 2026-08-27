import { useState } from 'react';
import type { RelationProposal, RelationType } from './types';

const relationTypes: RelationType[] = ['requires', 'uses', 'extends', 'supersedes', 'conflicts_with', 'related_to', 'produces', 'consumes'];
type ReviewChanges = { relationType?: RelationType; reverseDirection?: boolean; constraint?: string | null };

export function RelationProposalInspector({ proposal, canReview, canApply, onReview, onPreview, onDiscover }: { proposal: RelationProposal; canReview: boolean; canApply: boolean; onReview: (status: 'approved' | 'rejected', reason?: string, changes?: ReviewChanges) => void; onPreview: () => void; onDiscover: () => void }) {
  const [relationType, setRelationType] = useState<RelationType>(proposal.reviewedRelationType ?? proposal.relationType);
  const [reverseDirection, setReverseDirection] = useState(false);
  const [constraint, setConstraint] = useState(proposal.targetVersionConstraint ?? '');
  const changed = relationType !== proposal.relationType || reverseDirection || constraint !== (proposal.targetVersionConstraint ?? '');
  const reviewedSource = reverseDirection ? proposal.targetSkillId : proposal.sourceSkillId;
  const reviewedTarget = reverseDirection ? proposal.sourceSkillId : proposal.targetSkillId;
  return <div className="proposal-inspector" aria-label="Proposed relation inspector">
    <div className="proposal-badge">PROPOSED RELATION {proposal.reviewModified && <b>EDITED</b>}</div>
    <h2>{proposal.relationType}? <small>{proposal.status}</small></h2>
    <h3>Suggested</h3><p>{proposal.sourceSkillId} <strong>{proposal.relationType}</strong> {proposal.targetSkillId}</p>
    <dl><dt>Proposal ID</dt><dd className="hash">{proposal.id}</dd><dt>Source skill/version</dt><dd>{proposal.sourceSkillId}@{proposal.sourceVersion}</dd><dt>Target skill/version</dt><dd>{proposal.targetSkillId}@{proposal.targetVersionSnapshot}</dd><dt>Constraint</dt><dd>{proposal.targetVersionConstraint ?? 'none'}</dd><dt>Confidence</dt><dd>{proposal.confidence.toFixed(3)} ({proposal.confidence >= 0.85 ? 'high' : proposal.confidence >= 0.6 ? 'medium' : 'low'})</dd><dt>Candidate relevance</dt><dd>{proposal.candidateScore == null ? 'n/a (manual)' : proposal.candidateScore.toFixed(3)}</dd><dt>Origin</dt><dd>{proposal.origin ?? 'discovered'}</dd><dt>Detector</dt><dd>{proposal.detector}{proposal.detectorVersion ? ` · ${proposal.detectorVersion}` : ''}</dd><dt>Reviewed at</dt><dd>{proposal.reviewedAt ?? '—'}</dd><dt>Reviewed by</dt><dd>{proposal.reviewedBy ?? '—'}</dd></dl>
    <h3>Why was this proposed? <span>(pair and relation)</span></h3><p>{proposal.reason}</p>
    <h3>Evidence</h3><ul className="proposal-evidence">{proposal.evidence.map((evidence, index) => <li key={`${evidence.kind}-${index}`}><strong>{evidence.kind.replaceAll('_', ' ')}</strong>{evidence.score !== undefined && <span> · score {evidence.score}</span>}{evidence.excerpt && <pre>{evidence.excerpt}</pre>}</li>)}</ul>
    {canReview && proposal.status === 'proposed' && <fieldset aria-label="Review proposal"><legend>Reviewed</legend><label>Relation <select aria-label="Reviewed relation type" value={relationType} onChange={(event) => setRelationType(event.target.value as RelationType)}>{relationTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select></label><label>Constraint <input aria-label="Reviewed constraint" value={constraint} placeholder="optional, e.g. >=3" onChange={(event) => setConstraint(event.target.value)} /></label><label><input type="checkbox" aria-label="Reverse direction" checked={reverseDirection} onChange={(event) => setReverseDirection(event.target.checked)} /> Reverse direction ({reviewedSource} → {reviewedTarget})</label>{changed && <p>Suggested: {proposal.relationType} · Reviewed: {relationType}{reverseDirection ? ' · reversed' : ''}</p>}</fieldset>}
    <div className="inspector-actions">{canReview && proposal.status === 'proposed' ? <><button onClick={() => onReview('approved', undefined, changed ? { relationType: relationType === proposal.relationType ? undefined : relationType, reverseDirection, constraint: constraint || null } : undefined)}>{changed ? 'Accept with changes' : 'Accept as suggested'}</button><button onClick={() => { const reason = window.prompt('Reject reason (optional)') ?? undefined; onReview('rejected', reason); }}>Reject</button></> : <span className="read-only">read-only</span>}{canApply && proposal.status === 'approved' && <button onClick={onPreview}>Generate Apply Preview</button>}<button onClick={onDiscover}>Discover relations</button></div>
  </div>;
}
