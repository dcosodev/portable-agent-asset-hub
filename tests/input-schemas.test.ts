import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateInputSchemas } from '../packages/baseline/src/index.js';

const fixtures = {
  'memory-record.v1.json': { memory_id: 'mem_test', kind: 'fact', content: 'ok', scope: 'global', status: 'active', schema_version: '1.0' },
  'catalog-entry.v2.json': { entry_type: 'project', logical_key: 'project:e1', name: 'Example project' },
  'catalog-source.v2.json': { kind: 'file', locator: 'README.md' },
  'catalog-relation.v2.json': { subject_id: 'e1', predicate: 'uses', object_id: 'e2' },
};

describe('input schemas (AJV 2020)', () => {
  it('compiles all four schemas and accepts only fixtures that are valid by their schemas', async () => {
    const result = await validateInputSchemas(new URL('../schemas/input/', import.meta.url).pathname, { fixtures, invalidFixtures: {
      'memory-record.v1.json': { memory_id: 'bad', kind: 'not-a-kind', content: '', scope: 'global', status: 'active', schema_version: '9' },
      'catalog-source.v2.json': { kind: '' },
    }});
    expect(result.valid).toBe(true);
    expect(result.schemas).toHaveLength(4);
  });

  it('rejects unknown fixture keys and keeps canonical schemas unchanged', async () => {
    const canonical = new URL('../schemas/input/', import.meta.url).pathname;
    const before = await readFile(new URL('../schemas/input/catalog-entry.v2.json', import.meta.url), 'utf8');
    const result = await validateInputSchemas(canonical, { fixtures: { 'missing.json': {} } });
    expect(result.valid).toBe(false);
    expect(result.errors?.join('\n')).toContain('unknown fixture schema');
    expect(await readFile(new URL('../schemas/input/catalog-entry.v2.json', import.meta.url), 'utf8')).toBe(before);
  });

  it('rejects invalid schema keywords in a temporary copy without mutating canonical schemas', async () => {
    const dir = await mkdtemp(join('/tmp', 'pah-schema-'));
    const canonical = new URL('../schemas/input/memory-record.v1.json', import.meta.url).pathname;
    const original = await readFile(canonical, 'utf8');
    try {
      await writeFile(join(dir, 'memory-record.v1.json'), JSON.stringify({ ...JSON.parse(original), required: 'not-an-array' }));
      const result = await validateInputSchemas(dir);
      expect(result.valid).toBe(false);
      expect(result.errors?.join('\n')).toMatch(/schema|compile|keyword|required/);
      expect(await readFile(canonical, 'utf8')).toBe(original);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
