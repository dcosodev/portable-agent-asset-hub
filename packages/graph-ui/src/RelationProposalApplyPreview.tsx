export interface ApplyPreviewData { changes: Array<Record<string, unknown>>; planDigest: string; validation?: Record<string, unknown> }

export function RelationProposalApplyPreview({ data, onApply, onClose, busy }: { data: ApplyPreviewData; onApply: () => void; onClose: () => void; busy?: boolean }) {
  return <div className="modal" role="dialog" aria-modal="true" aria-label="Relation proposal apply preview"><div className="modal-card apply-preview">
    <header><h2>Apply Preview</h2><button onClick={onClose}>Close</button></header>
    <p>{data.changes.length} approved proposal(s) selected. No canonical relation has been changed.</p>
    <ul>{data.changes.map((change, index) => <li key={String(change.proposalId ?? index)}><strong>{String(change.relationType ?? 'relation')}</strong> · {String(change.sourceSkillId)}@{String(change.sourceVersion)} → {String(change.targetSkillId)}@{String(change.targetVersion)}{change.targetVersionConstraint ? ` · ${String(change.targetVersionConstraint)}` : ''} · confidence {Number(change.confidence ?? 0).toFixed(2)}</li>)}</ul>
    <h3>Validation</h3><pre>{JSON.stringify(data.validation ?? { cycle: 'not reported', conflicts: 'not reported' }, null, 2)}</pre>
    <label>planDigest<input aria-label="Plan digest" readOnly value={data.planDigest} /></label>
    <div className="inspector-actions"><button disabled={busy} onClick={onApply}>Apply Reviewed Plan</button><button onClick={onClose}>Cancel</button></div>
  </div></div>;
}
