import type { Capability } from '../policy/capabilities.js'; import type { ActorContext } from '../runtime/actor-context.js';
export type AuditEvent={id:string; action:string; capability?:Capability; actor:{userId:string;agentId:string;harnessId?:string}; scope:{ownerUserId:string;agentId:string}; target?:string; requestDigest?:string; createdAt:string; metadata?:Record<string,unknown>};
export interface AuditWriter { append(event: Omit<AuditEvent,'id'|'createdAt'>): AuditEvent; }
export function auditActor(context: ActorContext){ return {userId:context.userId,agentId:context.agentId,harnessId:context.harnessId}; }
