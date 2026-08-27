// packages/runtime-adapters/src/claude-code/index.ts
//
// Claude Code harness implementation. The harness-native config file
// is `.mcp.json` (Claude Code MCP servers block); the wrapper is
// `CLAUDE.md`.

import type { DescriptorBody, PreviewInput, Renderer } from '../contracts.js';
import { utf8 } from '../internal/digest.js';
import { assertSafeRelativePath } from '../internal/safe-paths.js';
import { commonWrapperBody, claudeFooter } from '../templates/wrapper.js';
import {
  buildClaudeMcpJsonBody,
  CLAUDE_WRAPPER_RELATIVE_PATH,
} from './implementation.js';

const RENDERER_VERSION = 'runtime-adapters.claude-code/1';

export const claudeCodeRenderer: Renderer = {
  id: 'claude-code',
  rendererVersion: RENDERER_VERSION,
  wrapperRelativePath: CLAUDE_WRAPPER_RELATIVE_PATH,

  renderWrapper(input: PreviewInput): Uint8Array {
    assertSafeRelativePath(CLAUDE_WRAPPER_RELATIVE_PATH);
    const body = commonWrapperBody({ harnessLabel: 'claude-code', profile: input.profile, agentId: input.agentId ?? 'agent_default' })
      + claudeFooter();
    return utf8(body);
  },

  renderUserCopy(userBytes: Uint8Array): Uint8Array {
    return userBytes;
  },

  renderSoulCopy(soulBytes: Uint8Array): Uint8Array {
    return soulBytes;
  },

  renderDescriptor(input: PreviewInput): DescriptorBody {
    return buildClaudeMcpJsonBody(input);
  },
};

export {
  CLAUDE_WRAPPER_RELATIVE_PATH,
  CLAUDE_MCP_JSON_RELATIVE_PATH,
  CLAUDE_USER_RELATIVE_PATH,
  CLAUDE_SOUL_RELATIVE_PATH,
} from './paths.js';

export {
  buildClaudeMcpJsonBody,
  serialiseClaudeMcpJson,
  parseClaudeMcpJson,
  renderClaudeCommandFragments,
} from './implementation.js';
