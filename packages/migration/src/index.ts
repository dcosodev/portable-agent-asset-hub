// packages/migration/src/index.ts
//
// Slice 10 migration package public surface.
//
// Every export listed here is part of the normative contract. Adding
// or renaming exports requires a Slice 11 spec bump. The surface is
// intentionally flat: callers reach the state-machine, the classifier,
// the redactor, the storage port, and one factory per service
// (export/import/shadow/replay/cutover/rollback/retirement).

export {
  MIGRATION_STATES,
  DATA_CLASSIFICATIONS,
  SOURCE_ADAPTER_IDS,
  LEGAL_TRANSITIONS,
  isMigrationState,
  isLegalTransition,
  assertLegalTransition,
  illegalTransitionError,
} from './state-machine.js';

export type { MigrationState, DataClassification, SourceAdapterId } from './state-machine.js';

export { classifyFields, isSecretKey } from './classifier.js';
export type { ClassifiedValue } from './classifier.js';

export { redactPayload, REDACTED_VALUE, classifyAndRedact } from './redactor.js';

export type {
  MigrationStorage,
  MigrationRunRecord,
  MigrationRunHistoryEntry,
  MigrationRunCreate,
  MigrationDigestPatch,
} from './storage.js';

export { adaptMigrationStorage } from './storage-adapter.js';

export { createExportService } from './exporter.js';
export type { ExportService, ExportServiceConfig, ExportResult, ExportManifest, ExportFileEntry } from './exporter.js';

export { createImportService } from './importer.js';
export type { ImportService, ImportServiceConfig, ImportDryRunResult } from './importer.js';

export { createShadowService } from './shadow.js';
export type {
  ShadowService,
  ShadowServiceConfig,
  ShadowRunView,
  ShadowObservation,
} from './shadow.js';

export { createReplayService } from './replay.js';
export type { ReplayService, ReplayServiceConfig } from './replay.js';

export { createCutoverService } from './cutover.js';
export type { CutoverService, CutoverServiceConfig } from './cutover.js';

export { createRollbackService } from './rollback.js';
export type { RollbackService, RollbackServiceConfig } from './rollback.js';

export { createRetirementService } from './retirement.js';
export type { RetirementService, RetirementServiceConfig } from './retirement.js';

export { createMigrationService } from './service.js';
export type { MigrationService, MigrationServiceConfig } from './service.js';

export type { SourceAdapter, SourceRows, SourceRow } from './source.js';

export { createPythonV2SourceAdapter } from './adapters/python.js';
export type { PythonV2SourceAdapter, PythonV2AdapterConfig } from './adapters/python.js';
