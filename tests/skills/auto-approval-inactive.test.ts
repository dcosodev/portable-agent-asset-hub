import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const sourceRoots = ['packages/core/src', 'packages/rest/src', 'packages/storage-sqlite/src', 'packages/mcp/src', 'packages/graph-ui/src'];

function sourceFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return sourceFiles(child);
    return /\.(?:ts|tsx)$/u.test(entry.name) && !/\.test\.(?:ts|tsx)$/u.test(entry.name) ? [child] : [];
  });
}

describe('auto-approval remains foundations-only', () => {
  it('has no production caller for either closed-by-default eligibility gate', () => {
    const files = sourceRoots.flatMap((path) => sourceFiles(join(root, path)));
    const references = new Map<string, string[]>();
    for (const symbol of ['autoApprovableExplicitCandidates', 'isAutoApproveUnlocked']) {
      references.set(symbol, files
        .filter((path) => readFileSync(path, 'utf8').includes(symbol))
        .map((path) => relative(root, path))
        .sort());
    }

    expect(references.get('autoApprovableExplicitCandidates')).toEqual([
      'packages/core/src/skills/explicit-relations.ts',
    ]);
    expect(references.get('isAutoApproveUnlocked')).toEqual([
      'packages/core/src/skills/relation-calibration.ts',
    ]);
  });
});