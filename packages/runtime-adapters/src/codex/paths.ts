// packages/runtime-adapters/src/codex/paths.ts
//
// Codex harness layout. Every renderer owns exactly one file per
// layer; the apply pipeline writes them at their relative paths.
//
//     AGENTS.md                     — wrapper (pointer to the hub)
//     USER.md                       — canonical USER copy (byte-exact)
//     SOUL.md                       — canonical SOUL copy (byte-exact)
//     .codex/config.toml            — Codex MCP servers descriptor

import { assertSafeRelativePath } from '../internal/safe-paths.js';

const CODEX_WRAPPER_RELATIVE_PATH_RAW = 'AGENTS.md';
const CODEX_USER_RELATIVE_PATH_RAW = 'USER.md';
const COUX_SOUL_RELATIVE_PATH_RAW = 'SOUL.md';
const CODEX_TOML_RELATIVE_PATH_RAW = '.codex/config.toml';

export const CODEX_WRAPPER_RELATIVE_PATH: string = assertSafeRelativePath(CODEX_WRAPPER_RELATIVE_PATH_RAW);
export const CODEX_USER_RELATIVE_PATH: string = assertSafeRelativePath(CODEX_USER_RELATIVE_PATH_RAW);
export const CODEX_SOUL_RELATIVE_PATH: string = assertSafeRelativePath(COUX_SOUL_RELATIVE_PATH_RAW);
export const CODEX_TOML_RELATIVE_PATH: string = assertSafeRelativePath(CODEX_TOML_RELATIVE_PATH_RAW);
