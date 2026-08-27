// packages/runtime-adapters/src/opencode/implementation.ts
//
// OpenCode MCP descriptor. The shape is per OpenCode's published
// config (`mcp.<name>.type=local`, `mcp.<name>.command=[...]`,
// `mcp.<name>.environment={...}`). We emit exactly one entry named
// `agent-memory`.

import type {
  CommandFragment,
  DescriptorBody,
  OpenCodeMcpServer,
  PreviewInput,
} from '../contracts.js';
import { canonicalise, utf8 } from '../internal/digest.js';

export const OPENCODE_WRAPPER_RELATIVE_PATH = 'AGENTS.md';
export const OPENCODE_OPENCODE_JSON_RELATIVE_PATH = 'opencode.json';

export function buildOpenCodeJsonBody(input: PreviewInput): DescriptorBody {
  const server: OpenCodeMcpServer = {
    name: 'agent-memory',
    type: 'local',
    command: ['node', input.mcpEntry],
    environment: {
      AGENT_MEMORY_REST_URL: input.restUrl,
      AGENT_MEMORY_CAPABILITIES: 'read,write.memory,skill.read,skill.resource.read',
      ...(input.authTokenFile ? { AGENT_MEMORY_AUTH_TOKEN_FILE: input.authTokenFile } : {}),
    },
    enabled: true,
  };
  return { kind: 'opencode-opencode-json', mcp: [server] };
}

export function renderOpenCodeCommandFragments(input: PreviewInput): readonly CommandFragment[] {
  return [
    {
      label: 'opencode-config-add',
      argv: ['opencode', 'config', 'add', `mcp.agent-memory.command[0]=node`, `mcp.agent-memory.command[1]=${input.mcpEntry}`],
      env: { AGENT_MEMORY_REST_URL: input.restUrl, AGENT_MEMORY_CAPABILITIES: 'read,write.memory,skill.read,skill.resource.read' },
    },
  ];
}

export function serialiseOpenCodeJson(body: Extract<DescriptorBody, { kind: 'opencode-opencode-json' }>): string {
  const out = {
    $schema: 'https://opencode.ai/config.json',
    mcp: Object.fromEntries(
      body.mcp.map((server) => [server.name, {
        type: server.type,
        command: [...server.command],
        environment: { ...server.environment },
        enabled: server.enabled,
      }]),
    ),
  };
  return canonicalise(out) + '\n';
}

export function utf8Body(body: Extract<DescriptorBody, { kind: 'opencode-opencode-json' }>): Uint8Array {
  return utf8(serialiseOpenCodeJson(body));
}
