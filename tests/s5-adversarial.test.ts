import { describe, expect, it } from 'vitest';
import {
  HubError,
  SyncService,
  canonicalDigest,
  createActorContext,
  type CatalogCandidate,
  type CatalogRepository,
  type CatalogScanner,
  type CatalogSyncRepository,
  type SyncPreview,
} from '@portable-agent-asset-hub/core';
import { SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';
import { FileSyncMarker, RootScanner } from '@portable-agent-asset-hub/storage-files';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const actor = createActorContext({
  userId: 'usr_s5_drift',
  agentId: 'agt_s5_drift',
  role: 'user',
  capabilities: [],
});
const meta = { reason: 's5 drift regression', requestId: 'req_s5_drift' };

function document(bytes: string, relativePath = 'doc.md'): CatalogCandidate {
  return {
    kind: 'document',
    rootId: 'docs',
    relativePath,
    locator: relativePath,
    bytes: Buffer.from(bytes),
    metadata: { name: relativePath },
  };
}

describe('S5 adversarial drift contract', () => {
  it('root_scanner_rejects_intermediate_directory_replacement_without_reading_canary', () => {
    const base=mkdtempSync(join(tmpdir(),'s5-toctou-')); const root=join(base,'root'); const outside=join(base,'outside');
    mkdirSync(root); mkdirSync(outside); writeFileSync(join(outside,'canary.md'),'do-not-read'); writeFileSync(join(root,'safe.md'),'safe');
    let tripped=false; const scanner=new RootScanner({beforeOpen:(path,type)=>{if(type==='directory'&&!tripped&&path.endsWith('/root')){tripped=true;renameSync(root,join(base,'root-real'));symlinkSync(outside,root);}}});
    try { expect(()=>scanner.scan({roots:[{id:'root',path:root}]})).toThrow(); expect(readFileSync(join(outside,'canary.md'),'utf8')).toBe('do-not-read'); } finally { rmSync(base,{recursive:true,force:true}); }
  });

  it('root_scanner_rejects_declared_root_replacement_before_realpath',()=>{
    const base=mkdtempSync(join(tmpdir(),'s5-root-race-')),root=join(base,'root'),outside=join(base,'outside');mkdirSync(root);mkdirSync(outside);writeFileSync(join(outside,'canary.md'),'do-not-read');
    const scanner=new RootScanner({afterRootLstat:()=>{renameSync(root,join(base,'root-real'));symlinkSync(outside,root);}});
    try{expect(()=>scanner.scan({roots:[{id:'root',path:root}]})).toThrow(/root identity changed/);expect(readFileSync(join(outside,'canary.md'),'utf8')).toBe('do-not-read');}finally{rmSync(base,{recursive:true,force:true});}
  });

  it('marker_rejects_ancestor_symlink_replacement_and_cleans_temp', () => {
    const base=mkdtempSync(join(tmpdir(),'s5-marker-toctou-')); const external=join(base,'external'); const parent=join(base,'managed');
    mkdirSync(external); mkdirSync(parent,{mode:0o700}); writeFileSync(join(external,'marker'),'canary'); const marker=new FileSyncMarker(base,'managed/marker',{beforeRename:()=>{renameSync(parent,join(base,'managed-real'));symlinkSync(external,parent);}});
    try { expect(()=>marker.write(Buffer.from('new'))).toThrow(); expect(readFileSync(join(external,'marker'),'utf8')).toBe('canary'); } finally { rmSync(base,{recursive:true,force:true}); }
  });

  it('marker_creates_private_parents_and_rejects_existing_insecure_parent',()=>{
    const base=mkdtempSync(join(tmpdir(),'s5-marker-mode-'));
    try{const marker=new FileSyncMarker(base,'private/nested/marker');marker.write(Buffer.from('ok'));expect(statSync(join(base,'private')).mode&0o077).toBe(0);expect(statSync(join(base,'private','nested')).mode&0o077).toBe(0);const insecure=join(base,'insecure');mkdirSync(insecure);chmodSync(insecure,0o755);expect(()=>new FileSyncMarker(base,'insecure/marker').write(Buffer.from('no'))).toThrow(/private owned/);}finally{rmSync(base,{recursive:true,force:true});}
  });

  it('apply_rejects_all_drift_classes', async () => {
    const roots=[{id:'docs',path:'/logical/docs'}];
    const runSourceSetDrift=async(next:CatalogCandidate[])=>{
      const dir=mkdtempSync(join(tmpdir(),'s5-source-matrix-')),store=new SqliteStore(join(dir,'hub.sqlite'));let candidates=[document('reviewed bytes')];const scanner:CatalogScanner={scan:()=>candidates};
      try{const preview=store.transaction(actor,(tx)=>new SyncService(scanner,{catalog:tx.catalog,sync:tx.catalogSync}).previewSync({roots,scope:actor.scope,profile:'prf_drift'},meta));store.transaction(actor,(tx)=>tx.catalogSync.review(preview.id,preview.digest,actor.scope,meta));candidates=next;const before=store.transaction(actor,(tx)=>({stats:tx.catalog.stats(actor.scope),audit:tx.audit.list(actor.scope).length}));expect(()=>store.transaction(actor,(tx)=>new SyncService(scanner,{catalog:tx.catalog,sync:tx.catalogSync}).apply({previewId:preview.id,reviewedDigest:preview.digest,scope:actor.scope,meta}))).toThrow(/source|input|digest|drift/i);expect(store.transaction(actor,(tx)=>({stats:tx.catalog.stats(actor.scope),audit:tx.audit.list(actor.scope).length}))).toEqual(before);}finally{store.close();rmSync(dir,{recursive:true,force:true});}
    };
    await runSourceSetDrift([document('changed after review')]);
    await runSourceSetDrift([document('reviewed bytes'),document('added','added.md')]);
    await runSourceSetDrift([]);
    await runSourceSetDrift([document('reviewed bytes'),document('duplicate bytes')]);

    const base=await new SyncService({scan:()=>[document('reviewed bytes')]}).preview({roots,scope:actor.scope,profile:'prf_drift'});base.reviewedDigest=base.digest;
    const catalog={list:()=>[],getByLogicalKey:()=>{throw new HubError('NOT_FOUND','missing',404)}} as unknown as CatalogRepository;
    const rejectPersistedChange=(change:(preview:SyncPreview)=>SyncPreview)=>{const changed=change(structuredClone(base));const sync={getPreview:()=>changed} as unknown as CatalogSyncRepository;expect(()=>new SyncService({scan:()=>[document('reviewed bytes')]},{catalog,sync}).apply({previewId:base.id,reviewedDigest:base.digest,scope:actor.scope,meta})).toThrow(/root|input|digest|drift/i);};
    rejectPersistedChange((preview)=>({...preview,roots:[{id:'docs',path:'/changed/root'}]}));
    rejectPersistedChange((preview)=>({...preview,selectors:['changed']}));

    const runDependencyDrift=(kind:'catalog'|'profile'|'target')=>{const dir=mkdtempSync(join(tmpdir(),'s5-dependency-matrix-')),store=new SqliteStore(join(dir,'hub.sqlite'));const scanner:CatalogScanner={scan:()=>[document('reviewed bytes')]};let profile=canonicalDigest('profile-v1'),target=canonicalDigest('target-v1');try{const preview=store.transaction(actor,(tx)=>new SyncService(scanner,{catalog:tx.catalog,sync:tx.catalogSync,profileFingerprint:()=>profile,targetFingerprint:()=>target}).previewSync({roots,scope:actor.scope,profile:'prf_drift'},meta));store.transaction(actor,(tx)=>tx.catalogSync.review(preview.id,preview.digest,actor.scope,meta));if(kind==='profile')profile=canonicalDigest('profile-v2');if(kind==='target')target=canonicalDigest('target-v2');if(kind==='catalog')store.transaction(actor,(tx)=>tx.catalog.upsert({id:'cat_concurrent',scope:actor.scope,logicalKey:'document:other:concurrent.md',kind:'document',name:'concurrent',lifecycle:'active',currentVersion:1,metadata:{rootId:'other',relativePath:'concurrent.md'}},undefined,meta));const before=store.transaction(actor,(tx)=>({stats:tx.catalog.stats(actor.scope),audit:tx.audit.list(actor.scope).length}));expect(()=>store.transaction(actor,(tx)=>new SyncService(scanner,{catalog:tx.catalog,sync:tx.catalogSync,profileFingerprint:()=>profile,targetFingerprint:()=>target}).apply({previewId:preview.id,reviewedDigest:preview.digest,scope:actor.scope,meta}))).toThrow(/catalog|profile|target|drift/i);expect(store.transaction(actor,(tx)=>({stats:tx.catalog.stats(actor.scope),audit:tx.audit.list(actor.scope).length}))).toEqual(before);}finally{store.close();rmSync(dir,{recursive:true,force:true});}};
    runDependencyDrift('catalog');runDependencyDrift('profile');runDependencyDrift('target');

    const dir=mkdtempSync(join(tmpdir(),'s5-scope-matrix-')),store=new SqliteStore(join(dir,'hub.sqlite'));const scanner:CatalogScanner={scan:()=>[document('reviewed bytes')]};try{const preview=store.transaction(actor,(tx)=>new SyncService(scanner,{catalog:tx.catalog,sync:tx.catalogSync}).previewSync({roots,scope:actor.scope,profile:'prf_drift'},meta));store.transaction(actor,(tx)=>tx.catalogSync.review(preview.id,preview.digest,actor.scope,meta));const other=createActorContext({userId:'usr_other_drift',agentId:'agt_other_drift',role:'user',capabilities:[]});expect(()=>store.transaction(other,(tx)=>new SyncService(scanner,{catalog:tx.catalog,sync:tx.catalogSync}).apply({previewId:preview.id,reviewedDigest:preview.digest,scope:other.scope,meta}))).toThrow(HubError);}finally{store.close();rmSync(dir,{recursive:true,force:true});}
  });
});
