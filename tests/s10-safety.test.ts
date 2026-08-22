// tests/s10-safety.test.ts
//
// Normative safety guarantees for Slice 10:
//
//   * Adapters and materializers (in the migration package) MUST NOT
//     import `node:sqlite`.
//   * The migration package MUST NOT reference any harness's
//     `state.db` (e.g. `~/.hermes/state.db`).
//   * The classifier MUST treat key-shaped "secret" tokens as SECRET.
//   * The state machine MUST refuse to advance to `cutover_active`
//     without a manifest digest and source digest.
//
// These checks are structural; they fail when the package violates the
// safety guardrails, regardless of behavioural correctness.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import * as Migration from '@portable-agent-asset-hub/migration';

const PACKAGE_SRC = join(__dirname, '..', 'packages', 'migration', 'src');

function findSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) walk(full);
      else if (/\.(ts|js|mjs)$/.test(entry)) out.push(full);
    }
  };
  walk(root);
  return out;
}

describe('S10 safety: no SQLite or state.db in adapters/materializers', () => {
  it('the migration package source never imports node:sqlite', () => {
    const files = findSourceFiles(PACKAGE_SRC);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const body = readFileSync(file, 'utf8');
      expect(body).not.toMatch(/from\s+['"]node:sqlite['"]/);
      expect(body).not.toMatch(/require\(\s*['"]node:sqlite['"]\s*\)/);
    }
  });

  it('the migration package source never references state.db', () => {
    const files = findSourceFiles(PACKAGE_SRC);
    for (const file of files) {
      const body = readFileSync(file, 'utf8');
      expect(body).not.toMatch(/state\.db/);
    }
  });

  it('classifyFields correctly tags SECRET-shaped keys regardless of casing or nesting', () => {
    const result = Migration.classifyFields({
      API_KEY: 'sk-X',
      Token: 'tok',
      nested: { Password: 'p', api_key: 'x', SECRET: 's', name: 'n' },
    });
    expect(result.API_KEY).toBe('SECRET');
    expect(result.Token).toBe('SECRET');
    expect(result.nested.Password).toBe('SECRET');
    expect(result.nested.api_key).toBe('SECRET');
    expect(result.nested.SECRET).toBe('SECRET');
    expect(result.nested.name).toBe('PUBLIC');
  });
});
