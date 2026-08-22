import type { Scope } from '../identity/types.js';
export type MemoryKind = 'fact' | 'preference' | 'decision' | 'episode' | 'task' | 'summary';
export type Lifecycle = 'candidate' | 'active' | 'superseded' | 'forgotten';
export type Memory = { id: string; kind: MemoryKind; scope: Scope; scopeKey: string; lifecycle: Lifecycle; confidence: number; importance: number; sourceEventIds: string[]; supersedesId?: string; version: number; content: Record<string, unknown>; redactionSummary: string[]; createdAt: string; updatedAt: string };
export type MemoryCreate = { kind: MemoryKind; scope: Scope; scopeKey: string; content: Record<string, unknown>; sourceEventIds?: string[]; confidence?: number; importance?: number; lifecycle?: 'candidate'|'active'; reason: string; requestId: string; supersedesId?: never };
export type MemoryUpdate = Partial<Pick<MemoryCreate,'content'|'confidence'|'importance'|'lifecycle'|'sourceEventIds'>> & { expectedVersion: number; reason: string; requestId: string };
export type MemorySupersede = Omit<MemoryCreate, 'supersedesId'> & { expectedVersion: number };
