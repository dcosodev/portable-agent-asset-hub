import { useState } from 'react';
import type { View } from './state/useExplorerState';
import type { SearchHit } from './types';

type Props = {
  view: View;
  switchView: (next: View) => void;
  search: string;
  setSearch: (value: string) => void;
  results: SearchHit[];
  focusSkill: (id: string) => void;
  filtersOpen: boolean;
  setFiltersOpen: (open: boolean) => void;
  theme: 'system' | 'dark' | 'light';
  setTheme: (value: 'system' | 'dark' | 'light') => void;
  onRefresh: () => void;
  activeFilters?: Array<{ label: string; onRemove: () => void }>;
  layout: 'force' | 'hierarchical' | 'grouped' | 'radial';
  setLayout: (value: 'force' | 'hierarchical' | 'grouped' | 'radial') => void;
  versions: string;
  setVersions: (value: string) => void;
  mode: string;
  setMode: (value: string) => void;
  depth: number;
  setDepth: (value: number) => void;
  proposalLayer: 'both' | 'canonical' | 'proposed';
  setProposalLayer: (value: 'both' | 'canonical' | 'proposed') => void;
  semanticNeighborhood: boolean;
  setSemanticNeighborhood: (value: boolean) => void;
};

/**
 * Toolbar — W0 refactor of the `<header>` block that was previously the first
 * child of the app shell. Pure presentational: every accessible name, button
 * label and event handler is forwarded from the parent so the App.test.tsx
 * suite continues to find the same elements.
 */
export function Toolbar({
  view,
  switchView,
  search,
  setSearch,
  results,
  focusSkill,
  filtersOpen,
  setFiltersOpen,
  theme,
  setTheme,
  onRefresh,
  activeFilters = [],
  layout,
  setLayout,
  versions,
  setVersions,
  mode,
  setMode,
  depth,
  setDepth,
  proposalLayer,
  setProposalLayer,
  semanticNeighborhood,
  setSemanticNeighborhood,
}: Props) {
  const [popover, setPopover] = useState<'view' | 'layers' | null>(null);
  return (
    <header>
      <div className="brand">
        <span className="brand-mark">PA</span>
        <strong>Graph Explorer</strong>
      </div>
      <nav aria-label="Explorer views">
        {(['global', 'skill', 'retrieval'] as View[]).map((item) => (
          <button key={item} className={view === item ? 'active' : ''} onClick={() => switchView(item)}>
            {item === 'global' ? 'Global Graph' : item === 'skill' ? 'Skill Graph' : 'Retrieval Explorer'}
          </button>
        ))}
      </nav>
      <div className="popover-trigger">
        <button aria-expanded={popover === 'view'} onClick={() => setPopover(popover === 'view' ? null : 'view')}>View</button>
        {popover === 'view' && <div className="popover" role="dialog" aria-label="View controls">
          <strong>View</strong>
          <label>Layout<select aria-label="Toolbar layout" value={layout} onChange={(event) => setLayout(event.target.value as Props['layout'])}><option value="force">Force-directed</option><option value="hierarchical">Hierarchical</option><option value="grouped">Grouped</option><option value="radial">Radial</option></select></label>
          <label>Versions<select aria-label="Toolbar versions" value={versions} onChange={(event) => setVersions(event.target.value)}><option value="heads">HEAD only</option><option value="history">Show versions</option></select></label>
          {view === 'skill' && <><label>Direction<select aria-label="Toolbar direction" value={mode} onChange={(event) => setMode(event.target.value)}><option value="dependencies">Dependencies</option><option value="dependents">Dependents</option><option value="both">Both</option></select></label><label>Depth<input aria-label="Toolbar depth" type="number" min="1" max="32" value={depth} onChange={(event) => setDepth(Number(event.target.value))} /></label></>}
        </div>}
      </div>
      <div className="popover-trigger">
        <button aria-expanded={popover === 'layers'} onClick={() => setPopover(popover === 'layers' ? null : 'layers')}>Layers</button>
        {popover === 'layers' && <div className="popover" role="dialog" aria-label="Layer controls"><strong>Layers</strong><label><input type="checkbox" checked={proposalLayer !== 'proposed'} onChange={(event) => setProposalLayer(event.target.checked ? 'both' : 'proposed')} />Canonical</label><label><input type="checkbox" checked={proposalLayer !== 'canonical'} onChange={(event) => setProposalLayer(event.target.checked ? 'both' : 'canonical')} />Proposed</label><label><input type="checkbox" checked={semanticNeighborhood} onChange={(event) => setSemanticNeighborhood(event.target.checked)} />Semantic neighborhood</label></div>}
      </div>
      <button
        className="panel-toggle"
        aria-expanded={filtersOpen}
        onClick={() => setFiltersOpen(!filtersOpen)}
      >
        Filters
      </button>
      <div className="search-wrap">
        <input
          aria-label="Search skills"
          placeholder="Search skills…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {results.length > 0 && (
          <ul className="search-results">
            {results.map((result) => (
              <li key={result.id}>
                <button onClick={() => focusSkill(result.id)}>
                  {result.name}
                  <small>{result.summary}</small>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <button onClick={onRefresh}>Refresh</button>
      <select
        aria-label="Theme"
        value={theme}
        onChange={(e) => setTheme(e.target.value as 'system' | 'dark' | 'light')}
      >
        <option value="system">System</option>
        <option value="dark">Dark</option>
        <option value="light">Light</option>
      </select>
      {activeFilters.length > 0 && <div className="active-filter-chips" aria-label="Active filters">{activeFilters.map((filter) => <span className="filter-chip" key={filter.label}>{filter.label}<button aria-label={`Remove ${filter.label}`} onClick={filter.onRemove}>×</button></span>)}</div>}
    </header>
  );
}
