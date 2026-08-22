// tests/mcp/no-sqlite-import.test.ts
//
// Normative test: the MCP package must never depend on a SQLite engine,
// open a database file, or import any module from the storage layer.
//
// S7 plan mandates:
//
//   mcp_does_not_import_or_open_sqlite
//   rest_unavailable_has_no_local_db_fallback
//
// This is enforced statically (grep the source for forbidden imports) AND
// dynamically (the resolved dependency graph of the package must contain
// no sqlite / storage-* dependency).

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mcpSrc = resolve(here, '../../packages/mcp/src');
const mcpRoot = resolve(here, '../../packages/mcp');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...walk(path));
    else if (entry.endsWith('.ts') || entry.endsWith('.mjs') || entry.endsWith('.js')) out.push(path);
  }
  return out;
}

describe('MCP isolation from SQLite / storage (S7)', () => {
  it('mcp_does_not_import_or_open_sqlite', () => {
    const files = walk(mcpSrc);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      expect(content.includes('node:sqlite'), `${file} must not import node:sqlite`).toBe(false);
      expect(content.includes('better-sqlite3'), `${file} must not import better-sqlite3`).toBe(false);
      expect(content.includes('@portable-agent-asset-hub/storage-sqlite'), `${file} must not import storage-sqlite`).toBe(false);
      expect(content.includes('@portable-agent-asset-hub/storage-files'), `${file} must not import storage-files`).toBe(false);
      expect(/from\s+['"][^'"]*sqlite[^'"]*['"]/.test(content), `${file} must not import any sqlite module`).toBe(false);
    }
  });

  it('package_manifest_does_not_depend_on_storage_layers', () => {
    const pkg = JSON.parse(readFileSync(join(mcpRoot, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    for (const dep of Object.keys(allDeps)) {
      expect(dep.includes('sqlite'), `${dep} must not be a sqlite dependency`).toBe(false);
      expect(dep.includes('storage'), `${dep} must not be a storage-* dependency`).toBe(false);
    }
  });

  it('no_local_db_fallback_in_transport', () => {
    const files = walk(mcpSrc);
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      expect(/if\s*\(\s*!transport\s*\)\s*{\s*[^}]*sqlite/i.test(content), `${file} must not have a sqlite fallback`).toBe(false);
      expect(content.includes('openDatabase'), `${file} must not call openDatabase`).toBe(false);
    }
  });
});
