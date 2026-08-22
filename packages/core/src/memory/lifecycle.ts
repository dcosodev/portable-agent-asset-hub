import { HubError } from '../errors.js';
import type { Lifecycle } from './types.js';
export function validateMemory(confidence:number, importance:number, lifecycle:Lifecycle):void { if(!Number.isFinite(confidence)||confidence<0||confidence>1||!Number.isFinite(importance)||importance<0||importance>1) throw new HubError('VALIDATION','confidence and importance must be within 0..1',400); if(!['candidate','active','superseded','forgotten'].includes(lifecycle)) throw new HubError('VALIDATION','invalid lifecycle',400); }
