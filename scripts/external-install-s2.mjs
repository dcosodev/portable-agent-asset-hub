import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(new URL('..', import.meta.url).pathname);
const temp = await mkdtemp(join(tmpdir(), 's2-external-'));
const registry = 'http://127.0.0.1:9';

async function pack(name) {
  await exec('pnpm', ['--filter', `@portable-agent-asset-hub/${name}`, 'pack', '--pack-destination', temp], { cwd: root });
  const prefix = name === 'core' ? 'portable-agent-asset-hub-core-' : `portable-agent-asset-hub-${name}-`;
  const file = (await readdir(temp)).find((entry) => entry.startsWith(prefix) && entry.endsWith('.tgz'));
  if (!file) throw new Error(`package artifact missing: ${name}`);
  return join(temp, file);
}

try {
  const corePath = await pack('core');
  const rawFilesPath = await pack('storage-files');
  const filesEditRoot = join(temp, 'storage-files-edit');
  await mkdir(join(filesEditRoot, 'package'), { recursive: true });
  await exec('tar', ['-xzf', rawFilesPath, '-C', filesEditRoot]);
  const filesManifestPath = join(filesEditRoot, 'package', 'package.json');
  const filesManifest = JSON.parse(await readFile(filesManifestPath, 'utf8'));
  filesManifest.dependencies['@portable-agent-asset-hub/core'] = `file:${corePath}`;
  await writeFile(filesManifestPath, JSON.stringify(filesManifest, null, 2));
  const filesRepacked = await exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], { cwd: join(filesEditRoot, 'package') });
  const filesPath = join(temp, JSON.parse(filesRepacked.stdout)[0].filename);

  const rawStoragePath = await pack('storage-sqlite');
  const editRoot = join(temp, 'storage-edit');
  await mkdir(join(editRoot, 'package'), { recursive: true });
  await exec('tar', ['-xzf', rawStoragePath, '-C', editRoot]);
  const manifestPath = join(editRoot, 'package', 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.dependencies['@portable-agent-asset-hub/core'] = `file:${corePath}`;
  manifest.dependencies['@portable-agent-asset-hub/storage-files'] = `file:${filesPath}`;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  const repacked = await exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], { cwd: join(editRoot, 'package') });
  const storagePath = join(temp, JSON.parse(repacked.stdout)[0].filename);
  await writeFile(join(temp, 'package.json'), JSON.stringify({
    name: 's2-external-consumer',
    private: true,
    type: 'module',
    dependencies: {
      '@portable-agent-asset-hub/core': `file:${corePath}`,
      '@portable-agent-asset-hub/storage-sqlite': `file:${storagePath}`,
    },
  }, null, 2));
  await exec('pnpm', ['install', '--offline', '--ignore-scripts', '--lockfile=false', '--registry', registry], {
    cwd: temp,
    env: { ...process.env, npm_config_registry: registry },
    maxBuffer: 50 * 1024 * 1024,
  });
  const smoke = `
    import { mkdtemp, rm } from 'node:fs/promises';
    import { join } from 'node:path';
    import { tmpdir } from 'node:os';
    import { createActorContextFromAuthenticated } from '@portable-agent-asset-hub/core';
    import * as storageApi from '@portable-agent-asset-hub/storage-sqlite';
    const { SqliteStore } = storageApi;
    const dir = await mkdtemp(join(tmpdir(), 's2-installed-db-'));
    const path = join(dir, 'hub.sqlite');
    const actor = createActorContextFromAuthenticated({ userId: 'usr_runtime', agentId: 'agt_runtime', role: 'agent', capabilities: [] });
    if (['HubDatabase', 'doctor', 'migrate', 'loadMigrations'].some((name) => name in storageApi)) process.exit(3);
    let deepImportBlocked = false;
    try { await import('@portable-agent-asset-hub/storage-sqlite/database.js'); } catch (error) { deepImportBlocked = error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'; }
    if (!deepImportBlocked) process.exit(4);
    try {
      const first = new SqliteStore(path);
      first.transaction(actor, (tx) => {
        const user = tx.identities.createUser({ displayName: 'External' });
        tx.identities.createAgent({ ownerUserId: user.id, name: 'Agent' });
      });
      first.close();
      const second = new SqliteStore(path);
      const summary = { doctor: second.doctor().ok, users: second.diagnostics().counts.users, agents: second.diagnostics().counts.agents };
      second.close();
      if (!summary.doctor || summary.users !== 1 || summary.agents !== 1) process.exit(2);
      console.log(JSON.stringify(summary));
    } finally { await rm(dir, { recursive: true, force: true }); }
  `;
  await writeFile(join(temp, 'smoke.mjs'), smoke);
  const result = await exec(process.execPath, ['smoke.mjs'], { cwd: temp, maxBuffer: 1024 * 1024 });
  const summary = result.stdout.trim().split('\n').at(-1);
  if (!summary) throw new Error('external smoke produced no summary');
  console.log(summary);
} finally {
  await rm(temp, { recursive: true, force: true });
}
