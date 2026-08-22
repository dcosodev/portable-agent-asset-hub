// packages/materializers/src/openclaw/index.ts
//
// Public subpath `@portable-agent-asset-hub/materializers/openclaw` —
// the entry point for the OpenClaw adapter, dispatcher, plugin
// manifest, layout helpers, and config helpers. Keeps the
// renderer-agnostic surface decoupled from the OpenClaw-specific
// wiring.

export {
  openclawAdapter,
  buildOpenclawManifest,
  OPENCLAW_RENDERER_VERSION,
} from './manifest.js';

export { observedManifestDigest } from '../manifest.js';

export {
  renderOpenclawFiles,
  renderOpenclawUser,
  renderOpenclawMemory,
  renderOpenclawSkills,
  renderOpenclawBindings,
  expandOpenclawPath,
  isOpenclawFile,
  OPENCLAW_FILES,
  resolveStateDir,
  defaultStateDirAccessor,
  type OpenclawFileTemplate,
  type ResolveStateDirOptions,
  type StateDirAccessor,
} from './paths.js';

export {
  defaultOpenclawConfig,
  withCapability,
  readOpenclawConfig,
  writeOpenclawConfig,
  configStateDir,
  configPath,
  OPENCLAW_CONFIG_SCHEMA_VERSION,
  CAPABILITY_CAPTURE,
  CAPABILITY_CONTEXT_INJECTION,
  type OpenclawConfig,
  type OpenclawCaptureConfig,
  type OpenclawContextInjectionConfig,
  type OpenclawConfigReadOptions,
} from './config.js';

export {
  openclawPreview,
  openclawApply,
  openclawRollback,
  openclawMaterializerDispatcher,
  type OpenclawMaterializerContext,
  type OpenclawPreviewRequest,
  type OpenclawApplyRequest,
  type OpenclawRollbackRequest,
  type RestDispatcher,
} from './adapter.js';

export {
  buildOpenclawPluginManifest,
  OPENCLAW_PLUGIN_KIND,
  type OpenclawPluginManifest,
  type OpenclawPluginCommand,
  type BuildOpenclawPluginManifestInput,
} from './plugin-manifest.js';