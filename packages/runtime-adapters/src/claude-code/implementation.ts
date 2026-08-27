// packages/runtime-adapters/src/claude-code/implementation.ts
//
// Claude Code `.mcp.json` descriptor. The file is a JSON object with
// a single `mcpServers` key. We declare one server named
// `agent-memory`; the operator may register more if desired. The
// file layout is parsed and re-serialised by Claude Code so the
// exact byte stream we emit is not part of the contract — the *JSON
// shape* is.

import type {
  ClaudeMcpServer,
  CommandFragment,
  DescriptorBody,
  PreviewInput,
} from '../contracts.js';
import { canonicalise, fromBytes, utf8 } from '../internal/digest.js';

export const CLAUDE_WRAPPER_RELATIVE_PATH = 'CLAUDE.md';
export const CLAUDE_MCP_JSON_RELATIVE_PATH = '.mcp.json';

export function buildClaudeMcpJsonBody(input: PreviewInput): DescriptorBody {
  const server: ClaudeMcpServer = {
    name: 'agent-memory',
    command: 'node',
    args: [input.mcpEntry],
    env: {
      AGENT_MEMORY_REST_URL: input.restUrl,
      AGENT_MEMORY_CAPABILITIES: 'read,write.memory,skill.read,skill.resource.read',
      ...(input.authTokenFile ? { AGENT_MEMORY_AUTH_TOKEN_FILE: input.authTokenFile } : {}),
    },
  };
  return { kind: 'claude-code-mcp-json', servers: [server] };
}

export function renderClaudeCommandFragments(input: PreviewInput): readonly CommandFragment[] {
  return [
    {
      label: 'claude-mcp-add',
      argv: ['claude', 'mcp', 'add', '--transport', 'stdio', '--env', `AGENT_MEMORY_REST_URL=${input.restUrl}`, '--env', 'AGENT_MEMORY_CAPABILITIES=read,write.memory,skill.read,skill.resource.read', 'agent-memory', '--', 'node', input.mcpEntry],
      env: { AGENT_MEMORY_REST_URL: input.restUrl, AGENT_MEMORY_CAPABILITIES: 'read,write.memory,skill.read,skill.resource.read' },
    },
  ];
}

/**
 * Deterministic JSON serialiser. The bytes include a single trailing
 * newline so the file is grep-friendly; two calls with the same
 * `body` produce the same bytes.
 */
export function serialiseClaudeMcpJson(body: Extract<DescriptorBody, { kind: 'claude-code-mcp-json' }>): string {
  const obj = {
    mcpServers: Object.fromEntries(
      body.servers.map((server) => [server.name, {
        command: server.command,
        args: [...server.args],
        env: { ...server.env },
        transport: 'stdio',
      }]),
    ),
  };
  return canonicalise(obj) + '\n';
}

/** Parse-side helper used by the TOML/JSON parse test. */
export function parseClaudeMcpJson(bytes: Uint8Array): { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string>; transport: string }> } {
  const text = fromBytes(bytes);
  return JSON.parse(text) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string>; transport: string }> };
}

export function utf8Body(body: Extract<DescriptorBody, { kind: 'claude-code-mcp-json' }>): Uint8Array {
  return utf8(serialiseClaudeMcpJson(body));
}
