// packages/runtime-adapters/src/hermes/paths.ts
//
// Hermes layout:
//
//     AGENTS.md                  — wrapper (pointer to the hub)
//     USER.md                    — canonical USER copy (byte-exact)
//     SOUL.md                    — canonical SOUL copy (byte-exact)
//     .hermes/agent-memory.fragment.txt — logical CLI fragment (not
//                                          executed by the apply).

import { assertSafeRelativePath } from '../internal/safe-paths.js';

export const HERMES_WRAPPER_RELATIVE_PATH: string = assertSafeRelativePath('AGENTS.md');
export const HERMES_USER_RELATIVE_PATH: string = assertSafeRelativePath('USER.md');
export const HERMES_SOUL_RELATIVE_PATH: string = assertSafeRelativePath('SOUL.md');
export const HERMES_DESCRIPTOR_RELATIVE_PATH: string = assertSafeRelativePath('.hermes/agent-memory.fragment.txt');
