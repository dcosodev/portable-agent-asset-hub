import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(new URL('..', import.meta.url).pathname);
const temp = await mkdtemp(join(tmpdir(), 's3-external-install-'));
const registry = 'http://127.0.0.1:9';

async function pack(name) {
  await exec('pnpm', ['--filter', `@portable-agent-asset-hub/${name}`, 'pack', '--pack-destination', temp], { cwd: root, maxBuffer: 20 * 1024 * 1024 });
  const files = await readdir(temp);
  const prefix = name === 'core' ? 'portable-agent-asset-hub-core-' : `portable-agent-asset-hub-${name}-`;
  const file = files.find((entry) => entry.startsWith(prefix) && entry.endsWith('.tgz'));
  if (!file) throw new Error('package artifact missing');
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
    name: 's3-external-consumer', private: true, type: 'module',
    dependencies: {
      '@portable-agent-asset-hub/core': `file:${corePath}`,
      '@portable-agent-asset-hub/storage-sqlite': `file:${storagePath}`,
    },
  }, null, 2));
  await exec('pnpm', ['install', '--offline', '--ignore-scripts', '--lockfile=false', '--registry', registry], { cwd: temp, env: { ...process.env, npm_config_registry: registry }, maxBuffer: 50 * 1024 * 1024 });

  const smoke = `
    import { createHash } from 'node:crypto';
    import { join } from 'node:path';
    import { mkdtemp, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { createActorContextFromAuthenticated } from '@portable-agent-asset-hub/core';
    import * as storageApi from '@portable-agent-asset-hub/storage-sqlite';
    const { SqliteStore } = storageApi;
    const dir = await mkdtemp(join(tmpdir(), 's3-installed-db-'));
    const db = join(dir, 'hub.sqlite');
    const actor = createActorContextFromAuthenticated({ userId: 'usr_external', agentId: 'agt_external', role: 'agent', capabilities: ['memory.write', 'event.write'] });
    if (['HubDatabase', 'doctor', 'migrate', 'loadMigrations'].some((name) => name in storageApi)) process.exit(3);
    let deepImportBlocked = false;
    try { await import('@portable-agent-asset-hub/storage-sqlite/database.js'); } catch (error) { deepImportBlocked = error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'; }
    if (!deepImportBlocked) process.exit(4);
    let eventId; let memoryId;
    try {
      const first = new SqliteStore(db);
      first.transaction(actor, (tx) => { const event = tx.events.create({ kind: 'observation', scope: actor.scope, scopeKey: 'external', payload: { text: 'external durable' }, requestId: 'external-1', provenance: { source: 'external' } }); eventId = event.id; const memory = tx.memories.create({ kind: 'fact', scope: actor.scope, scopeKey: 'external', content: { text: 'external durable' }, sourceEventIds: [event.id], reason: 'external', requestId: 'external-1' }); memoryId = memory.id; });
      first.close();
      const second = new SqliteStore(db);
      const doctor = second.doctor();
      const replay = second.transaction(actor, (tx) => ({ memory: tx.memories.getOrThrow(memoryId, actor.scope), search: tx.memories.search(actor.scope, 'durable'), history: tx.memories.history(memoryId, actor.scope), provenance: tx.memories.provenance(memoryId, actor.scope), event: tx.events.get(eventId, actor.scope) }));
      if (!doctor.ok || replay.search.length !== 1 || replay.history.length !== 1 || replay.history[0].version !== 1 || replay.history[0].lifecycle !== 'candidate' || JSON.stringify(replay.provenance) !== JSON.stringify([eventId]) || replay.event?.id !== eventId || JSON.stringify(replay.event.provenance) !== JSON.stringify({ source: 'external' })) process.exit(2);
      const summary = { doctor: true, memoryCount: replay.search.length, historyCount: replay.history.length, sourceCount: replay.provenance.length, eventCount: replay.event ? 1 : 0 };
      const digest = createHash('sha256').update(JSON.stringify(summary)).digest('hex');
      console.log(JSON.stringify({ ...summary, digest }));
      second.close();
    } finally { await rm(dir, { recursive: true, force: true }); }
  `;
  await writeFile(join(temp, 'smoke.mjs'), smoke);
  const result = await exec(process.execPath, ['smoke.mjs'], { cwd: temp, maxBuffer: 1024 * 1024 });
  const output = result.stdout.trim().split('\n').at(-1);
  if (!output) throw new Error('external smoke produced no summary');
  console.log(output);
} finally {
  await rm(temp, { recursive: true, force: true });
}
