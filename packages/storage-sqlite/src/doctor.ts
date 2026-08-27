import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { loadMigrations } from './migrations/runner.js';
import { catalogSyncDigest, boundedSummary, classifyRetrievalRequest, normalizeSkillVersionConstraint, retrievalPolicy, rootBindingsFingerprint, safeRelativeLocator, sanitizeMetadata, SKILL_RELATION_TYPES, versionSatisfies } from '@portable-agent-asset-hub/core';

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

  try {
    checks.skillHeads = Number((db.prepare("SELECT COUNT(*) AS bad FROM skill_entries e LEFT JOIN skill_versions v ON v.id=e.id AND v.owner_user_id=e.owner_user_id AND v.scope_agent_id=e.scope_agent_id AND v.version=e.current_version LEFT JOIN skill_active_head h ON h.id=e.id AND h.owner_user_id=e.owner_user_id AND h.scope_agent_id=e.scope_agent_id WHERE v.id IS NULL OR h.id IS NULL OR h.current_version!=e.current_version OR e.current_version<1").get() as Row).bad) === 0;
  } catch { checks.skillHeads = false; }
  try {
    const rows = db.prepare('SELECT id,owner_user_id,scope_agent_id,version,body,body_sha256,total_size FROM skill_versions ORDER BY id,owner_user_id,scope_agent_id,version').all() as Row[];
    const grouped = new Map<string, number[]>();
    let ok = true;
    for (const row of rows) {
      const body = Buffer.from(row.body as Uint8Array);
      const key = `${row.id}|${row.owner_user_id}|${row.scope_agent_id}`;
      grouped.set(key, [...(grouped.get(key) ?? []), Number(row.version)]);
      const resources = db.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM skill_resources WHERE id=? AND owner_user_id=? AND scope_agent_id=? AND version=?').get(String(row.id), String(row.owner_user_id), String(row.scope_agent_id), Number(row.version)) as Row;
      if (createHash('sha256').update(body).digest('hex') !== row.body_sha256 || body.byteLength + Number(resources.bytes) !== Number(row.total_size)) ok = false;
    }
    for (const versions of grouped.values()) versions.forEach((version, index) => { if (version !== index + 1) ok = false; });
    checks.skillVersions = ok;
  } catch { checks.skillVersions = false; }
  try {
    const rows = db.prepare('SELECT mode,size,sha256,bytes FROM skill_resources').all() as Row[];
    checks.skillResources = rows.every((row) => {
      const bytes = Buffer.from(row.bytes as Uint8Array);
      return [0o644, 0o755].includes(Number(row.mode)) && bytes.byteLength === Number(row.size) && createHash('sha256').update(bytes).digest('hex') === row.sha256;
    });
  } catch { checks.skillResources = false; }
  try {
    const versions = Number((db.prepare('SELECT COUNT(*) AS bad FROM skill_versions v LEFT JOIN skill_entries e ON e.id=v.id AND e.owner_user_id=v.owner_user_id AND e.scope_agent_id=v.scope_agent_id WHERE e.id IS NULL').get() as Row).bad);
    const resources = Number((db.prepare('SELECT COUNT(*) AS bad FROM skill_resources r LEFT JOIN skill_versions v ON v.id=r.id AND v.owner_user_id=r.owner_user_id AND v.scope_agent_id=r.scope_agent_id AND v.version=r.version WHERE v.id IS NULL').get() as Row).bad);
    checks.skillOrphans = versions === 0 && resources === 0;
  } catch { checks.skillOrphans = false; }
  try {
    const bad = Number((db.prepare("SELECT COUNT(*) AS bad FROM skill_fts f LEFT JOIN skill_entries e ON e.id=f.id AND e.owner_user_id=f.owner_user_id AND e.scope_agent_id=f.scope_agent_id WHERE e.id IS NULL OR e.lifecycle!='active' OR f.lifecycle!='active'").get() as Row).bad);
    const counts = db.prepare("SELECT (SELECT COUNT(*) FROM skill_entries WHERE lifecycle='active') AS active,(SELECT COUNT(*) FROM skill_fts) AS indexed,(SELECT COUNT(*) FROM (SELECT id,owner_user_id,scope_agent_id,COUNT(*) AS n FROM skill_fts GROUP BY id,owner_user_id,scope_agent_id HAVING n!=1)) AS duplicates").get() as Row;
    checks.skillFtsHeadOnly = bad === 0 && Number(counts.active) === Number(counts.indexed) && Number(counts.duplicates) === 0;
  } catch { checks.skillFtsHeadOnly = false; }
  try {
    const rows = db.prepare('SELECT source_skill_id,relation_type,target_skill_id,metadata_json FROM skill_relations').all() as Row[];
    checks.skillRelationsValid = rows.every((row) => {
      try { JSON.parse(String(row.metadata_json)); } catch { return false; }
      return Object.hasOwn(SKILL_RELATION_TYPES, String(row.relation_type)) && row.source_skill_id !== row.target_skill_id;
    });
  } catch { checks.skillRelationsValid = false; }
  try {
    checks.skillRelationTargetsExist = Number((db.prepare(`SELECT COUNT(*) AS bad FROM skill_relations r
      LEFT JOIN skill_versions s ON s.id=r.source_skill_id AND s.owner_user_id=r.owner_user_id AND s.scope_agent_id=r.scope_agent_id AND s.version=r.source_version
      LEFT JOIN skill_versions t ON t.id=r.target_skill_id AND t.owner_user_id=r.owner_user_id AND t.scope_agent_id=r.scope_agent_id AND t.version=r.resolved_target_version
      WHERE s.id IS NULL OR t.id IS NULL`).get() as Row).bad) === 0;
  } catch { checks.skillRelationTargetsExist = false; }
  try {
    const rows = db.prepare('SELECT target_version_constraint,resolved_target_version FROM skill_relations WHERE target_version_constraint IS NOT NULL').all() as Row[];
    checks.skillVersionConstraintsValid = rows.every((row) => {
      try { return versionSatisfies(Number(row.resolved_target_version), normalizeSkillVersionConstraint(String(row.target_version_constraint))); } catch { return false; }
    });
  } catch { checks.skillVersionConstraintsValid = false; }
  try {
    const rows = db.prepare(`SELECT r.owner_user_id,r.scope_agent_id,r.relation_type,r.source_skill_id,r.target_skill_id
      FROM skill_relations r JOIN skill_entries e ON e.id=r.source_skill_id AND e.owner_user_id=r.owner_user_id AND e.scope_agent_id=r.scope_agent_id AND e.current_version=r.source_version`).all() as Row[];
    const acyclicTypes = new Set(Object.entries(SKILL_RELATION_TYPES).filter(([, semantics]) => semantics.acyclic).map(([type]) => type));
    const byScope = new Map<string, Map<string, string[]>>();
    for (const row of rows) { if (!acyclicTypes.has(String(row.relation_type))) continue; const key=`${row.owner_user_id}|${row.scope_agent_id}|${row.relation_type}`; const graph=byScope.get(key)??new Map<string,string[]>(); graph.set(String(row.source_skill_id),[...(graph.get(String(row.source_skill_id))??[]),String(row.target_skill_id)]); byScope.set(key,graph); }
    let acyclic=true;
    for (const graph of byScope.values()) { const visiting=new Set<string>(); const visited=new Set<string>(); const visit=(node:string):boolean=>{if(visiting.has(node))return false;if(visited.has(node))return true;visiting.add(node);for(const next of graph.get(node)??[])if(!visit(next))return false;visiting.delete(node);visited.add(node);return true;};for(const node of graph.keys())if(!visit(node))acyclic=false; }
    checks.skillDependencyGraphAcyclic = acyclic;
    checks.skillGraphResolvable = checks.skillRelationTargetsExist && checks.skillVersionConstraintsValid && graphVersionsResolvable(db);
  } catch { checks.skillDependencyGraphAcyclic = false; checks.skillGraphResolvable = false; }
  try {
    const rows = db.prepare('SELECT source_skill_id,source_version,target_skill_id,target_version_snapshot,relation_type,confidence,detector,detector_version,status,evidence_json,proposal_fingerprint FROM skill_relation_proposals').all() as Row[];
    checks.relationProposalStoreHealthy = rows.every((row) => Number(row.confidence) >= 0 && Number(row.confidence) <= 1 && typeof row.detector === 'string' && typeof row.detector_version === 'string' && ['proposed','approved','rejected','superseded','stale'].includes(String(row.status)) && /^[0-9a-f]{64}$/u.test(String(row.proposal_fingerprint)) && (() => { try { return Array.isArray(JSON.parse(String(row.evidence_json))); } catch { return false; } })());
    checks.relationProposalTargetsValid = Number((db.prepare(`SELECT COUNT(*) AS bad FROM skill_relation_proposals p LEFT JOIN skill_versions s ON s.id=p.source_skill_id AND s.owner_user_id=p.owner_user_id AND s.scope_agent_id=p.scope_agent_id AND s.version=p.source_version LEFT JOIN skill_versions t ON t.id=p.target_skill_id AND t.owner_user_id=p.owner_user_id AND t.scope_agent_id=p.scope_agent_id AND t.version=p.target_version_snapshot WHERE s.id IS NULL OR t.id IS NULL`).get() as Row).bad) === 0;
    checks.relationProposalEvidenceValid = rows.every((row) => { try { const evidence = JSON.parse(String(row.evidence_json)) as unknown[]; return evidence.every((item) => !!item && typeof item === 'object' && typeof (item as Record<string, unknown>).kind === 'string' && (!('excerpt' in (item as Record<string, unknown>)) || String((item as Record<string, unknown>).excerpt).length <= 4096)); } catch { return false; } });
    checks.relationProposalFingerprintsValid = Number((db.prepare('SELECT COUNT(*) AS total,COUNT(DISTINCT owner_user_id||char(0)||scope_agent_id||char(0)||proposal_fingerprint) AS distinct_count FROM skill_relation_proposals').get() as Row).total) === Number((db.prepare('SELECT COUNT(*) AS total,COUNT(DISTINCT owner_user_id||char(0)||scope_agent_id||char(0)||proposal_fingerprint) AS distinct_count FROM skill_relation_proposals').get() as Row).distinct_count);
    checks.relationProposalNoCanonicalDuplicates = Number((db.prepare(`SELECT COUNT(*) AS bad FROM skill_relation_proposals p JOIN skill_relations r ON r.owner_user_id=p.owner_user_id AND r.scope_agent_id=p.scope_agent_id AND r.source_skill_id=p.source_skill_id AND r.source_version=p.source_version AND r.target_skill_id=p.target_skill_id AND r.relation_type=p.relation_type WHERE p.status IN ('proposed','approved')`).get() as Row).bad) === 0;
  } catch { checks.relationProposalStoreHealthy = false; checks.relationProposalTargetsValid = false; checks.relationProposalEvidenceValid = false; checks.relationProposalFingerprintsValid = false; checks.relationProposalNoCanonicalDuplicates = false; }
  try { const c=classifyRetrievalRequest('deploy application'); const p=retrievalPolicy(c); checks.retrievalPolicyLoaded=c.primary==='deployment'&&p.skillRetrievalRequired; } catch { checks.retrievalPolicyLoaded=false; }
  try {
    const rows=db.prepare('SELECT query_sha256,classification_json,policy_json,candidates_json,selected_skills_json,selected_memories_json,graph_expansions_json,no_match FROM retrieval_events').all() as Row[];
    checks.retrievalAuditHealthy=rows.every((row)=>{try{JSON.parse(String(row.classification_json));JSON.parse(String(row.policy_json));JSON.parse(String(row.candidates_json));JSON.parse(String(row.selected_skills_json));JSON.parse(String(row.selected_memories_json));JSON.parse(String(row.graph_expansions_json));return /^[0-9a-f]{64}$/u.test(String(row.query_sha256))&&[0,1].includes(Number(row.no_match));}catch{return false;}});
  } catch { checks.retrievalAuditHealthy=false; }

  try {
    const rows = db.prepare("SELECT id,token_hash,fingerprint,capabilities_json FROM runtime_credentials").all() as Row[];
    checks.credentialStoreHealthy = rows.every((row) => /^[0-9a-f]{64}$/u.test(String(row.token_hash)) && /^[0-9a-f]{16}$/u.test(String(row.fingerprint)) && Array.isArray(JSON.parse(String(row.capabilities_json))));
    checks.credentialBindingsValid = Number((db.prepare("SELECT COUNT(*) AS bad FROM runtime_credentials c LEFT JOIN users u ON u.id=c.user_id LEFT JOIN agents a ON a.id=c.agent_id WHERE u.id IS NULL OR a.id IS NULL").get() as Row).bad) === 0;
    checks.authAuditHealthy = Number((db.prepare("SELECT COUNT(*) AS bad FROM auth_events WHERE result NOT IN ('authenticated','rejected','revoked','capability_denied','scope_denied') OR request_id IS NULL").get() as Row).bad) === 0;
   } catch { checks.credentialStoreHealthy = false; checks.credentialBindingsValid = false; checks.authAuditHealthy = false; }

  // ---- Explicit-relation candidates: warning-only ----
  //
  // The check below is intentionally NOT fatal. Unresolved explicit
  // references in `metadata.hermes.related_skills` (e.g. a metadata
  // field that lists a token for a skill that does not exist in the
  // active corpus) are a normal product state, not a data-integrity
  // issue. We surface the count for observability but exclude the
  // check from `errors` (see the loop above). The same applies to
  // ambiguous references (a token that matches more than one head):
  // those need a human decision, not a DB fix.
  try {
    const unresolvedCount = computeExplicitUnresolvedCount(db);
    checks.explicitRelationMetadataResolvable = unresolvedCount === 0;
  } catch {
    checks.explicitRelationMetadataResolvable = false;
  }

  for (const [name, passed] of Object.entries(checks)) if (!passed && name !== 'explicitRelationMetadataResolvable') errors.push(name);
  return { ok: errors.length === 0, checks, errors };
}

function computeExplicitUnresolvedCount(db: DatabaseSync): number {
  // Walk every active head, parse `metadata.hermes.related_skills`,
  // and count tokens that do not resolve to any active head. We
  // intentionally do NOT use the FTS or classifier here; we only
  // inspect the structured metadata column. The implementation
  // mirrors `listExplicitCandidates` in core; the duplicate exists
  // to keep the doctor in a single file with no cross-module
  // imports (the doctor is also used by `fresh DB` paths that may
  // not have the core storage layer wired up).
  const heads = db
    .prepare(
      "SELECT e.id, e.logical_key, v.body FROM skill_entries e JOIN skill_versions v ON v.id=e.id AND v.owner_user_id=e.owner_user_id AND v.scope_agent_id=e.scope_agent_id AND v.version=e.current_version WHERE e.lifecycle='active'",
    )
    .all() as Array<{ id: string; logical_key: string; body: Buffer }>;
  const byLogical = new Map<string, string[]>();
  const byShort = new Map<string, string[]>();
  for (const head of heads) {
    const lk = String(head.logical_key);
    const arr = byLogical.get(lk) ?? [];
    arr.push(String(head.id));
    byLogical.set(lk, arr);
    const idx = lk.lastIndexOf(':');
    const short = idx >= 0 ? lk.slice(idx + 1) : lk;
    if (short) {
      const arr2 = byShort.get(short) ?? [];
      arr2.push(String(head.id));
      byShort.set(short, arr2);
    }
  }
  let unresolved = 0;
  for (const head of heads) {
    let tokens: string[] = [];
    const text = Buffer.from(head.body).toString('utf8');
    const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fmMatch) {
      const fm = fmMatch[1];
      const inlineMatch = fm.match(/(?:^|\n)\s*related_skills\s*:\s*\[([^\]]*)\]/);
      if (inlineMatch) {
        tokens = inlineMatch[1].split(',').map((v) => v.trim()).filter((v) => v.length > 0);
      } else {
        const blockMatch = fm.match(/(?:^|\n)\s*related_skills\s*:\s*\n((?:\s*-\s*[^\n]+\n)+)/);
        if (blockMatch) {
          tokens = Array.from(blockMatch[1].matchAll(/^\s*-\s*([^\n]+)$/gm))
            .map((m) => m[1].trim())
            .filter((v) => v.length > 0);
        }
      }
    }
    for (const token of tokens) {
      const hasLogical = (byLogical.get(token) ?? []).length > 0;
      const hasShort = (byShort.get(token) ?? []).length > 0;
      if (!hasLogical && !hasShort) unresolved += 1;
    }
  }
  return unresolved;
}

function graphVersionsResolvable(db: DatabaseSync): boolean {
  const roots = db.prepare("SELECT owner_user_id,scope_agent_id,id,current_version AS version FROM skill_entries WHERE lifecycle='active' ORDER BY owner_user_id,scope_agent_id,id").all() as Array<{ owner_user_id: string; scope_agent_id: string; id: string; version: number }>;
  const active = new Set(roots.map((root) => `${root.owner_user_id}\u0000${root.scope_agent_id}\u0000${root.id}`));
  const outgoing = db.prepare(`SELECT owner_user_id,scope_agent_id,source_skill_id,source_version,target_skill_id,resolved_target_version FROM skill_relations WHERE relation_type IN ('requires','extends') ORDER BY owner_user_id,scope_agent_id,source_skill_id,source_version,target_skill_id`).all() as Array<{ owner_user_id: string; scope_agent_id: string; source_skill_id: string; source_version: number; target_skill_id: string; resolved_target_version: number }>;
  const bySource = new Map<string, typeof outgoing>();
  for (const edge of outgoing) {
    const key = `${edge.owner_user_id}|${edge.scope_agent_id}|${edge.source_skill_id}@${edge.source_version}`;
    const bucket = bySource.get(key) ?? [];
    bucket.push(edge);
    bySource.set(key, bucket);
  }
  for (const root of roots) {
    const selected = new Map<string, number>([[root.id, root.version]]);
    const queue = [{ id: root.id, version: root.version }];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift()!;
      const nodeKey = `${root.owner_user_id}|${root.scope_agent_id}|${current.id}@${current.version}`;
      if (seen.has(nodeKey)) continue;
      seen.add(nodeKey);
      for (const edge of bySource.get(nodeKey) ?? []) {
        if (!active.has(`${root.owner_user_id}\u0000${root.scope_agent_id}\u0000${edge.target_skill_id}`)) return false;
        const prior = selected.get(edge.target_skill_id);
        if (prior !== undefined && prior !== edge.resolved_target_version) return false;
        if (prior === undefined) selected.set(edge.target_skill_id, edge.resolved_target_version);
        queue.push({ id: edge.target_skill_id, version: edge.resolved_target_version });
      }
    }
  }
  return true;
}
