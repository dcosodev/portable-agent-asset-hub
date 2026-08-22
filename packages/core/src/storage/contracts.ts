import type { ActorContext } from '../runtime/actor-context.js';
import type { AuditEvent } from '../audit/types.js';
import type { Agent, Binding, Harness, Scope, User } from '../identity/types.js';
import type { IdempotencyInput, IdempotencyRecord, IdempotencyResult } from '../idempotency/types.js';
import type { EventRepository } from '../events/service.js';
import type { MemoryRepository } from '../memory/service.js';
import type { ImportPreview, Profile, ProfileBlock, ProfileScope } from '../profiles/types.js';
import type { CatalogRepository, CatalogSyncRepository } from '../catalog/contracts.js';

export type MutationMeta = { reason: string; requestId: string };
export interface ProfileRepository {
  create(profile: Profile, meta: MutationMeta): Profile;
  get(id: string, scope: ProfileScope): Profile;
  update(id: string, scope: ProfileScope, expectedVersion: number, blocks: ProfileBlock[], meta: MutationMeta): Profile;
  history(id: string, scope: ProfileScope): Profile[];
  createPreview(preview: ImportPreview, meta: MutationMeta): ImportPreview;
  getPreview(id: string, scope: ProfileScope): ImportPreview;
  applyPreview(id: string, scope: ProfileScope, exactDigest: string, observedTargetDigest: string, meta: MutationMeta): Profile;
  restore(id: string, scope: ProfileScope, snapshotVersion: number, expectedVersion: number, meta: MutationMeta): Profile;
}
export type MaterializationRecord = { id: string; profileId: string; scope: ProfileScope; version: number; target: string; digest: string; bytes: Buffer; createdAt: string };
export interface MaterializationRepository {
  record(input: Omit<MaterializationRecord, 'id' | 'createdAt'>, meta: MutationMeta): MaterializationRecord;
  list(profileId: string, scope: ProfileScope): MaterializationRecord[];
}

export interface StorageTransaction {
  identities: IdentityRepository;
  bindings: BindingRepository;
  idempotency: IdempotencyRepository;
  audit: AuditRepository;
  events: EventRepository;
  memories: MemoryRepository;
  profiles: ProfileRepository;
  materializations: MaterializationRepository;
  catalog: CatalogRepository;
  catalogSync: CatalogSyncRepository;
}

export interface IdentityRepository {
  createUser(input: Omit<User, 'id' | 'createdAt' | 'kind'>): User;
  createAgent(input: Omit<Agent, 'id' | 'createdAt' | 'kind'>): Agent;
  createHarness(input: Omit<Harness, 'id' | 'createdAt' | 'kind'>): Harness;
  getUser(id: string): User | undefined;
  getAgent(id: string): Agent | undefined;
  getHarness(id: string): Harness | undefined;
}

export interface BindingRepository {
  create(input: { assetId: string; scope: Scope; harnessId: string; expectedVersion?: number }): Binding;
  get(id: string, scope?: Scope): Binding | undefined;
  getOrThrow(id: string, scope: Scope): Binding;
}

export interface IdempotencyRepository {
  get(actorId: string, operation: string, key: string): IdempotencyRecord | undefined;
  put(record: IdempotencyRecord): void;
  assertDigest(record: IdempotencyRecord, digest: string): void;
}

export interface AuditRepository {
  append(event: Omit<AuditEvent, 'id' | 'createdAt'>): AuditEvent;
  list(scope?: Scope): AuditEvent[];
}

export interface Storage {
  transaction<T>(actor: ActorContext, fn: (tx: StorageTransaction) => T): T;
  idempotent<T>(actor: ActorContext, input: IdempotencyInput, fn: (tx: StorageTransaction) => T): IdempotencyResult<T>;
  close(): void;
}

export type { Agent, Binding, Harness, Scope, User };
