// packages/runtime-adapters/src/opencode/index.ts
//
// OpenCode harness implementation. The harness-native config file is
// `opencode.json` at the agent root; the wrapper is `AGENTS.md`.

import type { DescriptorBody, PreviewInput, Renderer } from '../contracts.js';
import { utf8 } from '../internal/digest.js';
import { assertSafeRelativePath } from '../internal/safe-paths.js';
import { commonWrapperBody, opencodeFooter } from '../templates/wrapper.js';
import {
  buildOpenCodeJsonBody,
  OPENCODE_WRAPPER_RELATIVE_PATH,
} from './implementation.js';

const RENDERER_VERSION = 'runtime-adapters.opencode/1';

export const opencodeRenderer: Renderer = {
  id: 'opencode',
  rendererVersion: RENDERER_VERSION,
  wrapperRelativePath: OPENCODE_WRAPPER_RELATIVE_PATH,

  renderWrapper(input: PreviewInput): Uint8Array {
    assertSafeRelativePath(OPENCODE_WRAPPER_RELATIVE_PATH);
    const body = commonWrapperBody({ harnessLabel: 'opencode', profile: input.profile, agentId: input.agentId ?? 'agent_default' })
      + opencodeFooter();
    return utf8(body);
  },

  renderUserCopy(userBytes: Uint8Array): Uint8Array {
    return userBytes;
  },

  renderSoulCopy(soulBytes: Uint8Array): Uint8Array {
    return soulBytes;
  },

  renderDescriptor(input: PreviewInput): DescriptorBody {
    return buildOpenCodeJsonBody(input);
  },
};

export {
  OPENCODE_WRAPPER_RELATIVE_PATH,
  OPENCODE_OPENCODE_JSON_RELATIVE_PATH,
  OPENCODE_USER_RELATIVE_PATH,
  OPENCODE_SOUL_RELATIVE_PATH,
} from './paths.js';

export {
  buildOpenCodeJsonBody,
  serialiseOpenCodeJson,
  renderOpenCodeCommandFragments,
} from './implementation.js';
