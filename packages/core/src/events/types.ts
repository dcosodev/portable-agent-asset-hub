import type { Scope } from '../identity/types.js';
export type EventKind = 'observation' | 'decision' | 'tool' | 'system';
export type Event = { id: string; kind: EventKind; scope: Scope; scopeKey: string; payload: Record<string, unknown>; requestId: string; provenance: Record<string, unknown>; createdAt: string };
export type EventCreate = Omit<Event, 'id'|'createdAt'>;
