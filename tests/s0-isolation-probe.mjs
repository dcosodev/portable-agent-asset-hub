/* global process, URL, console */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const source = new URL('..', import.meta.url).pathname;
const copy = await mkdtemp(join(tmpdir(), 'pah-s0-isolated-'));
try {
  await cp(source, copy, { recursive: true, filter: entry => !entry.includes('/node_modules/') && !entry.includes('/artifacts/') });
  const manifestPath = join(copy, 'docs/baseline/current-repo-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.root = '/definitely-invalid-isolated-root';
  await writeFile(manifestPath, JSON.stringify(manifest));
  try {
    await exec(process.execPath, ['scripts/s0-audit.mjs'], { cwd: copy });
    throw new Error('isolated audit accepted manipulated copy manifest');
  } catch (error) {
    if (error instanceof Error && error.message === 'isolated audit accepted manipulated copy manifest') throw error;
  }
  console.log(JSON.stringify({ isolatedManifest: 'rejected' }));
} finally {
  await rm(copy, { recursive: true, force: true });
}
