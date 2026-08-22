// packages/migration/src/storage.ts
//
// Slice 10 storage port. Defines the *minimal* persistence contract
// that the migration package needs from the storage layer. The
// canonical implementation lives in storage-sqlite; tests in Slice 10
// use an in-memory stub that satisfies the same interface.
//
// IMPORTANT: this port is intentionally narrow. It does NOT expose the
// full Storage transaction interface; the migration package must be
// usable in a hermetic test environment without a SQLite database, and
// must be replaceable by a future storage backend (e.g. Postgres)
// without changing the migration surface.

import type { MigrationState } from './state-machine.js';

export type MigrationRunHistoryEntry = {
  fromState: MigrationState | null;
  toState: MigrationState;
  actor: string | null;
  reason: string;
  requestId: string;
  timestamp: string;
  status: 'ok' | 'error';
  result: unknown;
};

export type MigrationRunRecord = {
  runId: string;
  adapterId: string;
  scope?: string;
  reason: string;
  requestId: string;
  state: MigrationState;
  sourceDigest: string | null;
  targetDigest: string | null;
  manifestDigest: string | null;
  archivePath: string | null;
  metadata: Record<string, unknown>;
  history: MigrationRunHistoryEntry[];
  createdAt: string;
  updatedAt: string;
};

export type MigrationRunCreate = {
  adapterId: string;
  scope?: string;
  reason: string;
  requestId: string;
  initialState: MigrationState;
  actor?: string | null;
  metadata?: Record<string, unknown>;
};

export type MigrationDigestPatch = Partial<
  Pick<MigrationRunRecord, 'sourceDigest' | 'targetDigest' | 'manifestDigest'>
>;

export interface MigrationStorage {
  create(input: MigrationRunCreate): Promise<MigrationRunRecord>;
  get(runId: string): Promise<MigrationRunRecord>;
  list(): Promise<MigrationRunRecord[]>;
  appendTransition(runId: string, transition: MigrationRunHistoryEntry): Promise<MigrationRunRecord>;
  updateDigests(runId: string, patch: MigrationDigestPatch): Promise<MigrationRunRecord>;
  archive(runId: string, archivePath: string): Promise<MigrationRunRecord>;
}
