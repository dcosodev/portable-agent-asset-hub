// packages/migration/src/shadow.ts
//
// Slice 10 shadow service.
//
// The shadow service writes to a SEPARATE namespace from the canonical
// hub database. It NEVER dual-writes; observations are recorded against
// the migration run (so they can be diffed against the canonical store
// in replay), but they do not touch the live tables. This is the core
// safety property of shadow mode: if shadow blows up, the canonical
// store is untouched.
//
// For S10 GREEN core, observation storage is in-process: a side map
// keyed by runId holds the observation count and the recorded records.
// The full persistence of observations (so shadow can survive a
// restart) is out of scope for this slice — only the contract is pinned.

import type { MigrationRunRecord, MigrationStorage } from './storage.js';
import { adaptMigrationStorage } from './storage-adapter.js';

export type ShadowObservation = {
  kind: string;
  body: Record<string, unknown>;
};

export type ShadowRunView = MigrationRunRecord & {
  observations: number;
};

export type ShadowServiceConfig = {
  storage: MigrationStorage;
  workdir?: string;
  actor?: unknown;
};

export type ShadowService = {
  start(input: { adapterId?: string; runId?: string; reason: string; requestId: string }): Promise<ShadowRunView>;
  observe(input: { runId: string; record: ShadowObservation }): Promise<ShadowRunView>;
  get(runId: string): Promise<ShadowRunView>;
};

export function createShadowService(config: ShadowServiceConfig): ShadowService {
  const storage = adaptMigrationStorage(config.storage);
  const observationCounts = new Map<string, number>();
  const observationSets = new Map<string, ShadowObservation[]>();

  const view = async (runId: string): Promise<ShadowRunView> => {
    const record = await storage.get(runId);
    return Object.assign({}, record, {
      observations: observationCounts.get(runId) ?? 0,
    }) as ShadowRunView;
  };

  return {
    async start({ adapterId = 'python-v2', runId, reason, requestId }) {
      // If the caller already began a migration run, reuse it; otherwise
      // create a fresh shadow-isolated run record so observation history
      // is bound to a stable id.
      const record = runId
        ? await storage.get(runId)
        : await storage.create({
            adapterId,
            reason,
            requestId,
            initialState: 'shadowing',
          });
      observationCounts.set(record.runId, 0);
      observationSets.set(record.runId, []);
      return view(record.runId);
    },

    async observe({ runId, record }) {
      const existing = observationSets.get(runId) ?? [];
      existing.push(record);
      observationSets.set(runId, existing);
      observationCounts.set(runId, (observationCounts.get(runId) ?? 0) + 1);
      return view(runId);
    },

    async get(runId) {
      return view(runId);
    },
  };
}
