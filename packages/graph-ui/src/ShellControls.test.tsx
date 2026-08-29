import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Toolbar } from './Toolbar';

describe('explorer shell popovers', () => {
  it('wires View and Layers controls to explorer state without changing the filter trigger', () => {
    const setLayout = vi.fn();
    const setVersions = vi.fn();
    const setMode = vi.fn();
    const setDepth = vi.fn();
    const setProposalLayer = vi.fn();
    const setSemanticNeighborhood = vi.fn();
    render(
      <Toolbar
        view="skill"
        switchView={vi.fn()}
        search=""
        setSearch={vi.fn()}
        results={[]}
        focusSkill={vi.fn()}
        filtersOpen={false}
        setFiltersOpen={vi.fn()}
        theme="system"
        setTheme={vi.fn()}
        onRefresh={vi.fn()}
        layout="force"
        setLayout={setLayout}
        versions="heads"
        setVersions={setVersions}
        mode="both"
        setMode={setMode}
        depth={3}
        setDepth={setDepth}
        proposalLayer="both"
        setProposalLayer={setProposalLayer}
        semanticNeighborhood={false}
        setSemanticNeighborhood={setSemanticNeighborhood}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    const view = screen.getByRole('dialog', { name: 'View controls' });
    fireEvent.change(within(view).getByLabelText('Toolbar layout'), { target: { value: 'radial' } });
    fireEvent.change(within(view).getByLabelText('Toolbar versions'), { target: { value: 'history' } });
    fireEvent.change(within(view).getByLabelText('Toolbar direction'), { target: { value: 'dependencies' } });
    fireEvent.change(within(view).getByLabelText('Toolbar depth'), { target: { value: '5' } });
    expect(setLayout).toHaveBeenCalledWith('radial');
    expect(setVersions).toHaveBeenCalledWith('history');
    expect(setMode).toHaveBeenCalledWith('dependencies');
    expect(setDepth).toHaveBeenCalledWith(5);

    fireEvent.click(screen.getByRole('button', { name: 'Layers' }));
    const layers = screen.getByRole('dialog', { name: 'Layer controls' });
    fireEvent.click(within(layers).getByLabelText('Canonical'));
    fireEvent.click(within(layers).getByLabelText('Proposed'));
    fireEvent.click(within(layers).getByLabelText('Semantic neighborhood'));
    expect(setProposalLayer).toHaveBeenNthCalledWith(1, 'proposed');
    expect(setProposalLayer).toHaveBeenNthCalledWith(2, 'canonical');
    expect(setSemanticNeighborhood).toHaveBeenCalledWith(true);
    expect(screen.getByRole('button', { name: 'Filters' })).toHaveAttribute('aria-expanded', 'false');
  });
});
