// packages/runtime-adapters/src/opencode/paths.ts
//
// OpenCode layout:
//
//     AGENTS.md                  — wrapper (pointer to the hub)
//     USER.md                    — canonical USER copy (byte-exact)
//     SOUL.md                    — canonical SOUL copy (byte-exact)
//     opencode.json              — OpenCode MCP servers descriptor

import { assertSafeRelativePath } from '../internal/safe-paths.js';

export const OPENCODE_WRAPPER_RELATIVE_PATH: string = assertSafeRelativePath('AGENTS.md');
export const OPENCODE_USER_RELATIVE_PATH: string = assertSafeRelativePath('USER.md');
export const OPENCODE_SOUL_RELATIVE_PATH: string = assertSafeRelativePath('SOUL.md');
export const OPENCODE_OPENCODE_JSON_RELATIVE_PATH: string = assertSafeRelativePath('opencode.json');
