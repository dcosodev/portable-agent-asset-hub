import { cp, copyFile, mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(new URL('..', import.meta.url).pathname);
const packageNames = ['core', 'storage-files', 'storage-sqlite'];

async function logicalDigest(tgz) {
  const { stdout } = await exec('tar', ['-tzf', tgz]);
  const paths = stdout.trim().split('\n').filter((path) => path && path !== 'package/').sort();
  const hash = createHash('sha256');
  const entries = [];
  for (const path of paths) {
    const { stdout: bytes } = await exec('tar', ['-xOf', tgz, path], {
      encoding: 'buffer',
      maxBuffer: 50 * 1024 * 1024,
    });
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    hash.update(path);
    hash.update('\0');
    hash.update(buffer);
    entries.push({ path, bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') });
  }
  return { digest: hash.digest('hex'), entries };
}

async function copySqlMigrations(source, destination) {
  await mkdir(destination, { recursive: true });
  const names = (await readdir(source)).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
  for (const name of names) await copyFile(join(source, name), join(destination, name));
}

async function buildPackage(name, outputRoot) {
  const packageRoot = join(outputRoot, name);
  await cp(join(root, 'tsconfig.base.json'), join(outputRoot, '..', 'tsconfig.base.json'));
  await cp(join(root, 'packages', name), packageRoot, {
    recursive: true,
    filter: (path) => !path.includes('/dist') && !path.includes('tsconfig.tsbuildinfo'),
  });
  for (const dependency of packageNames) {
    if (dependency === name) continue;
    const dependencyRoot = join(outputRoot, dependency);
    try { await readdir(dependencyRoot); } catch { continue; }
    const scopeRoot = join(outputRoot, 'node_modules', '@portable-agent-asset-hub');
    await mkdir(scopeRoot, { recursive: true });
    const link = join(scopeRoot, dependency);
    try { await symlink(dependencyRoot, link, 'dir'); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  await exec('pnpm', [
    'exec', 'tsc', '-p', join(packageRoot, 'tsconfig.json'),
    '--typeRoots', join(root, 'node_modules/@types'),
  ], { cwd: root });
  if (name === 'storage-sqlite') {
    await copySqlMigrations(join(packageRoot, 'src', 'migrations'), join(packageRoot, 'dist', 'migrations'));
  }
  const { stdout } = await exec('npm', [
    'pack', '--ignore-scripts', '--json', '--pack-destination', outputRoot,
  ], { cwd: packageRoot });
  return JSON.parse(stdout)[0].filename;
}

const temp = await mkdtemp(join(tmpdir(), 's2-repro-'));
try {
  const firstRoot = join(temp, 'a');
  const secondRoot = join(temp, 'b');
  await mkdir(firstRoot);
  await mkdir(secondRoot);
  const results = {};
  for (const name of packageNames) {
    const firstName = await buildPackage(name, firstRoot);
    const secondName = await buildPackage(name, secondRoot);
    const first = await logicalDigest(join(firstRoot, firstName));
    const second = await logicalDigest(join(secondRoot, secondName));
    if (first.digest !== second.digest) throw new Error(`NON_REPRODUCIBLE_PACKAGE:${name}`);
    if (!first.entries.some((entry) => entry.path === 'package/dist/index.js')) throw new Error(`${name}:MISSING_JS`);
    if (!first.entries.some((entry) => entry.path === 'package/dist/index.d.ts')) throw new Error(`${name}:MISSING_TYPES`);
    const forbidden = first.entries.filter((entry) => entry.path.endsWith('.tsbuildinfo') || (entry.path.endsWith('.ts') && !entry.path.endsWith('.d.ts')));
    if (forbidden.length > 0) throw new Error(`${name}:FORBIDDEN_PACKAGE_ENTRIES:${forbidden.map((entry) => entry.path).join(',')}`);
    if (name === 'storage-sqlite' && first.entries.filter((entry) => entry.path.endsWith('.sql')).length !== 19) {
      throw new Error('storage-sqlite:MIGRATION_SET_INCOMPLETE');
    }
    if (name === 'storage-files' && !first.entries.some((entry) => entry.path === 'package/dist/index.js')) throw new Error('storage-files:MISSING_JS');
    results[name] = { first, second, package: firstName };
  }
  console.log(JSON.stringify({ ok: true, isolatedRoots: 2, packages: results }));
} finally {
  await rm(temp, { recursive: true, force: true });
}
