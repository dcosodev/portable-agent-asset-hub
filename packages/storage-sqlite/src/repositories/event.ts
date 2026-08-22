import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ActorContext, Event, EventCreate, Scope } from '@portable-agent-asset-hub/core';
import { HubError, redact } from '@portable-agent-asset-hub/core';
import { AuditRepository } from './audit.js';
export class EventRepository {
  constructor(private readonly db: DatabaseSync, private readonly audit: AuditRepository, private readonly actor: ActorContext) {}
  create(input: EventCreate): Event {
    if (!['observation','decision','tool','system'].includes(input.kind)) throw new HubError('VALIDATION','invalid event kind',400);
    if (input.scope.ownerUserId!==this.actor.scope.ownerUserId||input.scope.agentId!==this.actor.scope.agentId) throw new HubError('NOT_FOUND','resource not found',404);
    const r=redact({payload:input.payload,provenance:input.provenance}); const cleaned=r.value as {payload:Record<string,unknown>;provenance:Record<string,unknown>};
    const event:Event={...input,id:`evt_${randomUUID()}`,payload:cleaned.payload,provenance:cleaned.provenance,createdAt:new Date().toISOString()};
    this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?)').run(event.id,event.kind,event.scope.ownerUserId,event.scope.agentId,event.scopeKey,JSON.stringify(event.payload),event.requestId,JSON.stringify(event.provenance),event.createdAt);
    this.audit.append({action:'event.create',actor:this.actor,scope:event.scope,target:event.id,metadata:{reason:'capture',requestId:event.requestId,scopeKey:event.scopeKey,redactionSummary:r.summary}}); return event;
  }
  get(id:string,scope:Scope):Event|undefined { const row=this.db.prepare('SELECT * FROM events WHERE id=? AND owner_user_id=? AND scope_agent_id=?').get(id,scope.ownerUserId,scope.agentId) as Record<string,unknown>|undefined; if(!row)return undefined; return {id:String(row.id),kind:row.kind as Event['kind'],scope:{ownerUserId:String(row.owner_user_id) as Event['scope']['ownerUserId'],agentId:String(row.scope_agent_id) as Event['scope']['agentId']},scopeKey:String(row.scope_key),payload:JSON.parse(String(row.payload_json)) as Record<string,unknown>,requestId:String(row.request_id),provenance:JSON.parse(String(row.provenance_json)) as Record<string,unknown>,createdAt:String(row.created_at)}; }
}
