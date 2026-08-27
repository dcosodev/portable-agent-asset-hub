// packages/runtime-adapters/src/hermes/index.ts
//
// Hermes harness implementation. The wrapper is `AGENTS.md`; the
// MCP descriptor is a logical `hermes mcp add ...` command fragment
// the operator pastes into the Hermes CLI. The apply never executes
// the fragment.

import type { DescriptorBody, PreviewInput, Renderer } from '../contracts.js';
import { utf8 } from '../internal/digest.js';
import { assertSafeRelativePath } from '../internal/safe-paths.js';
import { commonWrapperBody, hermesFooter } from '../templates/wrapper.js';
import {
  buildHermesCommandFragment,
  HERMES_WRAPPER_RELATIVE_PATH,
} from './implementation.js';

const RENDERER_VERSION = 'runtime-adapters.hermes/1';

export const hermesRenderer: Renderer = {
  id: 'hermes',
  rendererVersion: RENDERER_VERSION,
  wrapperRelativePath: HERMES_WRAPPER_RELATIVE_PATH,

  renderWrapper(input: PreviewInput): Uint8Array {
    assertSafeRelativePath(HERMES_WRAPPER_RELATIVE_PATH);
    const body = commonWrapperBody({ harnessLabel: 'hermes', profile: input.profile, agentId: input.agentId ?? 'agent_default' })
      + hermesFooter();
    return utf8(body);
  },

  renderUserCopy(userBytes: Uint8Array): Uint8Array {
    return userBytes;
  },

  renderSoulCopy(soulBytes: Uint8Array): Uint8Array {
    return soulBytes;
  },

  renderDescriptor(input: PreviewInput): DescriptorBody {
    return buildHermesCommandFragment(input);
  },
};

export {
  HERMES_WRAPPER_RELATIVE_PATH,
  HERMES_DESCRIPTOR_RELATIVE_PATH,
  HERMES_USER_RELATIVE_PATH,
  HERMES_SOUL_RELATIVE_PATH,
} from './paths.js';

export {
  buildHermesCommandFragment,
  serialiseHermesCommandFragment,
  parseHermesCommandFragment,
  renderHermesCommandFragments,
} from './implementation.js';
