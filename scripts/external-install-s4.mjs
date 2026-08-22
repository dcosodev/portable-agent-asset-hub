import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(new URL('..', import.meta.url).pathname);
const temp = await mkdtemp(join(tmpdir(), 's4-external-install-'));
const registry = 'http://127.0.0.1:9';

async function pack(name) {
  await exec('pnpm', ['--filter', `@portable-agent-asset-hub/${name}`, 'pack', '--pack-destination', temp], { cwd: root, maxBuffer: 20 * 1024 * 1024 });
  const prefix = `portable-agent-asset-hub-${name}-`;
  const file = (await readdir(temp)).find((entry) => entry.startsWith(prefix) && entry.endsWith('.tgz'));
  if (!file) throw new Error(`${name}: package artifact missing`);
  return join(temp, file);
}

async function repackWithCore(name, rawPath, corePath) {
  const editRoot = join(temp, `${name}-edit`);
  await mkdir(editRoot, { recursive: true });
  await exec('tar', ['-xzf', rawPath, '-C', editRoot]);
  const manifestPath = join(editRoot, 'package', 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.dependencies['@portable-agent-asset-hub/core'] = `file:${corePath}`;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const packed = await exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], {
    cwd: join(editRoot, 'package'), maxBuffer: 20 * 1024 * 1024,
  });
  return join(temp, JSON.parse(packed.stdout)[0].filename);
}

try {
  const corePath = await pack('core');
  const storagePath = await repackWithCore('storage-sqlite', await pack('storage-sqlite'), corePath);
  const filesPath = await repackWithCore('storage-files', await pack('storage-files'), corePath);
  const app = join(temp, 'consumer');
  await mkdir(app);
  await writeFile(join(app, 'package.json'), `${JSON.stringify({
    name: 's4-external-consumer', private: true, type: 'module',
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
    import { mkdir, readFile, rm } from 'node:fs/promises';
    import { join } from 'node:path';
    import { ProfileService, createActorContext, materializeProfile } from '@portable-agent-asset-hub/core';
    import { FileMaterializer } from '@portable-agent-asset-hub/storage-files';
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
