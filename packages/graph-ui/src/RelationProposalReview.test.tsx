import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RelationProposalInspector } from './RelationProposalInspector';
import { RelationProposalQueue } from './RelationProposalQueue';
import type { RelationProposal } from './types';

const proposal: RelationProposal = { id: 'p-1', sourceSkillId: 'source', sourceVersion: 2, targetSkillId: 'target', targetVersionSnapshot: 1, relationType: 'requires', targetVersionConstraint: '>=1', confidence: 0.94, detector: 'explicit-reference-v1', detectorVersion: 'v1', reason: 'explicit prerequisite', status: 'proposed', evidence: [{ kind: 'source_text', excerpt: 'Use target before source' }], createdAt: '2026-01-01T00:00:00Z' };
const base = { onSelect: vi.fn(), onReview: vi.fn(), onPreview: vi.fn(), canReview: true, canApply: true };

describe('relation proposal review UI', () => {
  it('filters high-confidence operational proposals and supports batch approve', () => {
    render(<RelationProposalQueue items={[proposal]} {...base} />);
    expect(screen.getByText('requires?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select proposal p-1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve selected' }));
    expect(base.onReview).toHaveBeenCalledWith(['p-1'], 'approved');
  });

  it('shows read-only state without review capability and exposes evidence', () => {
    render(<RelationProposalInspector proposal={proposal} canReview={false} canApply={false} onReview={vi.fn()} onPreview={vi.fn()} onDiscover={vi.fn()} />);
    expect(screen.getByText('PROPOSED RELATION')).toBeInTheDocument();
    expect(screen.getByText('read-only')).toBeInTheDocument();
    expect(screen.getByText('Use target before source')).toBeInTheDocument();
    expect(screen.getByText('Why was this proposed?')).toBeInTheDocument();
  });
});
