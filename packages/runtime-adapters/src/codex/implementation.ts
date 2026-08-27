// packages/runtime-adapters/src/codex/implementation.ts
//
// Codex-specific implementation: the TOML descriptor and the
// command fragments the operator can paste into the Codex CLI.
//
// `buildCodexTomlBody` returns the bytes for `.codex/config.toml`
// — a deterministic TOML fragment declaring one MCP server
// (`agent-memory`) bound to the canonical stdio entry, with the
// REST URL and capability list passed through environment
// variables.
//
// `renderCodexCommandFragments` returns the `codex mcp add ...`
// command shape the operator would run to register the server
// out-of-band. We never execute it.

import type {
  CodeTomlSection,
  CommandFragment,
  DescriptorBody,
  PreviewInput,
} from '../contracts.js';


export const CODEX_WRAPPER_RELATIVE_PATH = 'AGENTS.md';
export const CODEX_TOML_RELATIVE_PATH = '.codex/config.toml';

export function buildCodexTomlBody(input: PreviewInput): DescriptorBody {
  const sections: CodeTomlSection[] = [
    { key: 'command', value: quoteTomlString('node') },
    { key: 'args', value: JSON.stringify([input.mcpEntry]) },
    { key: 'enabled', value: 'true' },
    {
      key: 'env',
      value: `{ AGENT_MEMORY_REST_URL = ${quoteTomlString(input.restUrl)}, AGENT_MEMORY_CAPABILITIES = ${quoteTomlString('read,write.memory,skill.read,skill.resource.read')}${input.authTokenFile ? `, AGENT_MEMORY_AUTH_TOKEN_FILE = ${quoteTomlString(input.authTokenFile)}` : ''} }`,
    },
  ];
  return { kind: 'codex-toml', table: 'mcp_servers.agent-memory', sections };
}

export function renderCodexCommandFragments(input: PreviewInput): readonly CommandFragment[] {
  return [
    {
      label: 'codex-mcp-add',
      argv: ['codex', 'mcp', 'add', 'agent-memory', '--env', `AGENT_MEMORY_REST_URL=${input.restUrl}`, '--env', 'AGENT_MEMORY_CAPABILITIES=read,write.memory,skill.read,skill.resource.read', '--', 'node', input.mcpEntry],
      env: { AGENT_MEMORY_REST_URL: input.restUrl, AGENT_MEMORY_CAPABILITIES: 'read,write.memory,skill.read,skill.resource.read' },
    },
  ];
}

function quoteTomlString(value: string): string {
  // TOML basic strings: backslashes and double-quotes must be escaped.
  // Our inputs (REST URL, capability list) are not user-controlled
  // outside the CLI flag set, so this is a defensive helper.
  return JSON.stringify(value);
}

export function serialiseCodexToml(body: Extract<DescriptorBody, { kind: 'codex-toml' }>): string {
  const lines: string[] = [];
  lines.push(`[${body.table}]`);
  for (const section of body.sections) {
    lines.push(`${section.key} = ${section.value}`);
  }
  return lines.join('\n') + '\n';
}
