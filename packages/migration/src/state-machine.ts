// packages/migration/src/state-machine.ts
//
// Slice 10 normative state machine for migration runs.
//
// States are exported in canonical order so that callers can iterate
// them deterministically (e.g. to render status timelines). LEGAL_TRANSITIONS
// pins the only legal forward hops; any state listed for a given state
// is the set of states that may follow it. `retired` has no legal successor.
//
// The state machine is intentionally linear: each migration run has
// exactly one of these nine states at any time. Cutover/rollback flow
// through them in order; illegal hops throw HUB_ERROR:MIGRATION_ILLEGAL_TRANSITION.

export const MIGRATION_STATES = [
  'exported',
  'validated',
  'import_dry_run',
  'shadowing',
  'replay_verified',
  'cutover_ready',
  'cutover_active',
  'rollback_window',
  'retired',
] as const;

export type MigrationState = (typeof MIGRATION_STATES)[number];

export const DATA_CLASSIFICATIONS = [
  'PUBLIC',
  'INTERNAL',
  'SENSITIVE',
  'SECRET',
] as const;

export type DataClassification = (typeof DATA_CLASSIFICATIONS)[number];

export const SOURCE_ADAPTER_IDS = ['python-v2'] as const;
export type SourceAdapterId = (typeof SOURCE_ADAPTER_IDS)[number];

export const LEGAL_TRANSITIONS: Readonly<Record<MigrationState, readonly MigrationState[]>> = Object.freeze({
  exported: ['validated'],
  validated: ['import_dry_run'],
  import_dry_run: ['shadowing'],
  shadowing: ['replay_verified'],
  replay_verified: ['cutover_ready'],
  cutover_ready: ['cutover_active'],
  cutover_active: ['rollback_window'],
  rollback_window: ['retired'],
  retired: [],
});

export function isMigrationState(value: string): value is MigrationState {
  return (MIGRATION_STATES as readonly string[]).includes(value);
}

export function isLegalTransition(from: MigrationState, to: MigrationState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export function assertLegalTransition(from: MigrationState, to: MigrationState): void {
  if (!isLegalTransition(from, to)) {
    throw illegalTransitionError(from, to);
  }
}

export function illegalTransitionError(from: MigrationState, to: MigrationState): Error {
  const err = new Error(
    `HUB_ERROR:MIGRATION_ILLEGAL_TRANSITION: cannot transition from ${from} to ${to}`,
  ) as Error & { code: string };
  err.code = 'MIGRATION_ILLEGAL_TRANSITION';
  return err;
}
