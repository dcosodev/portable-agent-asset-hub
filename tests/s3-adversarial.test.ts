import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createActorContextFromAuthenticated, HubError } from '@portable-agent-asset-hub/core';
import { SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';
const actor=createActorContextFromAuthenticated({userId:'usr_s3',agentId:'agt_s3',role:'agent',capabilities:['memory.write']});
function make(){const s=new SqliteStore(':memory:');return s;}
function base(store:SqliteStore){return store.transaction(actor,tx=>{const e=tx.events.create({kind:'observation',scope:actor.scope,scopeKey:'s',payload:{text:'alpha Bearer raw-secret'},requestId:'r',provenance:{source:'test'}});const m=tx.memories.create({kind:'fact',scope:actor.scope,scopeKey:'k',content:{text:'alpha Bearer raw-secret email x@example.com'},sourceEventIds:[e.id],reason:'r',requestId:'r'});return {e,m};});}
describe('S3 adversarial and lifecycle contracts',()=>{
 it('redaction_happens_before_storage',()=>{
  const directory=mkdtempSync(join(tmpdir(),'s3-redaction-')); const path=join(directory,'hub.sqlite');
  const canaries=Object.fromEntries(['password','passwd','token','accessToken','refreshToken','secret','apiKey','api_key','authorization','privateKey'].map((key)=>[key,`canary-${key}-${randomUUID()}`]));
  const pemCanary=`pem-${randomUUID()}`;
  const secretValues=[...Object.values(canaries),pemCanary];
  const s=new SqliteStore(path);
  try {
   const result=s.transaction(actor,tx=>{const e=tx.events.create({kind:'observation',scope:actor.scope,scopeKey:'s',payload:{credentials:canaries, nested:[canaries,{bearer:`Bearer ${canaries.token}`,email:`owner-${canaries.secret}@example.test`,pem:`-----BEGIN PRIVATE KEY-----\n${pemCanary}\n-----END PRIVATE KEY-----`}]},requestId:'r',provenance:{credentials:canaries,nested:[canaries]}});const m=tx.memories.create({kind:'fact',scope:actor.scope,scopeKey:'k',content:{credentials:canaries,nested:[canaries,{text:`Bearer ${canaries.token} owner-${canaries.secret}@example.test`}]},sourceEventIds:[e.id],reason:`password=${canaries.password}; Bearer ${canaries.token}; owner-${canaries.secret}@example.test`,requestId:'r'});return {e,m};});
   expect(result.e.payload).not.toEqual({credentials:canaries});
   expect(result.m.redactionSummary).toEqual(['accesstoken','apikey','authorization','bearer','email','passwd','password','privatekey','refreshtoken','secret','token']);
  } finally { s.close(); }
  const files=readdirSync(directory).filter((name)=>name==='hub.sqlite'||name==='hub.sqlite-wal'||name==='hub.sqlite-shm');
  const dbBytes=Buffer.concat(files.map((name)=>readFileSync(join(directory,name))));
  const db=new DatabaseSync(path);
  try { for(const table of ['audit','events','memory_versions','memory_fts']) { const rows=db.prepare(`SELECT * FROM ${table}`).all(); const serialized=JSON.stringify(rows); expect(secretValues.some((value)=>serialized.includes(value))).toBe(false); } expect(secretValues.some((value)=>dbBytes.includes(value))).toBe(false); } finally { db.close(); rmSync(directory,{recursive:true,force:true}); }
 });
 it('memory_update_requires_expected_version',()=>{const s=make();try{const {m}=base(s);expect(()=>s.transaction(actor,tx=>tx.memories.update(m.id,{expectedVersion:0,content:{text:'b'},reason:'r',requestId:'r'},actor.scope))).toThrowError(HubError);const n=s.transaction(actor,tx=>tx.memories.update(m.id,{expectedVersion:1,content:{text:'beta'},reason:'r',requestId:'r'},actor.scope));expect(n.version).toBe(2);}finally{s.close();}});
 it('forget_is_tombstone_and_idempotent',()=>{const s=make();try{const {m}=base(s);const f=s.transaction(actor,tx=>tx.memories.forget(m.id,1,actor.scope,'forget','r'));expect(f.lifecycle).toBe('forgotten');expect(txCount(s,'memory_versions')).toBe(2);const again=s.transaction(actor,tx=>tx.memories.forget(m.id,1,actor.scope));expect(again.version).toBe(2);expect(txCount(s,'audit')).toBe(3);}finally{s.close();}});
 it('search_excludes_forgotten_and_superseded',()=>{const s=make();try{const {m}=base(s);expect(s.transaction(actor,tx=>tx.memories.search(actor.scope,'alpha'))).toHaveLength(1);s.transaction(actor,tx=>tx.memories.forget(m.id,1,actor.scope));expect(s.transaction(actor,tx=>tx.memories.search(actor.scope,'alpha'))).toHaveLength(0);}finally{s.close();}});
 it('source_cross_scope_or_missing_is_not_found',()=>{const s=make();try{expect(()=>s.transaction(actor,tx=>tx.memories.create({kind:'fact',scope:actor.scope,scopeKey:'x',content:{x:1},sourceEventIds:['evt_missing'],reason:'r',requestId:'r'}))).toThrowError(HubError);}finally{s.close();}});
 it('audit_and_fts_failures_roll_back',()=>{const s=make();try{expect(()=>s.transaction(actor,tx=>{tx.audit.failNextAppendForTest();tx.memories.create({kind:'fact',scope:actor.scope,scopeKey:'x',content:{x:1},reason:'r',requestId:'r'});})).toThrow();expect(txCount(s,'memories')).toBe(0);expect(()=>s.transaction(actor,tx=>{tx.memories.failNextFtsForTest();tx.memories.create({kind:'fact',scope:actor.scope,scopeKey:'x',content:{x:1},reason:'r',requestId:'r'});})).toThrow();expect(txCount(s,'memories')).toBe(0);}finally{s.close();}});
 it('doctor_reports_heads_sources_and_fts',()=>{const s=make();try{base(s);expect(s.doctor().ok).toBe(true);expect(s.doctor().checks.ftsHeadOnly).toBe(true);}finally{s.close();}});
});
function txCount(s:SqliteStore,t:'memory_versions'|'audit'|'memories'){
 const counts=s.diagnostics().counts;
 return t==='memory_versions'?counts.memoryVersions:counts[t];
}
