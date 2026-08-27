import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(new URL('..', import.meta.url).pathname);
const temp = await mkdtemp(join(tmpdir(), 's5-external-install-'));
const registry = 'http://127.0.0.1:9';

async function pack(name) {
  await exec('pnpm', ['--filter', `@portable-agent-asset-hub/${name}`, 'pack', '--pack-destination', temp], { cwd: root, maxBuffer: 20 * 1024 * 1024 });
  const prefix = `portable-agent-asset-hub-${name}-`;
  const file = (await readdir(temp)).find((entry) => entry.startsWith(prefix) && entry.endsWith('.tgz'));
  if (!file) throw new Error(`${name}: package artifact missing`);
  return join(temp, file);
}

async function repackWithOverrides(name, rawPath, overrides) {
  const editRoot = join(temp, `${name}-edit`);
  await mkdir(editRoot, { recursive: true });
  await exec('tar', ['-xzf', rawPath, '-C', editRoot]);
  const manifestPath = join(editRoot, 'package', 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  for (const [dependency, filePath] of Object.entries(overrides)) {
    manifest.dependencies[dependency] = `file:${filePath}`;
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const packed = await exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], {
    cwd: join(editRoot, 'package'), maxBuffer: 20 * 1024 * 1024,
  });
  return join(temp, JSON.parse(packed.stdout)[0].filename);
}

try {
  const corePath = await pack('core');
  const filesPath = await repackWithOverrides('storage-files', await pack('storage-files'), { '@portable-agent-asset-hub/core': corePath });
  const storagePath = await repackWithOverrides('storage-sqlite', await pack('storage-sqlite'), {
    '@portable-agent-asset-hub/core': corePath,
    '@portable-agent-asset-hub/storage-files': filesPath,
  });
  const app = join(temp, 'consumer');
  await mkdir(app);
  await writeFile(join(app, 'package.json'), `${JSON.stringify({
    name: 's5-external-consumer', private: true, type: 'module',
    dependencies: {
      '@portable-agent-asset-hub/core': `file:${corePath}`,
      '@portable-agent-asset-hub/storage-sqlite': `file:${storagePath}`,
      '@portable-agent-asset-hub/storage-files': `file:${filesPath}`,
    },
  }, null, 2)}\n`);
  await exec('pnpm', ['install', '--offline', '--ignore-scripts', '--lockfile=false', '--registry', registry], {
    cwd: app, env: { ...process.env, npm_config_registry: registry }, maxBuffer: 50 * 1024 * 1024,
  });

  const smoke = `
    import { createHash } from 'node:crypto';
    import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { ProfileService, createActorContext, materializeProfile } from '@portable-agent-asset-hub/core';
    import { CatalogSyncCoordinator, FileMaterializer, FileSyncMarker, RootScanner } from '@portable-agent-asset-hub/storage-files';
    import * as storageApi from '@portable-agent-asset-hub/storage-sqlite';
    if (['HubDatabase','doctor','migrate','loadMigrations','ProfileRepository'].some((name)=>name in storageApi)) process.exit(3);
    let deepBlocked=false; try { await import('@portable-agent-asset-hub/storage-sqlite/profile-repository.js'); } catch(error) { deepBlocked=error?.code==='ERR_PACKAGE_PATH_NOT_EXPORTED'; }
    if(!deepBlocked) process.exit(4);
    const root=join(process.cwd(),'runtime'); const db=join(root,'hub.sqlite');
    const actor=createActorContext({userId:'usr_external',agentId:'agt_external',role:'user',capabilities:[]});
    const mutation=(reason)=>({reason,requestId:'req-'+reason});
    try {
      await mkdir(root,{recursive:true});
      const first=new storageApi.SqliteStore(db); const profiles=new ProfileService(first,actor);
      profiles.create({id:'prf_external',scope:actor.scope,version:1,blocks:[{blockId:'user',ordinal:1,kind:'USER',body:'external'}]},mutation('create'));
      const targetDigest=materializeProfile(profiles.get('prf_external')).digest;
      const preview=profiles.previewImport('prf_external','---\\n',targetDigest,mutation('preview'));
      profiles.applyImport(preview.id,preview.digest,targetDigest,mutation('apply'));
      new FileMaterializer(root).materializeProfile(first,actor,'prf_external','profile.md',mutation('materialize'));
      const sourceRoot=join(root,'sources'); await mkdir(sourceRoot,{recursive:true});
      const sourceBytes=Buffer.from('catalog\\\\n'); await writeFile(join(sourceRoot,'catalog.md'),sourceBytes);
      const markerRoot=join(root,'markers');
      const marker=new FileSyncMarker(markerRoot,'catalog.marker');
      const coordinator=new CatalogSyncCoordinator({storage:first,actor,scanner:new RootScanner(),marker});
      const catalogPreview=coordinator.preview({profileId:'prf_external',roots:[{id:'sources',path:sourceRoot}]},mutation('catalog-preview'));
      coordinator.review(catalogPreview.id,catalogPreview.digest,mutation('catalog-review'));
      coordinator.apply(catalogPreview.id,catalogPreview.digest,mutation('catalog-apply'));
      const catalogRows=first.transaction(actor,(tx)=>tx.catalog.list(actor.scope));
      const catalogSources=first.transaction(actor,(tx)=>tx.catalog.listSources(actor.scope));
      const catalogStats=first.transaction(actor,(tx)=>tx.catalog.stats(actor.scope));
      const markerBytes=marker.read();
      if(catalogRows.length!==1||catalogStats.entries!==1||catalogStats.versions!==1||catalogStats.sources!==1||catalogStats.links!==1||catalogStats.relations!==0||markerBytes.toString()!==catalogPreview.digest) process.exit(5);
      const expectedSourceDigest=createHash('sha256').update(sourceBytes).digest('hex');
      if(catalogSources.length!==1||catalogSources[0].fingerprint!==expectedSourceDigest||catalogSources[0].locator!=='catalog.md'||catalogRows[0].metadata.sha256!==expectedSourceDigest||catalogRows[0].metadata.rootId!=='sources'||catalogRows[0].metadata.relativePath!=='catalog.md') process.exit(7);
      const markerStat=await import('node:fs/promises').then(({stat})=>stat(join(markerRoot,'catalog.marker')));
      const auditBeforeReplay=first.transaction(actor,(tx)=>tx.audit.list(actor.scope).length);
      coordinator.apply(catalogPreview.id,catalogPreview.digest,mutation('catalog-replay'));
      const markerStatReplay=await import('node:fs/promises').then(({stat})=>stat(join(markerRoot,'catalog.marker')));
      const replayStats=first.transaction(actor,(tx)=>tx.catalog.stats(actor.scope));
      if(JSON.stringify(replayStats)!==JSON.stringify(catalogStats)||first.transaction(actor,(tx)=>tx.audit.list(actor.scope).length)!==auditBeforeReplay||markerStatReplay.mtimeMs!==markerStat.mtimeMs) process.exit(6);
      const driftPreview=coordinator.preview({profileId:'prf_external',roots:[{id:'sources',path:sourceRoot}]},mutation('target-drift-preview'));
      coordinator.review(driftPreview.id,driftPreview.digest,mutation('target-drift-review'));
      await writeFile(join(markerRoot,'catalog.marker'),'tampered');
      let targetDriftRejected=false; try { coordinator.apply(driftPreview.id,driftPreview.digest,mutation('target-drift-apply')); } catch { targetDriftRejected=true; }
      if(!targetDriftRejected||first.transaction(actor,(tx)=>tx.catalog.stats(actor.scope)).versions!==catalogStats.versions) process.exit(8);
      marker.write(markerBytes);
      first.close();
      const second=new storageApi.SqliteStore(db); const reopened=new ProfileService(second,actor);
      const current=reopened.get('prf_external'); const bytes=await readFile(join(root,'profile.md'));
      const history=reopened.history('prf_external');
      const records=second.transaction(actor,(tx)=>tx.materializations.list('prf_external',actor.scope));
      const restored=reopened.restore('prf_external',1,2,mutation('restore'));
      const doctor=second.doctor(); second.close();
      if(!doctor.ok||current.version!==2||history.length!==2||records.length!==1||restored.version!==3||!bytes.equals(materializeProfile(current).bytes)) process.exit(2);
      const summary={doctor:true,historyCount:history.length,materializationCount:records.length,restoredVersion:restored.version};
      console.log(JSON.stringify({...summary,digest:createHash('sha256').update(JSON.stringify(summary)).digest('hex')}));
    } finally { await rm(root,{recursive:true,force:true}); }
  `;
  await writeFile(join(app, 'smoke.mjs'), smoke);
  const result = await exec(process.execPath, ['smoke.mjs'], { cwd: app, maxBuffer: 2 * 1024 * 1024 });
  const output = result.stdout.trim().split('\n').at(-1);
  if (!output) throw new Error('external smoke produced no summary');
  console.log(output);
} finally {
  await rm(temp, { recursive: true, force: true });
}
