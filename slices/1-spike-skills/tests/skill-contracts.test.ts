import { describe, expect, it } from 'vitest';
import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { SkillService } from '../src/core/service.js';

async function withService(test: (service: SkillService, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 's1-'));
  const service = new SkillService({ root });
  try { await test(service, root); } finally { service.close(); await rm(root, { recursive: true, force: true }); }
}

describe('skill contracts', () => {
  it('rolls back create and FTS together on injected failure', async () => withService(async (service) => {
    service.skills.injectFailureBeforeCommit();
    expect(() => service.create({ slug: 'atomic', title: 'Atomic', body: 'needle' })).toThrow('INJECTED_FAILURE');
    expect(service.get('atomic')).toBeUndefined();
    expect(service.search('needle')).toHaveLength(0);
    expect(service.skills.versions('atomic')).toHaveLength(0);
    const created = service.create({ slug: 'atomic', title: 'Atomic', body: 'needle' });
    expect(created.version).toBe(1);
    expect(service.search('needle')).toHaveLength(1);
  }));

  it('uses the migration schema marker and required constraints', async () => withService(async (service) => {
    const marker = service.skills.db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as { value: string };
    expect(marker.value).toBe('001-skills');
    const columns = service.skills.db.prepare('PRAGMA table_info(skills)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(['id', 'version_id', 'slug', 'title', 'body', 'version', 'head', 'created_at']);
    expect(service.skills.db.prepare("SELECT name FROM sqlite_master WHERE name='skills_fts'").get()).toBeTruthy();
  }));

  it('requires CAS and preserves v1 when creating v2', async () => withService(async (service) => {
    const v1 = service.create({ slug: 'x', title: 'one', body: 'needle' });
    expect(() => service.update('x', { slug: 'x', title: 'bad', body: 'bad' })).toThrow('EXPECTED_VERSION_REQUIRED');
    expect(() => service.update('x', { slug: 'x', title: 'bad', body: 'bad' }, 0)).toThrow('STALE_VERSION');
    const v2 = service.update('x', { slug: 'x', title: 'two', body: 'new needle' }, 1);
    expect(v1.id).toBe('x'); expect(v2.version).toBe(2); expect(service.get('x', 1)?.body).toBe('needle');
    expect(service.skills.versions('x').filter((x) => x.head)).toHaveLength(1);
  }));

  it('indexes only visible head', async () => withService(async (service) => {
    service.create({ slug: 'x', title: 'old', body: 'uniqueold' });
    service.update('x', { slug: 'x', title: 'new', body: 'uniquenew' }, 1);
    expect(service.search('uniqueold')).toHaveLength(0); expect(service.search('uniquenew')).toHaveLength(1);
  }));

  it('rejects resource symlinks at every path boundary and cleans staging', async () => withService(async (service, root) => {
    const v = service.create({ slug: 'x', title: 'x', body: 'x' });
    const resources = service.resources.root;
    await mkdir(resources, { recursive: true });
    const outside = await mkdtemp(join(tmpdir(), 's1-outside-'));
    try {
      await rm(resources, { recursive: true, force: true });
      await symlink(outside, resources);
      await expect(service.resourcePut(v.id, v.version, 'root-link.txt', new Uint8Array([1]))).rejects.toThrow('SYMLINK_RESOURCE_PATH');
      await rm(resources, { recursive: true, force: true });
      await mkdir(resources, { recursive: true });
      for (const [name, target] of [['staging', join(resources, '.staging')], ['skill', join(resources, 'link')], ['version', join(resources, 'x', '1')], ['nested', join(resources, 'x', '1', 'nested')], ['target', join(resources, 'x', '1', 'nested', 'target')]] as const) {
        await rm(target, { recursive: true, force: true }).catch(() => undefined);
        await mkdir(dirname(target), { recursive: true });
        await symlink(outside, target);
        const skillId = name === 'skill' ? 'link' : 'x';
        const resourcePath = name === 'nested' ? 'nested/file.txt' : name === 'target' ? 'nested/target/file.txt' : 'safe.txt';
        await expect(service.resourcePut(skillId, v.version, resourcePath, new Uint8Array([1]))).rejects.toThrow(/SYMLINK|INVALID/);
        await rm(target, { recursive: true, force: true }).catch(() => undefined);
      }
      await writeFile(join(outside, 'sentinel'), 'untouched');
      await expect(service.resourcePut(v.id, v.version, 'nested/ok.txt', new Uint8Array([1]))).resolves.toBeTruthy();
      expect(await service.resources.stagingEntries()).toHaveLength(0);
      expect(await lstat(join(outside, 'sentinel'))).toBeTruthy();
    } finally { await rm(outside, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); }
  }));

  it('cleans injected post-staging failure without touching target or outside root', async () => withService(async (service, root) => {
    const v = service.create({ slug: 'atomic-resource', title: 'x', body: 'x' });
    const outside = await mkdtemp(join(tmpdir(), 's1-outside-'));
    const outsideBefore = new Set(await readdir(outside));
    try {
      service.resources.injectFailureAfterStagingForSpike();
      await expect(service.resourcePut(v.id, v.version, 'nested/file.txt', new Uint8Array([7]))).rejects.toThrow('INJECTED_FAILURE_AFTER_STAGING');
      expect(await service.resources.stagingEntries()).toHaveLength(0);
      await expect(service.resources.get(v.id, v.version, 'nested/file.txt')).rejects.toThrow(/ENOENT|INVALID/);
      expect(new Set(await readdir(outside))).toEqual(outsideBefore);
    } finally { await rm(outside, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); }
  }));
});
