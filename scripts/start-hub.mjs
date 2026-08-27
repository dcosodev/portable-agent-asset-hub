#!/usr/bin/env node
import { mkdirSync, mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveHubDatabasePath } from '@portable-agent-asset-hub/core';

const mode = process.argv[2] ?? 'canonical';
if (!['canonical', 'temporary', 'test'].includes(mode)) {
  console.error('usage: start-hub.mjs canonical|temporary|test');
  process.exit(2);
}
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env, AGENT_MEMORY_STORAGE_MODE: mode };
if (mode !== 'canonical' && !env.AGENT_MEMORY_DB_PATH) {
  const root = mkdtempSync(join(tmpdir(), 'portable-agent-asset-hub-'));
  env.AGENT_MEMORY_DB_PATH = join(root, 'hub.sqlite');
}
const resolution = resolveHubDatabasePath({ env });
if (resolution.mode === 'canonical') mkdirSync(dirname(resolution.path), { recursive: true, mode: 0o700 });
console.error(`HUB_STORAGE ${JSON.stringify({ mode: resolution.mode, source: resolution.source, databasePath: resolution.path })}`);
const bin = resolve(repoRoot, 'packages/rest/bin/agent-memory-rest.mjs');
const child = spawn(process.execPath, [bin], { cwd: repoRoot, env, stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
