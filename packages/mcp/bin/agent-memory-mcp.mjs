#!/usr/bin/env node
// packages/mcp/bin/agent-memory-mcp
//
// Thin shim that boots the compiled stdio entrypoint. Lives outside
// `src/` so the TypeScript compiler does not emit a duplicate copy of
// the entry into `dist/`, and so the `bin` field in `package.json`
// resolves to a single, deterministic file across install layouts.
//
// The shim does *not* read configuration itself — it delegates to
// `runStdioEntry()` exported from the compiled entry, which is the
// single source of truth for the env-var contract documented at
// `packages/mcp/src/stdio-entry.ts`.

// Resolve the compiled entry relative to the shim's own location so
// the import works in both workspace and published-tarball layouts.
//
//   Workspace:   packages/mcp/bin/agent-memory-mcp.mjs
//                ↳ repo root is `../../../`, dist at `../../../dist/packages/mcp/`
//   Published:   bin/agent-memory-mcp.mjs (no `packages/mcp/` prefix)
//                ↳ dist sits at `../dist/stdio-entry.js`
//
// We compute the resolved file URL from `import.meta.url` (the shim's
// own location) using `pathToFileURL` / `fileURLToPath` — the only
// ESM-safe way to address a sibling file regardless of how Node was
// invoked. The repo root is a fixed offset from the bin shim's
// location in the workspace, and the published-tarball layout puts the
// shim next to a sibling `dist/` directory, so we probe both and pick
// the first one that exists. Probing is a deliberate concession: the
// workspace has a nested compiler-output layout
// (`dist/packages/mcp/...`) that the published package does not, so
// the canonical contract (the published tarball) must remain the
// shape we test against.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const shimDir = dirname(fileURLToPath(import.meta.url));
const candidates = [
  // Published tarball: dist sits next to bin/.
  resolve(shimDir, '..', 'dist/stdio-entry.js'),
  // Workspace: repo root is 3 directories above the shim.
  resolve(shimDir, '..', '..', '..', 'dist/packages/mcp/stdio-entry.js'),
];
const entryPath = candidates.find((candidate) => existsSync(candidate));
if (!entryPath) {
  process.stderr.write(`agent-memory-mcp error: failed to locate stdio entry (probed: ${candidates.join(', ')})\n`);
  process.exit(1);
}

import(pathToFileURL(entryPath).href)
  .then((mod) => mod.runStdioEntry())
  .catch((error) => {
    // The entry never throws across the process boundary; this catch
    // only fires for import-time failures (missing compiled file,
    // resolver error). Print a redacted diagnostic and exit non-zero.
    const message = error instanceof Error ? error.message : 'unknown error';
    process.stderr.write(`agent-memory-mcp error: failed to load stdio entry: ${message}\n`);
    process.exit(1);
  });
