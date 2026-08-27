// packages/core/src/importer/index.ts
//
// Public entry point for the Phase 2 importer contract surface. The
// surface is pure: types, derivations, the high-confidence secret
// scanner and the deterministic mime detector. Any filesystem or
// SQLite access lives in `@portable-agent-asset-hub/storage-files`.

export * from './types.js';
export { deriveLogicalKey, deriveSkillId, normalizeName } from './derivation.js';
export { detectMime, isTextMime, GOVERNED_SEGMENTS, SAFE_RESOURCE_PATH, SKILL_BASENAME, TEXT_MIME_PREFIX } from './mime.js';
export { hasSecretFindings, isPlaceholder, scanBuffer, sha256Hex } from './secret-scan.js';
