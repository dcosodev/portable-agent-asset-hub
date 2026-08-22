// packages/materializers/src/index.ts
//
// Renderer-agnostic public surface for the S8 materializer. Every
// renderer (hermes, openclaw) and every consumer (REST, MCP, SDKs)
// imports from this entry point. Slice 9 (OpenClaw) reuses the same
// apply/rollback pipeline by swapping the renderer adapter; this
// index never changes for that swap.
//
// Re-export strategy: explicit `export {}` for each symbol so the
// public surface is greppable and survives accidental renames in the
// underlying modules. `export *` would be equivalent for value
// exports, but explicit exports also surface the type-only re-exports
// without dragging in `import type` noise.

export type {
  HarnessId,
  SourceRef,
  ManifestFile,
  ManifestV1,
  PreviewInput,
  PreviewResult,
  ApplyInput,
  ApplyResult,
  RollbackInput,
  RollbackResult,
  RenderResult,
  RendererAdapter,
  MaterializerDeps,
} from './contracts.js';

export {
  buildMaterializationPlan,
  canonicalizeManifest,
  digestPlan,
  readManifestFromDisk,
  observedManifestDigest,
  assertSafeRelativePath,
} from './manifest.js';

export {
  acquireLock,
  releaseLock,
  readLock,
  type LockHandle,
} from './locks.js';

export {
  assertSafeTargetRoot,
  registerAdapter,
  getAdapter,
  computePreview,
} from './preview.js';

export { applyPlan } from './apply.js';

export { rollbackPlan, restoreFromBackup } from './rollback.js';

export {
  registerRun,
  lookupRun,
  forgetRun,
  type RunRecord,
} from './registry.js';
