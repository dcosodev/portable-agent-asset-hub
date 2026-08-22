import { createHash } from 'node:crypto';
import { mkdtemp, cp, mkdir, readFile, readdir, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const sourceRoot = process.cwd();
const roots = [];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function copyInputs(root) {
  const inputs = { 'package.json': 'package.json', 'README.md': join(sourceRoot, '../../README.md'), migrations: 'migrations', fixtures: 'fixtures', dist: 'dist' };
  for (const [destination, source] of Object.entries(inputs)) {
    await cp(source, join(root, destination), { recursive: true, dereference: true });
  }
}

async function pack(root) {
  const destination = join(root, '.pack-output');
  await mkdir(destination);
  const result = JSON.parse((await run('npm', ['pack', '--pack-destination', destination, '--json'], {
    cwd: root,
    env: { ...process.env, npm_config_ignore_scripts: 'true' },
  })).stdout)[0];
  return join(destination, result.filename);
}

async function packageManifest(tgz, root) {
  const extract = join(root, '.extract');
  await mkdir(extract);
  await run('tar', ['-xzf', tgz, '-C', extract]);
  const base = join(extract, 'package');
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else {
        const bytes = await readFile(path);
        files.push({ path: relative(base, path), bytes: bytes.length, sha256: hash(bytes) });
      }
    }
  }
  await walk(base);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function digest(manifest) { return hash(Buffer.from(JSON.stringify(manifest))); }

try {
  for (const prefix of ['s1-pack-a-', 's1-pack-b-']) {
    const root = await mkdtemp(join(tmpdir(), prefix));
    roots.push(root);
    await copyInputs(root);
  }
  const [firstRoot, secondRoot] = roots;
  const [firstPackage, secondPackage] = await Promise.all([pack(firstRoot), pack(secondRoot)]);
  const [firstManifest, secondManifest] = await Promise.all([
    packageManifest(firstPackage, firstRoot),
    packageManifest(secondPackage, secondRoot),
  ]);
  if (JSON.stringify(firstManifest) !== JSON.stringify(secondManifest)) throw new Error('NON_REPRODUCIBLE_PACKAGE');

  const destination = join(sourceRoot, 'dist-package');
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination);
  const finalPackage = join(destination, basename(firstPackage));
  await copyFile(firstPackage, finalPackage);
  const finalManifest = await packageManifest(finalPackage, destination);
  if (JSON.stringify(finalManifest) !== JSON.stringify(firstManifest)) throw new Error('FINAL_PACKAGE_MISMATCH');
  await writeFile(join(destination, 'manifest.json'), `${JSON.stringify({
    isolated_roots: 2,
    compared: { files: firstManifest, final_matches: true },
    logical_content_sha256: digest(firstManifest),
  }, null, 2)}\n`);
  console.log(JSON.stringify({ package: relative(sourceRoot, finalPackage), reproducible: true, isolated_roots: 2, files: firstManifest.length, logical_content_sha256: digest(firstManifest), final_matches: true }));
} finally {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
}
