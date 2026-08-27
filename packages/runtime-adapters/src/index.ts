// packages/runtime-adapters/src/index.ts
//
// Public surface for the `@portable-agent-asset-hub/runtime-adapters`
// package. External callers — `scripts/attach-agent-hub.mjs`,
// `tests/runtime-adapters/*`, future REST/MCP wrappers — import
// only the named exports declared here. Internal modules are not
// part of the contract and may change without notice.

export type {
  AdapterLogicalIds,
  ApplyInput,
  ApplyResult,
  ClaudeMcpServer,
  CodeTomlSection,
  CommandFragment,
  DescriptorBody,
  DescriptorPreview,
  HarnessId,
  OpenCodeMcpServer,
  OpenclawMcpServer,
  PlanDigest,
  PlanFile,
  Preview,
  PreviewInput,
  Renderer,
  RollbackInput,
  RollbackResult,
} from './contracts.js';

export { HARNESS_IDS } from './contracts.js';

export { computePreview } from './preview.js';
export { applyPlan, rollbackPlan, deriveRunId, readRegistry } from './apply.js';
export { RENDERERS, getRenderer, listRenderers } from './registry.js';

export {
  CODEX_WRAPPER_RELATIVE_PATH as RUNTIME_ADAPTERS_CODEX_WRAPPER,
  CODEX_TOML_RELATIVE_PATH as RUNTIME_ADAPTERS_CODEX_DESCRIPTOR,
  CODEX_USER_RELATIVE_PATH as RUNTIME_ADAPTERS_CODEX_USER,
  CODEX_SOUL_RELATIVE_PATH as RUNTIME_ADAPTERS_CODEX_SOUL,
  codexRenderer as codexHarnessRenderer,
  serialiseCodexToml,
} from './codex/index.js';

export {
  CLAUDE_WRAPPER_RELATIVE_PATH as RUNTIME_ADAPTERS_CLAUDE_WRAPPER,
  CLAUDE_MCP_JSON_RELATIVE_PATH as RUNTIME_ADAPTERS_CLAUDE_DESCRIPTOR,
  CLAUDE_USER_RELATIVE_PATH as RUNTIME_ADAPTERS_CLAUDE_USER,
  CLAUDE_SOUL_RELATIVE_PATH as RUNTIME_ADAPTERS_CLAUDE_SOUL,
  claudeCodeRenderer as claudeCodeHarnessRenderer,
  serialiseClaudeMcpJson,
  parseClaudeMcpJson,
} from './claude-code/index.js';

export {
  OPENCODE_WRAPPER_RELATIVE_PATH as RUNTIME_ADAPTERS_OPENCODE_WRAPPER,
  OPENCODE_OPENCODE_JSON_RELATIVE_PATH as RUNTIME_ADAPTERS_OPENCODE_DESCRIPTOR,
  OPENCODE_USER_RELATIVE_PATH as RUNTIME_ADAPTERS_OPENCODE_USER,
  OPENCODE_SOUL_RELATIVE_PATH as RUNTIME_ADAPTERS_OPENCODE_SOUL,
  opencodeRenderer as opencodeHarnessRenderer,
  serialiseOpenCodeJson,
} from './opencode/index.js';

export {
  HERMES_WRAPPER_RELATIVE_PATH as RUNTIME_ADAPTERS_HERMES_WRAPPER,
  HERMES_DESCRIPTOR_RELATIVE_PATH as RUNTIME_ADAPTERS_HERMES_DESCRIPTOR,
  HERMES_USER_RELATIVE_PATH as RUNTIME_ADAPTERS_HERMES_USER,
  HERMES_SOUL_RELATIVE_PATH as RUNTIME_ADAPTERS_HERMES_SOUL,
  hermesRenderer as hermesHarnessRenderer,
  serialiseHermesCommandFragment,
  parseHermesCommandFragment,
} from './hermes/index.js';

export {
  OPENCLAW_WRAPPER_RELATIVE_PATH as RUNTIME_ADAPTERS_OPENCLAW_WRAPPER,
  OPENCLAW_FRAGMENT_RELATIVE_PATH as RUNTIME_ADAPTERS_OPENCLAW_DESCRIPTOR,
  OPENCLAW_USER_RELATIVE_PATH as RUNTIME_ADAPTERS_OPENCLAW_USER,
  OPENCLAW_SOUL_RELATIVE_PATH as RUNTIME_ADAPTERS_OPENCLAW_SOUL,
  openclawRenderer as openclawHarnessRenderer,
  serialiseOpenclawFragment,
  parseOpenclawFragment,
} from './openclaw/index.js';

export type { ReadonlyDeep } from './internal/deep-readonly.js';
export { SafePathError } from './internal/safe-paths.js';
export { SafeTargetError } from './internal/safe-target.js';
