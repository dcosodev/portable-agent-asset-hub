// packages/runtime-adapters/src/codex/index.ts
//
// Codex harness implementation. The harness-native config file is
// `.codex/config.toml` (Codex CLI MCP servers block); the wrapper is
// `AGENTS.md`.

import type { DescriptorBody, PreviewInput, Renderer } from '../contracts.js';
import { utf8 } from '../internal/digest.js';
import { assertSafeRelativePath } from '../internal/safe-paths.js';
import { commonWrapperBody, codexFooter } from '../templates/wrapper.js';
import {
  buildCodexTomlBody,
  CODEX_WRAPPER_RELATIVE_PATH,
} from './implementation.js';

const RENDERER_VERSION = 'runtime-adapters.codex/1';

export const codexRenderer: Renderer = {
  id: 'codex',
  rendererVersion: RENDERER_VERSION,
  wrapperRelativePath: CODEX_WRAPPER_RELATIVE_PATH,

  renderWrapper(input: PreviewInput): Uint8Array {
    assertSafeRelativePath(CODEX_WRAPPER_RELATIVE_PATH);
    const body = commonWrapperBody({ harnessLabel: 'codex', profile: input.profile, agentId: input.agentId ?? 'agent_default' })
      + codexFooter();
    return utf8(body);
  },

  renderUserCopy(userBytes: Uint8Array): Uint8Array {
    // USER.md is canonically USER.md — we copy byte-for-byte.
    return userBytes;
  },

  renderSoulCopy(soulBytes: Uint8Array): Uint8Array {
    return soulBytes;
  },

  renderDescriptor(input: PreviewInput): DescriptorBody {
    return buildCodexTomlBody(input);
  },
};

export {
  CODEX_WRAPPER_RELATIVE_PATH,
  CODEX_TOML_RELATIVE_PATH,
  CODEX_USER_RELATIVE_PATH,
  CODEX_SOUL_RELATIVE_PATH,
} from './paths.js';

export {
  buildCodexTomlBody,
  serialiseCodexToml,
  renderCodexCommandFragments,
} from './implementation.js';
