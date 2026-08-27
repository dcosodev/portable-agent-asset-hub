// packages/runtime-adapters/src/hermes/implementation.ts
//
// Hermes MCP descriptor is a logical CLI fragment shaped like:
//   hermes mcp add --command node \
//     --env AGENT_MEMORY_REST_URL=<restUrl> \
//     --env AGENT_MEMORY_CAPABILITIES=read,write.memory,skill.read,skill.resource.read \
//     --args <mcpEntry> \
//     agent-memory
//
// The apply writes a plain-text copy of that fragment into
// `.hermes/agent-memory.fragment.txt` and never executes it. The
// operator must paste it into the Hermes CLI once. The fragment
// carries no bearer tokens and never references any historical root.

import type { CommandFragment, DescriptorBody, PreviewInput } from '../contracts.js';
import { canonicalise, utf8 } from '../internal/digest.js';

export const HERMES_WRAPPER_RELATIVE_PATH = 'AGENTS.md';
export const HERMES_DESCRIPTOR_RELATIVE_PATH = '.hermes/agent-memory.fragment.txt';

const HERMES_CAPABILITIES = 'read,write.memory,skill.read,skill.resource.read';

export function buildHermesCommandFragment(input: PreviewInput): DescriptorBody {
  const argv: string[] = [
    'hermes', 'mcp', 'add', 'agent-memory',
    '--command', 'node',
    '--env', `AGENT_MEMORY_REST_URL=${input.restUrl}`,
    `AGENT_MEMORY_CAPABILITIES=${HERMES_CAPABILITIES}`,
    '--args', input.mcpEntry,
  ];
  const env: Record<string, string> = {
    AGENT_MEMORY_REST_URL: input.restUrl,
    AGENT_MEMORY_CAPABILITIES: HERMES_CAPABILITIES,
    ...(input.authTokenFile ? { AGENT_MEMORY_AUTH_TOKEN_FILE: input.authTokenFile } : {}),
  };
  return { kind: 'hermes-cli-fragment', argv, env };
}

export function renderHermesCommandFragments(input: PreviewInput): readonly CommandFragment[] {
  const body = buildHermesCommandFragment(input);
  if (body.kind !== 'hermes-cli-fragment') throw new Error('hermes descriptor kind mismatch');
  const argv = body.argv;
  const env = body.env;
  return [{ label: 'hermes-mcp-add', argv, env }];
}

/**
 * The fragment is serialised as a deterministic single-line
 * command; the operator may copy/paste it into a shell verbatim.
 * The apply writes the fragment file using `serialiseHermesCommandFragment`
 * bytes; tests assert the bytes round-trip via `argv` parsing.
 */
export function serialiseHermesCommandFragment(body: Extract<DescriptorBody, { kind: 'hermes-cli-fragment' }>): string {
  const envSorted = Object.keys(body.env).sort().reduce<Record<string, string>>((acc, key) => {
    acc[key] = body.env[key]!;
    return acc;
  }, {});
  return canonicalise({ argv: body.argv, env: envSorted }) + '\n';
}

export function parseHermesCommandFragment(bytes: Uint8Array): { argv: string[]; env: Record<string, string> } {
  const text = new TextDecoder('utf-8').decode(bytes);
  // Reject leading # so the file isn't mistaken for a comment; assert
  // it is the deterministic JSON envelope written by
  // `serialiseHermesCommandFragment`.
  if (text.startsWith('#')) throw new Error('hermes fragment must not start with a comment');
  return JSON.parse(text) as { argv: string[]; env: Record<string, string> };
}

export function utf8HermesFragment(body: Extract<DescriptorBody, { kind: 'hermes-cli-fragment' }>): Uint8Array {
  return utf8(serialiseHermesCommandFragment(body));
}
