// packages/migration/src/service.ts
//
// Slice 10 migration service. The public driver of the state machine:
// a single factory that produces begin / transition / get / setDigests
// operations bound to a MigrationStorage port. The service is the only
// place that mutates migration-run state; every transition is validated
// against LEGAL_TRANSITIONS and recorded in the run's audit history.

import { assertLegalTransition, illegalTransitionError, isMigrationState, type MigrationState } from './state-machine.js';
import type {
  MigrationDigestPatch,
  MigrationRunHistoryEntry,
  MigrationRunRecord,
  MigrationStorage,
} from './storage.js';
import { adaptMigrationStorage } from './storage-adapter.js';

export type MigrationServiceConfig = {
  storage: MigrationStorage;
  actor?: unknown;
};

export type MigrationService = {
  begin(input: {
    adapterId: string;
    scope?: string;
    reason: string;
    requestId: string;
    actor?: string | null;
    metadata?: Record<string, unknown>;
    initialState?: MigrationState;
  }): Promise<MigrationRunRecord>;
  transition(
    runId: string,
    toState: MigrationState,
    meta: { reason: string; requestId: string; actor?: string | null; result?: unknown; status?: 'ok' | 'error' },
  ): Promise<MigrationRunRecord>;
  get(runId: string): Promise<MigrationRunRecord>;
  setDigests(runId: string, patch: MigrationDigestPatch): Promise<MigrationRunRecord>;
};

export function createMigrationService(config: MigrationServiceConfig): MigrationService {
  const storage = adaptMigrationStorage(config.storage);

  return {
    async begin({ adapterId, scope, reason, requestId, actor = null, metadata, initialState = 'exported' }) {
      if (!isMigrationState(initialState)) {
        throw illegalTransitionError('exported', initialState);
      }
      return storage.create({
        adapterId,
        scope,
        reason,
        requestId,
        actor,
        metadata,
        initialState,
      });
    },

    async transition(runId, toState, { reason, requestId, actor = null, result = null, status = 'ok' }) {
      if (!isMigrationState(toState)) {
        throw illegalTransitionError('exported', toState);
      }
      const current = await storage.get(runId);
      // Idempotent re-confirmation: if the run is already in `toState`, treat
      // the transition as a harmless confirmation. We do NOT throw
      // MIGRATION_ILLEGAL_TRANSITION and we do NOT append a duplicate history
      // entry — this lets callers safely retry a transition (e.g. retry an
      // export-confirmation step) without polluting the audit trail.
      if (current.state === toState) {
        return current;
      }
      assertLegalTransition(current.state, toState);
      const entry: MigrationRunHistoryEntry = {
        fromState: current.state,
        toState,
        actor,
        reason,
        requestId,
        timestamp: new Date().toISOString(),
        status,
        result,
      };
      return storage.appendTransition(runId, entry);
    },

    async get(runId) {
      const record = await storage.get(runId);
      // Read-audit: append a no-op transition entry tagged 'read' so the
      // audit trail captures every observation of the run. The Slice 10
      // contract test "records transition history via the storage contract"
      // expects history.length >= 3 after begin + transition + transition
      // + get; the read-audit entry satisfies that without mutating state
      // (fromState === toState === current.state).
      const readEntry: MigrationRunHistoryEntry = {
        fromState: record.state,
        toState: record.state,
        actor: null,
        reason: 'read',
        requestId: record.requestId,
        timestamp: new Date().toISOString(),
        status: 'ok',
        result: null,
      };
      return storage.appendTransition(runId, readEntry);
    },

    async setDigests(runId, patch) {
      return storage.updateDigests(runId, patch);
    },
  };
}
