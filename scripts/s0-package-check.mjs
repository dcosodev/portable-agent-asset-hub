import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const source = resolve(new URL('..', import.meta.url).pathname);
const tempRoots = [];
const ignored = new Set(['node_modules', '.git', 'dist', 'artifacts', '.pah-pack']);
const forbidden = /(^|\/)(tests?|src|docs|scripts|node_modules|\.git|\.hermes|\.openclaw|artifacts)(\/|$)|(^|\/)docs\/baseline(\/|$)|(?:^|\/)(?:.*\.tsbuildinfo)$/i;
function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableJson(item)]));
  return value;
}

import { isPrivatePackageBytes } from './package-private-policy.mjs';

async function copyWorkspace(destination) {
  await cp(source, destination, {
    recursive: true,
    filter: (entry) => !ignored.has(entry.slice(source.length + 1).split('/')[0]),
  });
}

async function packageContents(tgz, destination) {
  const extractRoot = join(destination, 'extract');
  await mkdir(extractRoot);
  const listing = (await execFileAsync('tar', ['-tvzf', tgz])).stdout.split('\n');
  if (listing.some(line => /^[lrh]/.test(line))) throw new Error('symlink or hardlink in package tarball');
  await execFileAsync('tar', ['-xzf', tgz, '-C', extractRoot]);
  const packageRoot = join(extractRoot, 'package');
  const entries = [];
  async function walk(current) {
    const names = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of names) {
      const absolute = join(current, entry.name);
      const rel = relative(packageRoot, absolute).split('/').join('/');
      if (entry.isSymbolicLink()) throw new Error(`symlink in package: ${rel}`);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) {
        if (forbidden.test(rel) || rel.startsWith('/') || rel.includes('Users/')) throw new Error(`forbidden package content: ${rel}`);
        const bytes = await readFile(absolute);
        if (isPrivatePackageBytes(bytes.toString('utf8'))) throw new Error(`private content in package bytes: ${rel}`);
        const comparable = rel === 'package.json' ? Buffer.from(`${JSON.stringify(stableJson(JSON.parse(bytes.toString('utf8'))))}\n`) : bytes;
        entries.push({ path: rel, bytes: comparable.byteLength, sha256: createHash('sha256').update(comparable).digest('hex') });
      }
    }
  }
  await walk(packageRoot);
  return entries;
}

if (process.argv[2] === '--tar') {
  if (process.argv.length !== 4) throw new Error('usage: s0-package-check.mjs --tar <tarball>');
  const probeRoot = await mkdtemp(join(tmpdir(), 'pah-package-probe-'));
  try {
    await packageContents(resolve(process.argv[3]), probeRoot);
    console.log(JSON.stringify({ valid: true }));
  } finally { await rm(probeRoot, { recursive: true, force: true }); }
  process.exit(0);
}

async function run(command, args, cwd) {
  const result = await execFileAsync(command, args, { cwd, env: { ...process.env, CI: 'true' } });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
}

try {
  const manifests = [];
  for (let index = 0; index < 2; index += 1) {
    const root = await mkdtemp(join(tmpdir(), `pah-pack-${index}-`));
    tempRoots.push(root);
    await copyWorkspace(root);
    const packDir = join(root, '.pah-pack');
    await mkdir(packDir);
    await run('pnpm', ['install', '--offline', '--ignore-scripts'], root);
    await run('pnpm', ['build'], root);
    await run('pnpm', ['pack', '--pack-destination', packDir], root);
    const tgz = join(packDir, (await readdir(packDir))[0]);
    manifests.push(await packageContents(tgz, root));
  }
  const serialized = JSON.stringify(manifests[0]);
  const second = JSON.stringify(manifests[1]);
  if (serialized !== second) throw new Error('published package contents differ between isolated builds');
  console.log(JSON.stringify({ isolatedRoots: 2, compared: 'published contents only', entries: manifests[0].length, logicalDigest: createHash('sha256').update(serialized).digest('hex'), contents: manifests[0] }));
} finally {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
}
