// packages/runtime-adapters/src/openclaw/implementation.ts
//
// OpenClaw MCP descriptor is a logical CLI fragment shaped like the
// JSON payload accepted by `openclaw mcp set --server <path>`:
//
//     {
//       "command": "node",
//       "args": ["<mcpEntry>"],
//       "env": {
//         "AGENT_MEMORY_REST_URL": "<restUrl>",
//         "AGENT_MEMORY_CAPABILITIES": "read,write.memory,skill.read,skill.resource.read"
//       }
//     }
//
// The apply writes the deterministic JSON fragment into
// `.openclaw/agent-memory.fragment.json`. The apply never executes
// it; the operator pastes it once into the OpenClaw CLI.

import type { CommandFragment, DescriptorBody, OpenclawMcpServer, PreviewInput } from '../contracts.js';
import { canonicalise, utf8 } from '../internal/digest.js';

export const OPENCLAW_WRAPPER_RELATIVE_PATH = 'MEMORY.md';
export const OPENCLAW_FRAGMENT_RELATIVE_PATH = '.openclaw/agent-memory.fragment.json';

const OPENCLAW_CAPABILITIES = 'read,write.memory,skill.read,skill.resource.read';

export function buildOpenclawFragment(input: PreviewInput): DescriptorBody {
  const server: OpenclawMcpServer = {
    command: 'node',
    args: [input.mcpEntry],
    env: {
      AGENT_MEMORY_REST_URL: input.restUrl,
      AGENT_MEMORY_CAPABILITIES: OPENCLAW_CAPABILITIES,
      ...(input.authTokenFile ? { AGENT_MEMORY_AUTH_TOKEN_FILE: input.authTokenFile } : {}),
    },
  };
  return { kind: 'openclaw-mcp-fragment', server };
}

export function renderOpenclawCommandFragments(input: PreviewInput): readonly CommandFragment[] {
  const body = buildOpenclawFragment(input);
  if (body.kind !== 'openclaw-mcp-fragment') throw new Error('openclaw descriptor kind mismatch');
  const env = body.server.env;
  const value = canonicalise({ command: body.server.command, args: [...body.server.args], env: body.server.env });
  return [{ label: 'openclaw-mcp-set', argv: ['openclaw', 'mcp', 'set', 'agent-memory', value], env }];
}

export function serialiseOpenclawFragment(body: Extract<DescriptorBody, { kind: 'openclaw-mcp-fragment' }>): string {
  const out = {
    command: body.server.command,
    args: [...body.server.args],
    env: Object.fromEntries(Object.keys(body.server.env).sort().map((key) => [key, body.server.env[key]!])),
  };
  return canonicalise(out) + '\n';
}

export function parseOpenclawFragment(bytes: Uint8Array): { command: string; args: string[]; env: Record<string, string> } {
  const text = new TextDecoder('utf-8').decode(bytes);
  return JSON.parse(text) as { command: string; args: string[]; env: Record<string, string> };
}

export function utf8OpenclawFragment(body: Extract<DescriptorBody, { kind: 'openclaw-mcp-fragment' }>): Uint8Array {
  return utf8(serialiseOpenclawFragment(body));
}
