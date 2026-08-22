import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildBaselineManifest, verifyBaselineManifest } from '../packages/baseline/src/index.js';

const tempRoot = () => mkdtemp(join(tmpdir(), 'pah-baseline-'));

 describe('baseline manifests', () => {
  it('rejects unsafe roots and manifest paths', async () => {
    const root = await tempRoot();
    try {
      await expect(buildBaselineManifest('relative', { allowlist: ['x'] })).rejects.toThrow(/absolute/);
      await expect(buildBaselineManifest(root, { allowlist: ['../outside'] })).rejects.toThrow(/allowlist|unsafe|dotdot/);
      await expect(buildBaselineManifest(root, { allowlist: ['/etc'] })).rejects.toThrow(/allowlist|absolute/);
      await expect(buildBaselineManifest(root, { allowlist: ['bad\0path'] })).rejects.toThrow(/NUL/);
      const result = await verifyBaselineManifest(root, { version: 1, root, files: [{ path: '../x', bytes: 0, mode: 0, sha256: '' }], allowlist: ['.'], completeness: 'complete', extrasPolicy: 'reject-non-excluded', symlinkPolicy: 'reject-root-and-internal', exclusions: [], toolVersion: 'test' });
      expect(result.valid).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects every non-canonical path spelling and only permits root dot', async () => {
    const root = await tempRoot();
    try {
      await writeFile(join(root, 'a'), 'a');
      await mkdir(join(root, 'd'));
      await writeFile(join(root, 'd', 'f'), 'f');
      for (const path of ['d//f', 'd/./f', './a', 'd\\\\f', 'd/f/']) {
        await expect(buildBaselineManifest(root, { allowlist: [path] })).rejects.toThrow(/canonical|separator|segment|backslash|trailing|allowlist/);
      }
      await expect(buildBaselineManifest(root, { allowlist: ['.'] })).resolves.toMatchObject({ allowlist: ['.'] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('requires allowlist to already be sorted, unique, and canonical', async () => {
    const root = await tempRoot();
    try {
      await writeFile(join(root, 'a'), 'a'); await writeFile(join(root, 'b'), 'b');
      for (const allowlist of [['b', 'a'], ['a', 'a'], ['./a']]) {
        await expect(buildBaselineManifest(root, { allowlist })).rejects.toThrow(/allowlist|canonical|sorted|duplicate/);
      }
      const manifest = await buildBaselineManifest(root, { allowlist: ['a', 'b'] });
      expect((await verifyBaselineManifest(root, { ...manifest, allowlist: ['b', 'a'] })).valid).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects manipulated allowlists, excluded paths, duplicates, and invalid metadata before reading', async () => {
    const root = await tempRoot();
    try {
      await writeFile(join(root, 'safe.txt'), 'safe'); await writeFile(join(root, '.env'), 'secret');
      const base = await buildBaselineManifest(root, { allowlist: ['safe.txt'] });
      const outside = { ...base, files: [{ ...base.files[0], path: '.env' }], allowlist: ['safe.txt'] };
      expect((await verifyBaselineManifest(root, outside)).valid).toBe(false);
      const excluded = { ...base, files: [{ ...base.files[0], path: '.env' }], allowlist: ['.'] };
      expect((await verifyBaselineManifest(root, excluded)).valid).toBe(false);
      expect((await verifyBaselineManifest(root, { ...base, files: [base.files[0], base.files[0]] })).valid).toBe(false);
      expect((await verifyBaselineManifest(root, { ...base, files: [{ ...base.files[0], bytes: -1 }] })).valid).toBe(false);
      expect((await verifyBaselineManifest(root, { ...base, files: [{ ...base.files[0], sha256: 'bad' }] })).valid).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('uses the declared exclusion policy for egg-info, coverage, node_modules, and env', async () => {
    const root = await tempRoot();
    try {
      for (const path of ['pkg.egg-info/meta', 'coverage.txt', 'coverage/data', 'node_modules/pkg/index.js', '.env']) {
        await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), 'private');
      }
      const manifest = await buildBaselineManifest(root, { allowlist: ['.'] });
      expect(manifest.files).toEqual([]);
      expect(manifest.exclusions).toContain('*.egg-info'); expect(manifest.exclusions).toContain('coverage.*');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects root and internal symlinks and physical escapes', async () => {
    const parent = await tempRoot();
    try {
      const real = join(parent, 'real'); await mkdir(real);
      await writeFile(join(real, 'safe.txt'), 'safe');
      const rootLink = join(parent, 'root-link'); await symlink(real, rootLink);
      await expect(buildBaselineManifest(rootLink, { allowlist: ['safe.txt'] })).rejects.toThrow(/symlink/);
      const root = await tempRoot();
      try { await writeFile(join(root, 'outside.txt'), 'outside'); await symlink(join(parent, 'real', 'safe.txt'), join(root, 'escape.txt')); await expect(buildBaselineManifest(root, { allowlist: ['.'] })).rejects.toThrow(/symlink/); }
      finally { await rm(root, { recursive: true, force: true }); }
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it('detects missing and non-excluded extra files', async () => {
    const root = await tempRoot();
    try { await writeFile(join(root, 'a.txt'), 'a'); const manifest = await buildBaselineManifest(root, { allowlist: ['.'] }); await writeFile(join(root, 'extra.txt'), 'extra'); let result = await verifyBaselineManifest(root, manifest); expect(result.valid).toBe(false); expect(result.errors.join('\n')).toContain('extra.txt'); await writeFile(join(root, 'a.txt'), 'changed'); result = await verifyBaselineManifest(root, manifest); expect(result.errors.join('\n')).toContain('a.txt sha256'); }
    finally { await rm(root, { recursive: true, force: true }); }
  });

  it('builds and verifies the complete allowlisted tree', async () => {
    const root = await tempRoot();
    try { await mkdir(join(root, 'dir')); await writeFile(join(root, 'dir', 'a'), 'a'); const manifest = await buildBaselineManifest(resolve(root), { allowlist: ['dir'] }); expect(manifest.root).toBe(resolve(root)); expect(manifest.files.map(f => f.path)).toEqual(['dir/a']); expect(await verifyBaselineManifest(root, manifest)).toEqual({ valid: true, errors: [] }); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
});
