// packages/runtime-adapters/src/openclaw/paths.ts
//
// OpenClaw layout:
//
//     MEMORY.md                  — wrapper (OpenClaw's native pointer)
//     USER.md                    — canonical USER copy (byte-exact)
//     SOUL.md                    — canonical SOUL copy (byte-exact)
//     .openclaw/agent-memory.fragment.json — logical CLI fragment
//                                            (not executed by the apply).

import { assertSafeRelativePath } from '../internal/safe-paths.js';

export const OPENCLAW_WRAPPER_RELATIVE_PATH: string = assertSafeRelativePath('MEMORY.md');
export const OPENCLAW_USER_RELATIVE_PATH: string = assertSafeRelativePath('USER.md');
export const OPENCLAW_SOUL_RELATIVE_PATH: string = assertSafeRelativePath('SOUL.md');
export const OPENCLAW_FRAGMENT_RELATIVE_PATH: string = assertSafeRelativePath('.openclaw/agent-memory.fragment.json');
