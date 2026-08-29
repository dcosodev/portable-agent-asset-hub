import { useState } from 'react';
import { RELATIONS } from '../graph-model';
import type { Filters } from '../types';

/**
 * useFilters — W0 refactor of the filter state previously inlined in App.tsx.
 *
 * Preserves the original behaviour:
 *  - `relations` defaults to the full set of RELATIONS
 *  - `lifecycle` defaults to 'all'
 *  - `proposalStatuses` defaults to {proposed}
 *  - `proposalMinConfidence` defaults to 0
 *  - `proposalDetectors` defaults to empty Set
 *  - `proposalLayer` defaults to 'both'
 *  - `proposalDomain` defaults to 'both'
 *  - `kind` defaults to 'all'
 *
 * The exposed `toggleRelation` mutator is the same algorithm that App.tsx
 * used to maintain the relations Set, so UI behaviour and tests stay green.
 */
export function useFilters() {
  const [filters, setFilters] = useState<Filters>({
    relations: new Set(RELATIONS),
    lifecycle: 'all',
    query: '',
    owner: '',
    scope: '',
    tag: '',
    profile: '',
    kind: 'all',
    proposalLayer: 'both',
    proposalStatuses: new Set(['proposed']),
    proposalMinConfidence: 0,
    proposalDetectors: new Set(),
    proposalDomain: 'both',
  });

  function toggleRelation(relation: typeof RELATIONS[number]) {
    setFilters((current) => {
      const relations = new Set(current.relations);
      if (relations.has(relation)) relations.delete(relation);
      else relations.add(relation);
      return { ...current, relations };
    });
  }

  function toggleProposalStatus(status: 'proposed' | 'approved' | 'rejected' | 'stale' | 'superseded') {
    setFilters((current) => {
      const proposalStatuses = new Set(current.proposalStatuses ?? []);
      if (proposalStatuses.has(status)) proposalStatuses.delete(status);
      else proposalStatuses.add(status);
      return { ...current, proposalStatuses };
    });
  }

  return { filters, setFilters, toggleRelation, toggleProposalStatus };
}
