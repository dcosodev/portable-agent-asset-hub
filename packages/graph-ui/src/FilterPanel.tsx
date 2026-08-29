import { RELATIONS } from './graph-model';
import type { View } from './state/useExplorerState';
import type { Filters, RetrievalSummary } from './types';

type Props = {
  view: View;
  filtersOpen: boolean;
  filters: Filters;
  setFilters: (next: Filters) => void;
  toggleRelation: (relation: typeof RELATIONS[number]) => void;
  layout: 'force' | 'hierarchical' | 'grouped' | 'radial';
  setLayout: (value: 'force' | 'hierarchical' | 'grouped' | 'radial') => void;
  mode: string;
  setMode: (value: string) => void;
  depth: number;
  setDepth: (value: number) => void;
  versions: string;
  setVersions: (value: string) => void;
  retrievals: RetrievalSummary[];
  selectedRetrievalId: string | undefined;
  onSelectRetrieval: (id: string) => void;
};

/**
 * FilterPanel — W0 refactor of the `<aside className="left-panel">` that was
 * previously the first child of `<section className="workspace">`. The
 * component owns no state of its own; every interaction is forwarded through
 * the prop setters. The retrieval list and the filter form render in the
 * same branch (`view === 'retrieval'`) as in the original App.tsx so
 * behaviour, accessibility names and tests remain stable.
 */
export function FilterPanel(props: Props) {
  const {
    view,
    filtersOpen,
    filters,
    setFilters,
    toggleRelation,
    layout,
    setLayout,
    mode,
    setMode,
    depth,
    setDepth,
    versions,
    setVersions,
    retrievals,
    onSelectRetrieval,
  } = props;

  return (
    <aside className={`left-panel ${filtersOpen ? 'open' : ''}`}>
      <h2>{view === 'retrieval' ? 'Retrievals' : 'Filters'}</h2>
      {view === 'retrieval' ? (
        <ul className="retrieval-list">
          {retrievals.map((item) => (
            <li key={item.requestId}>
              <button
                onClick={() => onSelectRetrieval(item.requestId)}
              >
                <span>{item.redactedQuery ?? item.requestId}</span>
                <small>
                  {item.classification.primary} · {item.counts.selectedSkills} skills
                </small>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <>
          <label>
            Layout
            <select value={layout} onChange={(e) => setLayout(e.target.value as typeof layout)}>
              <option value="force">Force-directed</option>
              <option value="hierarchical">Hierarchical</option>
              <option value="grouped">Grouped</option>
              <option value="radial">Radial</option>
            </select>
          </label>
          {view === 'skill' && (
            <>
              <label>
                Direction
                <select aria-label="Direction" value={mode} onChange={(e) => setMode(e.target.value)}>
                  <option value="dependencies">Dependencies</option>
                  <option value="dependents">Dependents</option>
                  <option value="both">Both</option>
                </select>
              </label>
              <label>
                Depth
                <input
                  aria-label="Depth"
                  type="number"
                  min="1"
                  max="32"
                  value={depth}
                  onChange={(e) => setDepth(Number(e.target.value))}
                />
              </label>
            </>
          )}
          <label>
            Versions
            <select aria-label="Versions" value={versions} onChange={(e) => setVersions(e.target.value)}>
              <option value="heads">HEAD only</option>
              <option value="history">Show versions</option>
            </select>
          </label>
          <label>
            Node type
            <select
              aria-label="Node type"
              value={filters.kind}
              onChange={(e) => setFilters({ ...filters, kind: e.target.value as Filters['kind'] })}
            >
              <option value="all">All types</option>
              <option value="skill">Skills</option>
              <option value="tool">Tools</option>
            </select>
          </label>
          <label>
            Lifecycle
            <select
              aria-label="Lifecycle"
              value={filters.lifecycle}
              onChange={(e) => setFilters({ ...filters, lifecycle: e.target.value })}
            >
              <option value="all">All visible</option>
              <option value="active">Published / active</option>
            </select>
          </label>
          <label>
            Owner
            <input
              aria-label="Owner filter"
              value={filters.owner}
              onChange={(e) => setFilters({ ...filters, owner: e.target.value })}
            />
          </label>
          <label>
            Scope
            <input
              aria-label="Scope filter"
              value={filters.scope}
              onChange={(e) => setFilters({ ...filters, scope: e.target.value })}
            />
          </label>
          <label>
            Profile
            <input
              aria-label="Profile filter"
              value={filters.profile}
              onChange={(e) => setFilters({ ...filters, profile: e.target.value })}
            />
          </label>
          <label>
            Tag
            <input
              aria-label="Tag filter"
              value={filters.tag}
              onChange={(e) => setFilters({ ...filters, tag: e.target.value })}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              aria-label="Show isolated skills"
              checked={filters.isolatedOnly ?? false}
              onChange={(e) => setFilters({ ...filters, isolatedOnly: e.target.checked })}
            />
            Show isolated skills
          </label>
          <label>
            Graph layer
            <select
              aria-label="Graph layer"
              value={filters.proposalLayer}
              onChange={(e) =>
                setFilters({ ...filters, proposalLayer: e.target.value as Filters['proposalLayer'] })
              }
            >
              <option value="both">Canonical + Proposed</option>
              <option value="canonical">Canonical only</option>
              <option value="proposed">Proposed only</option>
            </select>
          </label>
          <label>
            Relation domain
            <select
              aria-label="Relation domain"
              value={filters.proposalDomain}
              onChange={(e) =>
                setFilters({ ...filters, proposalDomain: e.target.value as Filters['proposalDomain'] })
              }
            >
              <option value="both">Operational + Semantic</option>
              <option value="operational">Operational</option>
              <option value="semantic">Semantic</option>
            </select>
          </label>
          <label>
            Proposal confidence ≥
            <input
              aria-label="Proposal confidence threshold"
              type="number"
              min="0"
              max="1"
              step="0.05"
              value={filters.proposalMinConfidence}
              onChange={(e) => setFilters({ ...filters, proposalMinConfidence: Number(e.target.value) })}
            />
          </label>
          <fieldset>
            <legend>Proposal statuses</legend>
            {(['proposed', 'approved', 'rejected', 'stale', 'superseded'] as const).map((status) => (
              <label className="check" key={status}>
                <input
                  type="checkbox"
                  checked={filters.proposalStatuses?.has(status) ?? false}
                  onChange={() => {
                    const proposalStatuses = new Set(filters.proposalStatuses ?? []);
                    if (proposalStatuses.has(status)) proposalStatuses.delete(status);
                    else proposalStatuses.add(status);
                    setFilters({ ...filters, proposalStatuses });
                  }}
                />
                {status}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>Relations</legend>
            {RELATIONS.map((relation) => (
              <label className="check" key={relation}>
                <input
                  type="checkbox"
                  checked={filters.relations.has(relation)}
                  onChange={() => toggleRelation(relation)}
                />
                <span className={`relation-swatch ${relation}`} />
                {relation}
              </label>
            ))}
          </fieldset>
        </>
      )}
    </aside>
  );
}
