/* global process, URL, console */
import { mkdtemp, mkdir, rm, symlink, link, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const cwd = new URL('..', import.meta.url).pathname;
const root = await mkdtemp(join(tmpdir(), 'pah-package-security-'));
async function makeTar(name, setup) {
  const fixture = join(root, name); await mkdir(join(fixture, 'package'), { recursive: true });
  await setup(fixture);
  const tar = join(root, `${name}.tgz`);
  await exec('tar', ['-czf', tar, '-C', fixture, 'package']);
  return tar;
}
async function check(tar) {
  try { await exec(process.execPath, ['scripts/s0-package-check.mjs', '--tar', tar], { cwd }); return true; }
  catch { return false; }
}
try {
  const examplesTar = await makeTar('examples', async fixture => writeFile(join(fixture, 'package', 'docs.txt'), '<HOME>/example/project\n<LINUX_HOME>/project'));
  if (!await check(examplesTar)) throw new Error('generic documentation examples were rejected');
  const privateTar = await makeTar('private', async fixture => writeFile(join(fixture, 'package', 'private.txt'), '<HOME>/.hermes/token'));
  if (await check(privateTar)) throw new Error('private real bytes were accepted');
  const mixedTar = await makeTar('mixed', async fixture => writeFile(join(fixture, 'package', 'mixed.txt'), '<HOME>/example/project\n<HOME>/.hermes/token'));
  if (await check(mixedTar)) throw new Error('generic examples bypassed private real bytes');
  const placeholderTar = await makeTar('placeholders', async fixture => {
    await writeFile(join(fixture, 'package', 'hermes-placeholder.txt'), '<HOME>/example/.hermes/example-token');
    await writeFile(join(fixture, 'package', 'secret-placeholder.txt'), '<LINUX_HOME>/project/secrets/example');
    await writeFile(join(fixture, 'package', 'credential-placeholder.txt'), 'AWS_SECRET_ACCESS_KEY=example');
  });
  if (await check(placeholderTar)) throw new Error('private placeholder bytes were accepted');
  const symlinkTar = await makeTar('symlink', async fixture => { await writeFile(join(fixture, 'target.txt'), 'target'); await symlink('../target.txt', join(fixture, 'package', 'link.txt')); });
  if (await check(symlinkTar)) throw new Error('symlink was accepted');
  const hardlinkTar = await makeTar('hardlink', async fixture => { await writeFile(join(fixture, 'package', 'target.txt'), 'target'); await link(join(fixture, 'package', 'target.txt'), join(fixture, 'package', 'link.txt')); });
  if (await check(hardlinkTar)) throw new Error('hardlink was accepted');
  console.log(JSON.stringify({ privateReal: 'rejected', genericExamples: 'accepted', mixedGenericAndPrivate: 'rejected', privatePlaceholders: 'rejected', symlink: 'rejected', hardlink: 'rejected' }));
} finally { await rm(root, { recursive: true, force: true }); }
