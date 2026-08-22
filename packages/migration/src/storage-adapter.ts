// packages/migration/src/storage-adapter.ts
//
// Slice 10 storage adapter / port bridge.
//
// `createMigrationService` (and the rest of the migration factories
// — shadow/replay/cutover/rollback/retirement/import) consume the
// narrow `MigrationStorage` port defined in `./storage.ts`. Tests in
// the Slice 10 contract suite satisfy it with an in-memory stub; the
// end-to-end lifecycle test, however, passes the canonical
// `@portable-agent-asset-hub/storage-sqlite` `SqliteStore`, which
// implements the broader `Storage` transaction contract from core —
// it has no `create` / `get` / `list` / `appendTransition` /
// `updateDigests` / `archive` methods.
//
// This module bridges the gap. Given any object, it returns a
// `MigrationStorage`:
//
//   * If the input already exposes the six port methods, it is
//     returned as-is (this is what the unit tests expect — see
//     `tests/s10-migration.test.ts`).
//   * Otherwise, the input is treated as opaque (it typically is a
//     `SqliteStore` carrying the canonical hub database) and is
//     wrapped in an in-memory `MigrationStorage` sidecar that owns
//     run records, history, digests, and archive paths for the
//     lifetime of the migration service.
//
// The sidecar is strictly process-local — it does NOT open another
// SQLite database, it does NOT touch the canonical hub's
// harness-state database, it does NOT write migration runs into the
// canonical hub tables. That keeps the canonical storage contract
// untouched (S0–S9) and keeps the
// migration package usable in a hermetic test environment where
// writing migration-run rows into the hub would be a layering
// violation. The sidecar's purpose is to carry the migration
// lifecycle state for the duration of a single run, which is exactly
// the boundary the Slice 10 spec carves out for it.

import type {
  MigrationDigestPatch,
  MigrationRunCreate,
  MigrationRunHistoryEntry,
  MigrationRunRecord,
  MigrationStorage,
} from './storage.js';

const PORT_METHODS = [
  'create',
  'get',
  'list',
  'appendTransition',
  'updateDigests',
  'archive',
] as const satisfies readonly (keyof MigrationStorage)[];

const isMigrationStorageLike = (value: unknown): value is MigrationStorage => {
  if (!value || typeof value !== 'object') return false;
  for (const method of PORT_METHODS) {
    if (typeof (value as Record<string, unknown>)[method] !== 'function') {
      return false;
    }
  }
  return true;
};

type SidecarOptions = {
  idPrefix?: string;
};

const createInMemorySidecar = (options: SidecarOptions = {}): MigrationStorage => {
  const runs = new Map<string, MigrationRunRecord>();
  let seq = 0;
  const idPrefix = options.idPrefix ?? 'mig';
  const nextId = (): string => {
    seq += 1;
    return `${idPrefix}_${seq.toString().padStart(8, '0')}`;
  };

  return {
    async create(input: MigrationRunCreate): Promise<MigrationRunRecord> {
      const runId = nextId();
      const now = new Date().toISOString();
      const initialEntry: MigrationRunHistoryEntry = {
        fromState: null,
        toState: input.initialState,
        actor: input.actor ?? null,
        reason: input.reason,
        requestId: input.requestId,
        timestamp: now,
        status: 'ok',
        result: null,
      };
      const record: MigrationRunRecord = {
        runId,
        adapterId: input.adapterId,
        scope: input.scope,
        reason: input.reason,
        requestId: input.requestId,
        state: input.initialState,
        sourceDigest: null,
        targetDigest: null,
        manifestDigest: null,
        archivePath: null,
        metadata: input.metadata ?? {},
        history: [initialEntry],
        createdAt: now,
        updatedAt: now,
      };
      runs.set(runId, record);
      return record;
    },

    async get(runId: string): Promise<MigrationRunRecord> {
      const record = runs.get(runId);
      if (!record) {
        throw new Error(`migration run ${runId} not found`);
      }
      return record;
    },

    async list(): Promise<MigrationRunRecord[]> {
      return [...runs.values()];
    },

    async appendTransition(
      runId: string,
      transition: MigrationRunHistoryEntry,
    ): Promise<MigrationRunRecord> {
      const record = runs.get(runId);
      if (!record) {
        throw new Error(`migration run ${runId} not found`);
      }
      record.history.push(transition);
      // The transition entry's `toState` is the new authoritative
      // state — except for read-audit entries (where fromState ===
      // toState === current.state), in which case the state stays
      // the same. Either way, syncing state to `toState` is correct
      // because read-audit entries carry `toState === current.state`.
      record.state = transition.toState;
      record.updatedAt = new Date().toISOString();
      return record;
    },

    async updateDigests(
      runId: string,
      patch: MigrationDigestPatch,
    ): Promise<MigrationRunRecord> {
      const record = runs.get(runId);
      if (!record) {
        throw new Error(`migration run ${runId} not found`);
      }
      if (patch.sourceDigest !== undefined) record.sourceDigest = patch.sourceDigest;
      if (patch.targetDigest !== undefined) record.targetDigest = patch.targetDigest;
      if (patch.manifestDigest !== undefined) record.manifestDigest = patch.manifestDigest;
      record.updatedAt = new Date().toISOString();
      return record;
    },

    async archive(runId: string, archivePath: string): Promise<MigrationRunRecord> {
      const record = runs.get(runId);
      if (!record) {
        throw new Error(`migration run ${runId} not found`);
      }
      record.archivePath = archivePath;
      record.updatedAt = new Date().toISOString();
      return record;
    },
  };
};

/**
 * Adapt any storage-like object into a `MigrationStorage`.
 *
 * - If `input` already implements the six MigrationStorage methods,
 *   it is returned as-is (no wrapping, no extra allocation). This
 *   preserves the contract suite's existing behaviour where unit
 *   tests inject a hand-rolled in-memory stub.
 * - Otherwise `input` is treated as opaque (typically a SqliteStore
 *   bound to the canonical hub database) and is paired with an
 *   in-memory sidecar that owns migration-run state for the
 *   lifetime of the call. The canonical storage is left untouched —
 *   no new SQLite file, no migration-run rows in the hub tables.
 *
 * Sidecars are deduplicated per opaque input via a `WeakMap`. Each
 * `SqliteStore` instance (or any other non-port object) gets its
 * own sidecar; all factories created against the same input share
 * it. This keeps run records visible across the full lifecycle
 * (begin → transition → shadow → replay → cutover → rollback →
 * retirement → get) when callers construct one service per phase
 * from the same underlying storage, which is the natural usage
 * pattern (and the pattern used by the Slice 10 E2E).
 *
 * The returned object satisfies `MigrationStorage`; it is safe to
 * pass to `createMigrationService` and the rest of the Slice 10
 * factories.
 */
const sidecars = new WeakMap<object, MigrationStorage>();

export const adaptMigrationStorage = (
  input: unknown,
  options: SidecarOptions = {},
): MigrationStorage => {
  if (isMigrationStorageLike(input)) return input;
  if (input && typeof input === 'object') {
    const cached = sidecars.get(input);
    if (cached) return cached;
    const fresh = createInMemorySidecar(options);
    sidecars.set(input, fresh);
    return fresh;
  }
  return createInMemorySidecar(options);
};