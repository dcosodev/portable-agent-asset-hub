import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, lstat, realpath, rename, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Resource } from '../core/types.js';

export class LocalResourceStore {
  private failAfterStaging = false;
  public constructor(public readonly root: string) {}

  /** Controlled spike-only fault injection; never enabled in normal operation. */
  public injectFailureAfterStagingForSpike(): void { this.failAfterStaging = true; }

  private validateResourcePath(path: string): void {
    if (!path || path.includes('\0') || path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) throw new Error('INVALID_RESOURCE_PATH');
    const parts = path.split(/[\\/]/);
    if (parts.some((part) => !part || part === '..' || part === '.')) throw new Error('INVALID_RESOURCE_PATH');
  }

  private isContained(base: string, candidate: string): boolean {
    const rel = relative(base, candidate);
    return rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.includes('\0');
  }

  private async safeExistingPath(path: string): Promise<string> {
    const absoluteRoot = resolve(this.root);
    const absolutePath = resolve(path);
    if (!this.isContained(absoluteRoot, absolutePath)) throw new Error('INVALID_RESOURCE_PATH');
    const rootStat = await lstat(absoluteRoot);
    if (rootStat.isSymbolicLink()) throw new Error('SYMLINK_RESOURCE_PATH');
    let current: string = absoluteRoot;
    const segments = relative(absoluteRoot, absolutePath).split(sep).filter(Boolean);
    for (const segment of segments) {
      current = join(current, segment);
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new Error('SYMLINK_RESOURCE_PATH');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw error;
      }
    }
    const rootReal = await realpath(absoluteRoot);
    const candidateReal = await realpath(path);
    if (!this.isContained(rootReal, candidateReal)) throw new Error('INVALID_RESOURCE_PATH');
    return candidateReal;
  }

  private async ensureDirectory(path: string): Promise<void> {
    const absolute = resolve(path);
    const root = resolve(this.root);
    if (!this.isContained(root, absolute)) throw new Error('INVALID_RESOURCE_PATH');
    const parts = relative(root, absolute).split(sep).filter(Boolean);
    let current = root;
    await mkdir(root, { recursive: true });
    for (const part of parts) {
      current = join(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new Error('SYMLINK_RESOURCE_PATH');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await mkdir(current);
      }
      if (!(await lstat(current)).isDirectory()) throw new Error('INVALID_RESOURCE_PATH');
    }
    await this.safeExistingPath(current);
  }

  private async target(skillId: string, version: number, path: string): Promise<string> {
    this.validateResourcePath(path);
    if (!skillId || skillId.includes('/') || skillId.includes('\\') || skillId.includes('\0')) throw new Error('INVALID_RESOURCE_PATH');
    const target = resolve(this.root, skillId, String(version), path);
    if (!this.isContained(resolve(this.root), target)) throw new Error('INVALID_RESOURCE_PATH');
    return target;
  }

  public async put(skillId: string, version: number, path: string, data: Uint8Array): Promise<Resource> {
    const target = await this.target(skillId, version, path);
    await this.ensureDirectory(resolve(this.root));
    await this.ensureDirectory(dirname(target));
    const stagingRoot = join(resolve(this.root), '.staging');
    await this.ensureDirectory(stagingRoot);
    const staging = join(stagingRoot, `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    try {
      await this.safeExistingPath(stagingRoot);
      await writeFile(staging, data, { flag: 'wx' });
      await this.safeExistingPath(staging);
      await this.safeExistingPath(dirname(target));
      if (this.failAfterStaging) { this.failAfterStaging = false; throw new Error('INJECTED_FAILURE_AFTER_STAGING'); }
      await rename(staging, target);
      await this.safeExistingPath(target);
    } catch (error) {
      try {
        await this.safeExistingPath(stagingRoot);
        await rm(staging, { force: true });
      } catch { /* fail closed: never remove an unverified path */ }
      throw error;
    }
    return { skillId, version, path, bytes: data.byteLength, sha256: createHash('sha256').update(data).digest('hex') };
  }

  public async get(skillId: string, version: number, path: string): Promise<Uint8Array> {
    const target = await this.target(skillId, version, path);
    const verified = await this.safeExistingPath(target);
    const stat = await lstat(verified);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('SYMLINK_RESOURCE_PATH');
    return readFile(verified);
  }

  public async stagingEntries(): Promise<string[]> {
    const staging = join(resolve(this.root), '.staging');
    try {
      await this.safeExistingPath(staging);
      return readdir(staging);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}
