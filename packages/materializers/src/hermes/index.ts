// packages/materializers/src/hermes/index.ts
//
// Public subpath `@portable-agent-asset-hub/materializers/hermes` —
// the entry point for the Hermes adapter and dispatcher. Keeps the
// renderer-agnostic surface (`packages/materializers/src/index.ts`)
// decoupled from the Hermes-specific apply wiring.

export { hermesAdapter, buildHermesManifest, HERMES_RENDERER_VERSION, digestManifestBytes } from './manifest.js';
export { renderHermesFiles, renderHermesUser, renderHermesMemory, renderHermesSkill, HERMES_FILES, isHermesFile } from './paths.js';
export {
  hermesPreview,
  hermesApply,
  hermesRollback,
  hermesMaterializerDispatcher,
  type HermesMaterializerContext,
  type HermesPreviewRequest,
  type HermesApplyRequest,
  type HermesRollbackRequest,
  type RestDispatcher,
} from './adapter.js';
