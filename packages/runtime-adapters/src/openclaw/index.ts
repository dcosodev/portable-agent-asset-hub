// packages/runtime-adapters/src/openclaw/index.ts
//
// OpenClaw harness implementation. The wrapper is `MEMORY.md`
// (OpenClaw's native memory pointer file); the MCP descriptor is a
// logical `openclaw mcp set` JSON fragment the operator pastes into
// the OpenClaw CLI. The apply never executes the fragment.

import type { DescriptorBody, PreviewInput, Renderer } from '../contracts.js';
import { utf8 } from '../internal/digest.js';
import { assertSafeRelativePath } from '../internal/safe-paths.js';
import { commonWrapperBody, openclawFooter } from '../templates/wrapper.js';
import {
  buildOpenclawFragment,
  OPENCLAW_WRAPPER_RELATIVE_PATH,
} from './implementation.js';

const RENDERER_VERSION = 'runtime-adapters.openclaw/1';

export const openclawRenderer: Renderer = {
  id: 'openclaw',
  rendererVersion: RENDERER_VERSION,
  wrapperRelativePath: OPENCLAW_WRAPPER_RELATIVE_PATH,

  renderWrapper(input: PreviewInput): Uint8Array {
    assertSafeRelativePath(OPENCLAW_WRAPPER_RELATIVE_PATH);
    const body = commonWrapperBody({ harnessLabel: 'openclaw', profile: input.profile, agentId: input.agentId ?? 'agent_default' })
      + openclawFooter();
    return utf8(body);
  },

  renderUserCopy(userBytes: Uint8Array): Uint8Array {
    return userBytes;
  },

  renderSoulCopy(soulBytes: Uint8Array): Uint8Array {
    return soulBytes;
  },

  renderDescriptor(input: PreviewInput): DescriptorBody {
    return buildOpenclawFragment(input);
  },
};

export {
  OPENCLAW_WRAPPER_RELATIVE_PATH,
  OPENCLAW_FRAGMENT_RELATIVE_PATH,
  OPENCLAW_USER_RELATIVE_PATH,
  OPENCLAW_SOUL_RELATIVE_PATH,
} from './paths.js';

export {
  buildOpenclawFragment,
  serialiseOpenclawFragment,
  parseOpenclawFragment,
  renderOpenclawCommandFragments,
} from './implementation.js';
