import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { loadMigrations } from './migrations/runner.js';
import { catalogSyncDigest, boundedSummary, rootBindingsFingerprint, safeRelativeLocator, sanitizeMetadata } from '@portable-agent-asset-hub/core';

type Row = Record<string, unknown>;
export type DoctorReport = { ok: boolean; checks: Record<string, boolean>; errors: string[] };

export function doctor(
  db: DatabaseSync,
  migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), 'migrations'),
): DoctorReport {
  const checks: Record<string, boolean> = {};
  const errors: string[] = [];
  try { checks.integrity = (db.prepare('PRAGMA integrity_check').get() as Row).integrity_check === 'ok'; } catch { checks.integrity = false; }
  try { checks.foreignKeys = db.prepare('PRAGMA foreign_key_check').all().length === 0; } catch { checks.foreignKeys = false; }
  try {
    const rows = db.prepare('SELECT version,name,checksum FROM schema_meta ORDER BY version').all() as Row[];
    const expected = loadMigrations(migrationDirectory);
    checks.migrations = rows.length === expected.length && rows.every((row, index) => {
      const migration = expected[index];
      return Number(row.version) === index + 1 && Number(row.version) === migration.version &&
        row.name === migration.name &&
        row.checksum === migration.checksum;
    });
  } catch { checks.migrations = false; }
  try {
    const row = db.prepare("SELECT COUNT(*) AS total,COUNT(DISTINCT id) AS distinct_ids FROM (SELECT id FROM users UNION ALL SELECT id FROM agents UNION ALL SELECT id FROM harnesses UNION ALL SELECT id FROM bindings)").get() as Row;
    checks.uniqueIds = Number(row.total) === Number(row.distinct_ids);
  } catch { checks.uniqueIds = false; }
  try {
    checks.orphans = Number((db.prepare('SELECT COUNT(*) AS count FROM bindings b LEFT JOIN users u ON u.id=b.owner_user_id LEFT JOIN agents a ON a.id=b.agent_id LEFT JOIN harnesses h ON h.id=b.harness_id WHERE u.id IS NULL OR a.id IS NULL OR h.id IS NULL').get() as Row).count) === 0;
  } catch { checks.orphans = false; }
  try { checks.idempotency = Number((db.prepare('SELECT COUNT(*) AS count FROM idempotency WHERE status NOT BETWEEN 200 AND 299').get() as Row).count) === 0; } catch { checks.idempotency = false; }
  try { checks.audit = Number((db.prepare("SELECT COUNT(*) AS count FROM audit WHERE id IS NULL OR action IS NULL OR actor_user_id IS NULL OR actor_agent_id IS NULL OR owner_user_id IS NULL OR scope_agent_id IS NULL OR created_at IS NULL").get() as Row).count) === 0; } catch { checks.audit = false; }
  try { checks.memoryHeads = Number((db.prepare("SELECT COUNT(*) AS bad FROM memories m LEFT JOIN memory_versions v ON v.memory_id=m.id AND v.version=m.current_version WHERE v.memory_id IS NULL OR m.current_version<1").get() as Row).bad) === 0; } catch { checks.memoryHeads = false; }
  try { checks.profileHeads = Number((db.prepare("SELECT COUNT(*) AS bad FROM profiles p LEFT JOIN profile_versions v ON v.id=p.id AND v.owner_user_id=p.owner_user_id AND v.scope_agent_id=p.scope_agent_id AND v.version=p.current_version WHERE v.id IS NULL OR p.current_version<1").get() as Row).bad) === 0; } catch { checks.profileHeads = false; }
  try {
    const rows = db.prepare("SELECT v.id,v.owner_user_id,v.scope_agent_id,v.version,p.current_version FROM profile_versions v LEFT JOIN profiles p ON p.id=v.id AND p.owner_user_id=v.owner_user_id AND p.scope_agent_id=v.scope_agent_id ORDER BY v.id,v.owner_user_id,v.scope_agent_id,v.version").all() as Row[];
    const grouped = new Map<string, number[]>(); let ok=true;
    for (const r of rows) { if (r.current_version===null || Number(r.version)<1) ok=false; const k=`${r.id}|${r.owner_user_id}|${r.scope_agent_id}`; grouped.set(k,[...(grouped.get(k)??[]),Number(r.version)]); }
    for (const versions of grouped.values()) versions.forEach((v,i)=>{if(v!==i+1)ok=false;}); checks.profileVersions=ok;
  } catch { checks.profileVersions = false; }
  try {
    const rows=db.prepare('SELECT blocks_json FROM profile_versions').all() as Row[]; let ok=true;
    for(const row of rows){
      const blocks=JSON.parse(String(row.blocks_json)) as unknown;
      if(!Array.isArray(blocks)) {ok=false;continue;}
      const ids=new Set<string>(); let previous: {ordinal:number; blockId:string}|undefined;
      for(const block of blocks as Array<Record<string,unknown>>){
        const blockId=String(block.blockId);
        const ordinal=Number(block.ordinal);
        if(typeof block.blockId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(blockId)||ids.has(blockId)||
          !Number.isInteger(block.ordinal)||ordinal<0||!['USER','MEMORY'].includes(String(block.kind))||typeof block.body!=='string'||
          (previous!==undefined&&(ordinal<previous.ordinal||(ordinal===previous.ordinal&&blockId.localeCompare(previous.blockId)<0)))) ok=false;
        ids.add(blockId); previous={ordinal,blockId};
      }
    }
    checks.profileBlocks=ok;
  } catch { checks.profileBlocks = false; }
  try { checks.profilePreviews = Number((db.prepare("SELECT COUNT(*) AS bad FROM profile_import_previews p LEFT JOIN profile_versions v ON v.id=p.profile_id AND v.owner_user_id=p.owner_user_id AND v.scope_agent_id=p.scope_agent_id AND v.version=p.expected_version WHERE v.id IS NULL OR p.digest GLOB '*[^0-9a-f]*' OR length(p.digest)!=64 OR p.target_digest GLOB '*[^0-9a-f]*' OR length(p.target_digest)!=64 OR p.expires_at<0 OR p.used NOT IN (0,1)").get() as Row).bad) === 0; } catch { checks.profilePreviews = false; }
  try {
    const rows=db.prepare("SELECT m.digest,m.bytes,v.id AS version_id FROM profile_materializations m LEFT JOIN profile_versions v ON v.id=m.profile_id AND v.owner_user_id=m.owner_user_id AND v.scope_agent_id=m.scope_agent_id AND v.version=m.version").all() as Row[];
    checks.profileMaterializations=rows.every((row)=>row.version_id!==null&&typeof row.digest==='string'&&/^[0-9a-f]{64}$/u.test(row.digest)&&createHash('sha256').update(Buffer.from(row.bytes as Uint8Array)).digest('hex')===row.digest);
  } catch { checks.profileMaterializations = false; }

  try { checks.memorySources = Number((db.prepare("SELECT COUNT(*) AS bad FROM memory_sources s LEFT JOIN events e ON e.id=s.event_id WHERE e.id IS NULL OR e.owner_user_id!=(SELECT owner_user_id FROM memories WHERE id=s.memory_id) OR e.scope_agent_id!=(SELECT scope_agent_id FROM memories WHERE id=s.memory_id)").get() as Row).bad) === 0; } catch { checks.memorySources = false; }
  try { checks.ftsHeadOnly = Number((db.prepare("SELECT COUNT(*) AS bad FROM memory_fts f JOIN memories m ON m.id=f.memory_id WHERE f.version!=m.current_version OR m.lifecycle NOT IN ('candidate','active')").get() as Row).bad) === 0; } catch { checks.ftsHeadOnly = false; }
  try { checks.memoryOrphans = Number((db.prepare("SELECT COUNT(*) AS bad FROM memory_versions v LEFT JOIN memories m ON m.id=v.memory_id WHERE m.id IS NULL").get() as Row).bad) === 0; } catch { checks.memoryOrphans = false; }
  try { checks.catalogHeads=Number((db.prepare("SELECT COUNT(*) AS bad FROM catalog_entries e LEFT JOIN catalog_entry_versions v ON v.entry_id=e.id AND v.owner_user_id=e.owner_user_id AND v.scope_agent_id=e.scope_agent_id AND v.version=e.current_version WHERE v.entry_id IS NULL OR e.current_version<1").get() as Row).bad)===0; } catch { checks.catalogHeads=false; }
  try { const rows=db.prepare("SELECT entry_id,owner_user_id,scope_agent_id,version,snapshot_json FROM catalog_entry_versions ORDER BY entry_id,owner_user_id,scope_agent_id,version").all() as Row[]; const groups=new Map<string,number[]>(); let ok=true; for(const r of rows){const k=`${r.entry_id}|${r.owner_user_id}|${r.scope_agent_id}`;groups.set(k,[...(groups.get(k)??[]),Number(r.version)]);try{const s=JSON.parse(String(r.snapshot_json));if(!s||typeof s!=='object')ok=false;}catch{ok=false;}} for(const vs of groups.values())vs.forEach((v,i)=>{if(v!==i+1)ok=false;});checks.catalogVersions=ok;} catch { checks.catalogVersions=false; }
  try { checks.catalogOrphans=Number((db.prepare("SELECT COUNT(*) AS bad FROM catalog_entry_sources l LEFT JOIN catalog_entries e ON e.id=l.entry_id AND e.owner_user_id=l.owner_user_id AND e.scope_agent_id=l.scope_agent_id LEFT JOIN catalog_sources s ON s.id=l.source_id AND s.owner_user_id=l.owner_user_id AND s.scope_agent_id=l.scope_agent_id WHERE e.id IS NULL OR s.id IS NULL").get() as Row).bad)===0; } catch { checks.catalogOrphans=false; }
  try { checks.catalogDigests=Number((db.prepare("SELECT COUNT(*) AS bad FROM catalog_sync_previews WHERE length(digest)!=64 OR digest GLOB '*[^0-9a-f]*' OR length(input_fingerprint)!=64 OR length(roots_fingerprint)!=64 OR length(catalog_fingerprint)!=64 OR length(profile_fingerprint)!=64 OR length(target_fingerprint)!=64 OR expires_at<0 OR complete NOT IN (0,1) OR (applied_at IS NOT NULL AND reviewed_digest IS NULL)").get() as Row).bad)===0; } catch { checks.catalogDigests=false; }
  try {
    const sources=db.prepare("SELECT fingerprint,locator,kind FROM catalog_sources").all() as Row[];
    const previews=db.prepare("SELECT operations_json FROM catalog_sync_previews").all() as Row[];
    let ok=sources.every((r)=>typeof r.fingerprint==='string'&&/^[0-9a-f]{64}$/u.test(r.fingerprint));
    for(const row of previews){const ops=JSON.parse(String(row.operations_json)) as Array<Record<string,unknown>>;for(const op of ops){const c=op.candidate as Record<string,unknown>|undefined;if(c&&(Buffer.from(c.bytes as Uint8Array??Buffer.alloc(0)).length!==0||typeof c.contentDigest!=='string'||!/^[0-9a-f]{64}$/u.test(c.contentDigest)||!(()=>{try{safeRelativeLocator(String(c.locator));return true;}catch{return false;}})()))ok=false;}}
    checks.catalogPlanDigests=ok;
  } catch { checks.catalogPlanDigests=false; }
  try {
    const rows=db.prepare('SELECT profile,owner_user_id,scope_agent_id,roots_json,selectors_json,input_fingerprint,roots_fingerprint,catalog_fingerprint,profile_fingerprint,target_fingerprint,digest,operations_json,diagnostics_json FROM catalog_sync_previews').all() as Row[];
    let ok=true;
    for(const row of rows){
      const ops=JSON.parse(String(row.operations_json)) as Array<Record<string,unknown>>;
      const normalized=ops.map((op)=>{const c=op.candidate as Record<string,unknown>|undefined;const out:Record<string,unknown>={action:op.action,logicalKey:op.logicalKey};if(op.expectedVersion!==undefined)out.expectedVersion=op.expectedVersion;if(op.reason!==undefined)out.reason=op.reason;if(op.sourceId!==undefined)out.sourceId=op.sourceId;if(c)out.candidate={kind:c.kind,rootId:c.rootId??'default',relativePath:c.relativePath,locator:safeRelativeLocator(String(c.locator)),sourceKind:c.sourceKind??c.kind,metadata:sanitizeMetadata((c.metadata??{}) as Record<string,unknown>),summary:boundedSummary(typeof c.summary==='string'?c.summary:undefined),contentDigest:c.contentDigest};return out;});
      const roots=JSON.parse(String(row.roots_json)) as Array<{id:string}>;
      if(rootBindingsFingerprint(roots as Array<{id:string;path:string}>)!==row.roots_fingerprint)ok=false;
      const expected=catalogSyncDigest({profile:String(row.profile),scope:{ownerUserId:String(row.owner_user_id),agentId:String(row.scope_agent_id)},roots:roots.map((root)=>root.id),selectors:JSON.parse(String(row.selectors_json)),inputFingerprint:String(row.input_fingerprint),rootsFingerprint:String(row.roots_fingerprint),catalogFingerprint:String(row.catalog_fingerprint),profileFingerprint:String(row.profile_fingerprint),targetFingerprint:String(row.target_fingerprint),operations:normalized,diagnostics:JSON.parse(String(row.diagnostics_json))});
      if(expected!==row.digest)ok=false;
    }
    checks.catalogPreviewDigests=ok;
  } catch { checks.catalogPreviewDigests=false; }

  for (const [name, passed] of Object.entries(checks)) if (!passed) errors.push(name);
  return { ok: errors.length === 0, checks, errors };
}
