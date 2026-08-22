import { join } from 'node:path';
import { SkillSqliteStore } from '../storage-sqlite/store.js';
import { LocalResourceStore } from '../storage-files/store.js';
import type { Resource, SkillInput, SkillVersion } from './types.js';

export class SkillService {
  public readonly skills: SkillSqliteStore;
  public readonly resources: LocalResourceStore;
  public constructor(opts: { root: string; dbPath?: string }) {
    this.skills = new SkillSqliteStore(opts.dbPath ?? join(opts.root, 'skills.sqlite'));
    this.resources = new LocalResourceStore(join(opts.root, 'resources'));
  }
  public create(input: SkillInput): SkillVersion { return this.skills.create(input); }
  public get(slug: string, version?: number): SkillVersion | undefined { return this.skills.get(slug, version); }
  public update(slug: string, input: SkillInput, expectedVersion?: number): SkillVersion {
    if (expectedVersion === undefined) throw new Error('EXPECTED_VERSION_REQUIRED');
    return this.skills.update(slug, expectedVersion, input);
  }
  public search(q: string): SkillVersion[] { return this.skills.search(q); }
  public resourcePut(skillId: string, version: number, path: string, data: Uint8Array): Promise<Resource> { return this.resources.put(skillId, version, path, data); }
  public resourceRead(skillId: string, version: number, path: string): Promise<Uint8Array> { return this.resources.get(skillId, version, path); }
  public close(): void { this.skills.close(); }
}
