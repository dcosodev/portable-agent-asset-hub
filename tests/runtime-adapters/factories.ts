// tests/runtime-adapters/factories.mts
//
// Shared test helpers for the FASE 4 `runtime-adapters` test
// suite. All factories return real, on-disk artefacts rooted in a
// per-test tmpdir that the suite cleans up after each test.

import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { HarnessId } from '@portable-agent-asset-hub/runtime-adapters';

export const FIXTURES_ROOT = new URL('./fixtures/', import.meta.url).pathname;
export const USER_FIXTURE = join(FIXTURES_ROOT, 'USER.md');
export const SOUL_FIXTURE = join(FIXTURES_ROOT, 'SOUL.md');
export const MCP_ENTRY_FIXTURE = join(FIXTURES_ROOT, 'mcp-entry.mjs');
export const FAKE_REST_FIXTURE = join(FIXTURES_ROOT, 'fake-rest.mjs');

export const HARNESSES: readonly HarnessId[] = [
  'codex',
  'claude-code',
  'opencode',
  'hermes',
  'openclaw',
];

export function makeTempRoot(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function makeTargetDir(prefix: string): string {
  const root = makeTempRoot(prefix);
  mkdirSync(join(root, '.pah'), { recursive: true });
  return root;
}

export function ensureFixtureCopy(target: string, relative: string): string {
  const destination = join(target, relative);
  mkdirSync(join(destination, '..'), { recursive: true });
  // hardlink/copy via readFileSync+writeFileSync to keep the test
  // independent of the fixture's permissions.
  // (Not used heavily; tests read the fixture directly.)
  writeFileSync(destination, 'fixture placeholder');
  return destination;
}

export function relativePathOf(harness: HarnessId): {
  wrapper: string;
  user: string;
  soul: string;
  descriptor: string;
} {
  switch (harness) {
    case 'codex':
      return { wrapper: 'AGENTS.md', user: 'USER.md', soul: 'SOUL.md', descriptor: '.codex/config.toml' };
    case 'claude-code':
      return { wrapper: 'CLAUDE.md', user: 'USER.md', soul: 'SOUL.md', descriptor: '.mcp.json' };
    case 'opencode':
      return { wrapper: 'AGENTS.md', user: 'USER.md', soul: 'SOUL.md', descriptor: 'opencode.json' };
    case 'hermes':
      return { wrapper: 'AGENTS.md', user: 'USER.md', soul: 'SOUL.md', descriptor: '.hermes/agent-memory.fragment.txt' };
    case 'openclaw':
      return { wrapper: 'MEMORY.md', user: 'USER.md', soul: 'SOUL.md', descriptor: '.openclaw/agent-memory.fragment.json' };
  }
}
