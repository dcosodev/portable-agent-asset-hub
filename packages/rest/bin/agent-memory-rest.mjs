#!/usr/bin/env node
// Thin workspace/published-package shim for the durable REST launcher.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const shimDir = dirname(fileURLToPath(import.meta.url));
// The package builds to its own `dist/` (see packages/rest/tsconfig.json),
// so the workspace checkout and the published tarball resolve identically.
const entry = resolve(shimDir, '..', 'dist', 'launcher.js');
const entryPath = existsSync(entry) ? entry : undefined;

const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--db' && args[index + 1]) process.env.AGENT_MEMORY_DB_CLI_PATH = args[++index];
  else if (args[index] === '--storage-mode' && args[index + 1]) process.env.AGENT_MEMORY_STORAGE_MODE = args[++index];
  else if (args[index] !== '--help') {
    process.stderr.write(`agent-memory-rest error: unknown argument ${args[index]}\n`);
    process.exit(2);
  }
}

if (!entryPath) {
  process.stderr.write(`agent-memory-rest error: failed to locate launcher (probed: ${entry})\n`);
  process.exit(1);
}

import(pathToFileURL(entryPath).href)
  .then((module) => module.runLauncher())
  .catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    process.stderr.write(`agent-memory-rest error: failed to load launcher: ${message}\n`);
    process.exit(1);
  });
