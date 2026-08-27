// packages/runtime-adapters/src/claude-code/paths.ts
//
// Claude Code layout:
//
//     CLAUDE.md                 — wrapper (pointer to the hub)
//     USER.md                   — canonical USER copy (byte-exact)
//     SOUL.md                   — canonical SOUL copy (byte-exact)
//     .mcp.json                 — Claude Code MCP servers descriptor

import { assertSafeRelativePath } from '../internal/safe-paths.js';

export const CLAUDE_WRAPPER_RELATIVE_PATH: string = assertSafeRelativePath('CLAUDE.md');
export const CLAUDE_USER_RELATIVE_PATH: string = assertSafeRelativePath('USER.md');
export const CLAUDE_SOUL_RELATIVE_PATH: string = assertSafeRelativePath('SOUL.md');
export const CLAUDE_MCP_JSON_RELATIVE_PATH: string = assertSafeRelativePath('.mcp.json');
