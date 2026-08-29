#!/usr/bin/env node
// Mirror workspace deps into a compiled dist/packages/<name> tree so the
// package's runtime can resolve them when invoked outside the workspace
// (real SQLite-backed smoke tests, Docker images, etc.). This script is
// package-agnostic: pass the package name as the first argument.
//
// Usage:
//   node scripts/sync-workspace-deps.mjs <package-name>
//
// The script reads `packages/<name>/package.json`, finds every
// `@portable-agent-asset-hub/*` dependency, and creates a symlink under
// `dist/packages/<name>/node_modules/@portable-agent-asset-hub/<dep>`.
//
// Idempotent: re-running only replaces stale non-link entries.

import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the workspace root by walking up until we find a pnpm-workspace.yaml
// marker. This keeps the script independent of the caller's cwd.
function findWorkspaceRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 8; i += 1) {
    try {
      const candidate = resolve(dir, 'pnpm-workspace.yaml');
      if (existsSync(candidate)) return dir;
    } catch { /* ignore */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('sync-workspace-deps.mjs: cannot locate workspace root (no pnpm-workspace.yaml found)');
}

const here = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = findWorkspaceRoot(here);
const packageName = process.argv[2];
if (!packageName) throw new Error('Usage: sync-workspace-deps.mjs <package-name>');
const pkgRoot = resolve(workspaceRoot, 'packages', packageName);
const distRoot = resolve(workspaceRoot, 'dist', 'packages', packageName);

const pkg = JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf8'));
const workspaceDeps = Object.keys(pkg.dependencies ?? {})
  .filter((name) => name.startsWith('@portable-agent-asset-hub/'))
  .map((name) => name.replace('@portable-agent-asset-hub/', ''));

const target = resolve(distRoot, 'node_modules', '@portable-agent-asset-hub');
mkdirSync(target, { recursive: true });

for (const dep of workspaceDeps) {
  const link = resolve(target, dep);
  const src = resolve(workspaceRoot, 'packages', dep);
  if (!existsSync(src)) continue;
  if (existsSync(link) || lstatSync_safe(link)) {
    let stat;
    try {
      stat = lstatSync(link);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    rmSync(link, { recursive: true, force: true });
  }
  symlinkSync(src, link);
}

function lstatSync_safe(p) {
  try { return lstatSync(p); } catch { return null; }
}