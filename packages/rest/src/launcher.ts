// packages/rest/src/launcher.ts
//
// Process-level entrypoint that wires the @portable-agent-asset-hub/rest
// HTTP server to a real @portable-agent-asset-hub/storage-sqlite backend
// and exposes it on the loopback interface (or, with a bearer verifier,
// on a configurable host). The launcher is the single source of truth for
// the env-var contract that the `agent-memory-rest` bin shim consumes:
//
//   * `AGENT_MEMORY_DB_PATH` — REQUIRED. Filesystem path to the SQLite
//     database file. The parent directory is created on demand.
//   * `HOST` — loopback bind address. Defaults to `127.0.0.1`. Setting
//     this to a non-loopback host without configuring a bearer verifier
//     is rejected by `listen()` so the server never opens an
//     unauthenticated port on a routable interface.
//   * `PORT` — TCP port to listen on. Defaults to `39421`.
//   * `AGENT_MEMORY_BEARER_TOKEN` — OPTIONAL. Static bearer token. When
//     set, the server runs in authenticated mode; when unset, it runs
//     in `localMode` (loopback trust, no Authorization header required).
//
// Four operations are dispatched to the storage layer:
//
//   * `createMemory` — fully wired through `tx.memories.create()` with
//     the normalized body produced by `normalizeMemoryCreate()`.
//   * `supersedeMemory` — fully wired through `tx.memories.supersede()`
//     with the normalized body produced by `normalizeMemorySupersede()`
//     and the `id` pulled from the route param. CAS is enforced by the
//     `If-Match` header via the route's `cas: true` flag; the body
//     carries `expectedVersion` for the storage layer's version check.
//   * `forgetMemory` — fully wired through `tx.memories.forget()` with
//     the route `id`, `body.expectedVersion`, and `body.reason`.
//   * `listMemoryBlocks` — fully wired through `tx.profiles.get()`.
//     The `profileId` query param is required and validated as a
//     non-empty string; missing/invalid values yield HTTP 400. The
//     profile lookup honors the actor's scope (cross-scope reads
//     surface as `NOT_FOUND` / HTTP 404 via the storage layer's
//     scoped repository, never as fabricated rows). The returned
//     `Profile.blocks` array is already in canonical
//     `(ordinal, blockId)` order from
//     `SqliteProfileRepository.canonicalBlocks()`; the launcher
//     filters to `kind === 'MEMORY'` and returns
//     `{ items: filteredBlocks }`. Empty profiles return
//     `{ items: [] }`; missing profiles surface as 404.
//   * `searchMemories` — fully wired through `tx.memories.search()`
//     with `input.actor.scope` and a validated `q` query string.
//     `q` is REQUIRED and must be a non-empty string after trimming;
//     missing/empty/whitespace-only values yield HTTP 400. The
//     optional `limit` query parameter must be a positive integer
//     bounded by `SEARCH_LIMIT_MAX` (`100`); missing/malformed values
//     fall back to `SEARCH_LIMIT_DEFAULT` (`20`). The launcher's
//     result is `{ items }` where each item is the durable
//     `Memory` shape. The storage layer's FTS5 query already
//     excludes `forgotten` and `superseded` rows (the FTS repository
//     filters on `lifecycle IN ('candidate', 'active')`), so the
//     launcher does NOT post-filter; lifecycle visibility is
//     enforced exactly once, in the repository, where it belongs.
//     Cross-scope reads surface as `NOT_FOUND` / HTTP 404 via the
//     scoped repository, never as fabricated rows.
//   * `getMemory` — fully wired through `tx.memories.getOrThrow()`
//     with `params.id` and `input.actor.scope`. The path parameter
//     is validated as a non-empty string; empty/whitespace-only
//     values yield HTTP 400 before touching storage. The operation
//     reads any visible lifecycle state from the actor's scope
//     (forgotten and superseded rows are NOT filtered here — the
//     `tx.memories.search` lifecycle filter applies only to FTS
//     results; direct `getOrThrow` lets the launcher return the
//     audit-visible version of a forgotten row). Cross-scope reads
//     surface as `NOT_FOUND` / HTTP 404.
//
// All other `dispatch()` operations that might be added to the routes
// in the future throw `NOT_IMPLEMENTED` by default. The launcher is the
// only piece that knows the real backend, so it gets to decide what is
// wired and what isn't.
//
// The doctor endpoint delegates to `SqliteStore.doctor()`. Health and
// status are answered directly by the REST app.
//
// Lifecycle:
//
//   * On startup: build the `SqliteStore`, build the `ActorContext`
//     used in `localMode`, open the listener via `listen()`, and emit
//     exactly one line to stderr:
//
//         AGENT_MEMORY_READY {"url":"http://127.0.0.1:39421","dbPath":"/abs/path.db"}
//
//     The line is JSON after the literal `AGENT_MEMORY_READY` prefix so
//     supervisors (the smoke test, `scripts/`, etc.) can parse it
//     deterministically. stdout is reserved for HTTP responses and is
//     never written to by the launcher.
//   * On `SIGTERM` / `SIGINT`: close the HTTP server first (so in-flight
//     requests can drain), then close the store. The process exits with
//     code 0 on a clean shutdown and a non-zero code if the store fails
//     to close.
//
// The launcher never throws across the module boundary — it logs a
// diagnostic to stderr and exits with a non-zero code so a host
// supervisor (systemd, `pnpm dev`, the smoke test, ...) sees a
// deterministic failure instead of a hung process.

import { accessSync, constants } from 'node:fs';
import type {
  ActorContext,
  Memory,
  MemoryCreate,
  MemorySupersede,
  ProfileBlock,
  Scope,
  SkillSearchHit,
  SkillRelationInput,
  SkillVersion,
  SyncInput,
  StorageTransaction,
  CenteredGraphOptions,
  GlobalGraphOptions,
} from '@portable-agent-asset-hub/core';
import { HubError, SyncService, normalizeGraphMode, normalizeGraphVersionMode, validateResourcePath, requireCanonicalStorage, resolveHubDatabasePath } from '@portable-agent-asset-hub/core';
import { RootScanner } from '@portable-agent-asset-hub/storage-files';
import { SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';
import { listen, type AuthVerifier, type RestHub } from './app.js';

/** Name of the env var carrying the SQLite database path (required). */
export const DB_PATH_ENV = 'AGENT_MEMORY_DB_PATH';
/** Name of the env var carrying the bind host (default 127.0.0.1). */
export const HOST_ENV = 'HOST';
/** Name of the env var carrying the bind port (default 39421). */
export const PORT_ENV = 'PORT';
/** Name of the env var carrying the optional static bearer token. */
export const BEARER_TOKEN_ENV = 'AGENT_MEMORY_BEARER_TOKEN';
export const AUTH_MODE_ENV = 'AGENT_MEMORY_AUTH_MODE';
/** Default port used when `PORT` is unset. */
export const DEFAULT_PORT = 39421;
/** Default bind host used when `HOST` is unset. */
export const DEFAULT_HOST = '127.0.0.1';

/**
 * Default `limit` for `GET /api/v1/memories/search` when the caller
 * does not supply one. The launcher refuses to forward unlimited
 * queries to the FTS5 repository — every call MUST carry an explicit
 * bound — so this constant is the fallback the dispatcher reaches
 * for in place of an absent query parameter.
 */
export const SEARCH_LIMIT_DEFAULT = 20;
/**
 * Hard upper bound on the `limit` for `GET /api/v1/memories/search`.
 * Any caller-supplied value greater than this is rejected with HTTP
 * 400 before it reaches storage. The bound matches the OpenAPI
 * schema's `maximum: 100` and is the single source of truth — both
 * the dispatcher and the route's REST tests consult it.
 */
export const SEARCH_LIMIT_MAX = 100;

/** Local actor used in `localMode` (loopback trust, no Authorization). */
export const LOCAL_USER_ID = 'usr_local';
export const LOCAL_AGENT_ID = 'agt_local';
export const LOCAL_ROLE: ActorContext['role'] = 'admin';
export const LOCAL_CAPABILITIES: readonly string[] = Object.freeze([
  'read',
  'write.memory',
  'write.profile',
  'admin',
  'skill.relation.proposal.read',
  'skill.relation.proposal.create',
  'skill.relation.proposal.review',
  'skill.relation.proposal.apply',
]);

/** Shape of a `dispatch()` input — mirrors `RestHub['dispatch']`. */
type DispatchInput = {
  body: unknown;
  params: Record<string, string>;
  query: Record<string, string>;
  actor: ActorContext;
  requestId: string;
  operationMode?: string;
  storage?: unknown;
};

export type LauncherOptions = {
  /** Override `process.env` for tests. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Override stderr writes for tests. */
  stderr?: NodeJS.WritableStream;
  /** Exit hook used in tests instead of `process.exit`. */
  exit?: (code: number) => void;
  /** Signal hooks used in tests instead of `process.on`. */
  signals?: {
    onSigterm?: (handler: () => void) => void;
    onSigint?: (handler: () => void) => void;
  };
};

/**
 * Run the launcher: read env, open the store, start the HTTP server,
 * install signal handlers. Returns the chosen exit code (0 on a clean
 * shutdown driven by a signal; non-zero on a pre-flight error or a
 * store failure). The function never throws across the boundary.
 */
export async function runLauncher(options: LauncherOptions = {}): Promise<number> {
  const env = options.env ?? (process.env as Readonly<Record<string, string | undefined>>);
  const stderr = options.stderr ?? process.stderr;
  const exit = options.exit ?? ((code: number) => process.exit(code));

  let storage;
  try {
    const cliPath = env.AGENT_MEMORY_DB_CLI_PATH;
    storage = resolveHubDatabasePath({ cliPath, env });
  } catch (error) {
    writeDiagnostic(stderr, 'error', error instanceof Error ? error.message : 'unable to resolve hub database path');
    return 2;
  }
  const dbPath = storage.path;

  const host = (env[HOST_ENV] ?? '').trim() || DEFAULT_HOST;
  const portRaw = (env[PORT_ENV] ?? '').trim();
  const port = portRaw.length > 0 ? Number.parseInt(portRaw, 10) : DEFAULT_PORT;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    writeDiagnostic(stderr, 'error', `${PORT_ENV} must be an integer in 1..65535 (got ${portRaw || '<unset>'}).`);
    return 2;
  }

  const bearerTokenRaw = env[BEARER_TOKEN_ENV];
  const bearerToken = typeof bearerTokenRaw === 'string' && bearerTokenRaw.length > 0 ? bearerTokenRaw : undefined;
  const authMode = (env[AUTH_MODE_ENV] ?? '').trim() || (bearerToken ? 'bearer-legacy' : 'local-dev');
  if (!['local-dev', 'bearer', 'bearer-legacy'].includes(authMode)) {
    writeDiagnostic(stderr, 'error', `${AUTH_MODE_ENV} must be local-dev or bearer.`);
    return 2;
  }

  const store = new SqliteStore(dbPath);
  const scope: Scope = { ownerUserId: LOCAL_USER_ID, agentId: LOCAL_AGENT_ID };
  const localActor: ActorContext = Object.freeze({
    userId: LOCAL_USER_ID,
    agentId: LOCAL_AGENT_ID,
    role: LOCAL_ROLE,
    capabilities: LOCAL_CAPABILITIES,
    scope: Object.freeze(scope),
  });

  const hub: RestHub = {
    storage,
    doctor: () => {
      const databasePathResolved = storage.path.length > 0;
      const canonicalDatabasePersistent = storage.mode === 'canonical' && !storage.isTemporary;
      const canonicalDatabaseWritable = (() => { try { accessSync(storage.path, constants.W_OK); return true; } catch { return false; } })();
      return { ...store.doctor(), checks: { ...store.doctor().checks, databasePathResolved, databaseStorageModeKnown: storage.mode !== undefined, canonicalDatabaseWritable, canonicalDatabasePersistent }, storage: { mode: storage.mode, source: storage.source, databasePath: storage.path } };
    },
    dispatch: ((operationId: string, input: DispatchInput) => {
      if (operationId === 'createMemory') {
        return store.transaction(input.actor, (tx: StorageTransaction) => tx.memories.create(normalizeMemoryCreate(input.body, input.actor, input.requestId)));
      }
      if (operationId === 'supersedeMemory') {
        return store.transaction(input.actor, (tx: StorageTransaction) =>
          tx.memories.supersede(
            requireIdParam(input.params),
            normalizeMemorySupersede(input.body, input.actor, input.requestId),
            input.actor.scope,
          ),
        );
      }
      if (operationId === 'forgetMemory') {
        const id = requireIdParam(input.params);
        const reason = requireStringField(input.body, 'reason');
        const expectedVersion = requireIntegerField(input.body, 'expectedVersion');
        return store.transaction(input.actor, (tx: StorageTransaction) =>
          tx.memories.forget(id, expectedVersion, input.actor.scope, reason, input.requestId),
        );
      }
      if (operationId === 'listMemoryBlocks') {
        const profileId = requireQueryProfileId(input.query);
        const profile = store.transaction(input.actor, (tx: StorageTransaction) =>
          tx.profiles.get(profileId, input.actor.scope),
        );
        const items = profile.blocks.filter((block: ProfileBlock): boolean => block.kind === 'MEMORY');
        return { items };
      }
      if (operationId === 'searchMemories') {
        const q = requireQueryQ(input.query);
        const limit = parseSearchLimit(input.query.limit);
        const items = store.transaction(input.actor, (tx: StorageTransaction) =>
          tx.memories.search(input.actor.scope, q, limit),
        );
        return { items: items as Memory[] };
      }
      if (operationId === 'getMemory') {
        const id = requireIdParam(input.params);
        return store.transaction(input.actor, (tx: StorageTransaction) =>
          tx.memories.getOrThrow(id, input.actor.scope),
        );
      }
      if (operationId === 'getCatalog') {
        const items = store.transaction(input.actor, (tx: StorageTransaction) =>
          tx.catalog.list(input.actor.scope),
        );
        return { items };
      }
      if (operationId === 'createManualSkillRelationProposal') {
        const body = requireObjectBody(input.body);
        const sourceSkillId = requireNonEmptyString(body, 'sourceSkillId');
        const targetSkillId = requireNonEmptyString(body, 'targetSkillId');
        const relationType = requireNonEmptyString(body, 'relationType');
        const allowed = new Set(['requires','uses','extends','supersedes','conflicts_with','related_to','produces','consumes']);
        if (!allowed.has(relationType)) throw new HubError('VALIDATION', 'unsupported relationType', 400);
        const constraint = body.constraint === null || body.constraint === undefined ? null : requireNonEmptyString(body, 'constraint');
        return store.transaction(input.actor, (tx: StorageTransaction) => tx.relationProposals.createManual({ sourceSkillId, targetSkillId, relationType: relationType as never, constraint, scope: input.actor.scope }, input.actor.userId));
      }
      if (operationId === 'listSkillRelationProposals') {
        const minConfidence = input.query.minConfidence === undefined ? undefined : optionalNumberValue(input.query.minConfidence, 'query.minConfidence');
        return { items: store.transaction(input.actor, (tx: StorageTransaction) => tx.relationProposals.list(input.actor.scope, {
          status: input.query.status as never,
          relationType: input.query.relationType as never,
          detector: input.query.detector,
          minConfidence,
        })) };
      }
      if (operationId === 'getSkillRelationProposal') {
        return store.transaction(input.actor, (tx: StorageTransaction) => tx.relationProposals.get(requireIdParam(input.params), input.actor.scope));
      }
      if (operationId === 'discoverSkillRelationProposals') {
        const body = input.body && typeof input.body === 'object' && !Array.isArray(input.body) ? input.body as Record<string, unknown> : {};
        const options = {
          topK: optionalIntegerValue(body.topK, 'body.topK'),
          minRelatedConfidence: optionalNumberValue(body.minRelatedConfidence, 'body.minRelatedConfidence'),
          dryRun: body.dryRun === true,
          skillIds: Array.isArray(body.skillIds) ? body.skillIds.filter((value): value is string => typeof value === 'string') : undefined,
        };
        return store.transaction(input.actor, (tx: StorageTransaction) => tx.relationProposals.discover(input.actor.scope, options));
      }
      if (operationId === 'approveSkillRelationProposal' || operationId === 'rejectSkillRelationProposal') {
        const body = input.body && typeof input.body === 'object' && !Array.isArray(input.body) ? input.body as Record<string, unknown> : {};
        const status = operationId === 'approveSkillRelationProposal' ? 'approved' : 'rejected';
        const changes = { relationType: typeof body.relationType === 'string' ? body.relationType as never : undefined, reverseDirection: body.reverseDirection === true, ...(Object.hasOwn(body, 'constraint') ? { constraint: body.constraint === null ? null : requireNonEmptyString(body, 'constraint') } : {}) };
        return store.transaction(input.actor, (tx: StorageTransaction) => tx.relationProposals.review(requireIdParam(input.params), status, input.actor.scope, input.actor.userId, typeof body.reason === 'string' ? body.reason : undefined, changes));
      }
      if (operationId === 'reconcileSkillRelationProposalDuplicates') {
        try { requireCanonicalStorage(storage); } catch (error) { throw new HubError('CONFLICT', error instanceof Error ? error.message : 'Canonical write refused', 409); }
        const superseded = store.transaction(input.actor, (tx: StorageTransaction) => tx.relationProposals.reconcileCanonicalDuplicates(input.actor.scope, input.actor.userId));
        return { superseded: superseded.map((row) => ({ id: row.id, sourceSkillId: row.sourceSkillId, targetSkillId: row.targetSkillId, relationType: row.relationType, rejectionReason: row.rejectionReason, reviewedAt: row.reviewedAt, reviewedBy: row.reviewedBy })) };
      }
      if (operationId === 'listExplicitSkillRelationCandidates' || operationId === 'previewExplicitSkillRelationCandidatesImpact' || operationId === 'stageExplicitSkillRelationCandidates') {
        return (async (): Promise<unknown> => {
          // The explicit-relation extractor needs a DatabaseSync, which
          // SqliteStore keeps private. We open a parallel connection via
          // the test-only `internal` sub-path.
          const { SqliteExplicitRelationSource, HubDatabase } = await import('@portable-agent-asset-hub/storage-sqlite/internal');
          const dbPath = store.databasePath;
          const internalDb = new HubDatabase(dbPath);
          const conn = internalDb.withConnection((handle) => handle);
          const source = new SqliteExplicitRelationSource(conn);
          const { listExplicitCandidates, previewExplicitImpact, stageExplicitCandidates } = await import('@portable-agent-asset-hub/core');
          const pairKeys = (() => {
            const body = input.body as { pairKeys?: string[] } | undefined;
            return Array.isArray(body?.pairKeys) ? body.pairKeys : [];
          })();
          const status = input.query.status as 'READY_FOR_REVIEW' | 'ALREADY_STAGED' | 'ALREADY_CANONICAL' | 'UNRESOLVED' | 'AMBIGUOUS' | undefined;
          const reciprocal = input.query.reciprocal;
          const skillId = input.query.skillId;
          const limit = input.query.limit ? Number(input.query.limit) : undefined;
          const cursor = input.query.cursor;
          if (operationId === 'listExplicitSkillRelationCandidates') {
            return listExplicitCandidates(source, input.actor.scope, {
              status, reciprocal: reciprocal === undefined ? undefined : reciprocal === 'true', skillId, limit, cursor,
            });
          }
          if (operationId === 'previewExplicitSkillRelationCandidatesImpact') {
            return previewExplicitImpact(source, input.actor.scope, pairKeys);
          }
          // stage creates review proposals only; canonical graph writes remain guarded in apply/reconcile.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const stager = (inputArg: any, actorId: string): unknown => {
            return store.transaction(input.actor, (tx) => tx.relationProposals.createFromExplicitMetadata(inputArg, actorId));
          };
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const staged = stageExplicitCandidates(source, pairKeys, input.actor.scope, input.actor.userId, stager as any);
          return { staged: staged.map((s) => ({ proposalId: (s.proposal as { id: string }).id, pairKey: s.candidate.pairKey, sourceSkillId: s.candidate.sourceSkillId, targetSkillId: s.candidate.targetSkillId, relationType: s.candidate.relationType, reciprocal: s.candidate.reciprocal })) };
        })();
      }
      if (operationId === 'previewSkillRelationProposalApply' || operationId === 'applySkillRelationProposals') {
        const body = requireObjectBody(input.body);
        if (!Array.isArray(body.proposalIds) || !body.proposalIds.every((value) => typeof value === 'string')) throw new HubError('VALIDATION', 'body.proposalIds must be an array of strings', 400);
        const ids = body.proposalIds as string[];
        if (operationId === 'previewSkillRelationProposalApply') return store.transaction(input.actor, (tx: StorageTransaction) => tx.relationProposals.previewApply(ids, input.actor.scope));
        try { requireCanonicalStorage(storage); } catch (error) { throw new HubError('CONFLICT', error instanceof Error ? error.message : 'Canonical write refused', 409); }
        const digest = requireNonEmptyString(body, 'reviewedDigest');
        return store.transaction(input.actor, (tx: StorageTransaction) => tx.relationProposals.apply(ids, digest, input.actor.scope, input.actor.userId, input.requestId));
      }
      if (operationId === 'searchCatalog') {
        const q = requireQueryQ(input.query);
        const limit = parseSearchLimit(input.query.limit);
        const kind = parseCatalogKind(input.query.kind);
        const items = store.transaction(input.actor, (tx: StorageTransaction) =>
          tx.catalog.search(input.actor.scope, q, limit, kind),
        );
        return { items };
      }
      if (operationId === 'previewCatalogSync') {
        const syncInput = normalizeCatalogSyncInput(input.body, input.actor.scope);
        const meta = { reason: 'catalog.sync.preview', requestId: input.requestId };
        return store.transaction(input.actor, (tx: StorageTransaction) => {
          const service = new SyncService(new RootScanner(), {
            catalog: tx.catalog,
            sync: tx.catalogSync,
          });
          return service.previewSync(syncInput, meta);
        });
      }
      if (operationId === 'applyCatalogSync') {
        const body = requireObjectBody(input.body);
        const previewId = requireNonEmptyString(body, 'previewId');
        const reviewedDigest = requireNonEmptyString(body, 'reviewedDigest');
        const meta = { reason: 'catalog.sync.apply', requestId: input.requestId };
        return store.transaction(input.actor, (tx: StorageTransaction) => {
          const service = new SyncService(new RootScanner(), {
            catalog: tx.catalog,
            sync: tx.catalogSync,
          });
          const preview = tx.catalogSync.getPreview(previewId, input.actor.scope);
          if (preview.digest !== reviewedDigest) {
            throw new HubError('CONFLICT', 'reviewed digest mismatch', 409);
          }
          service.review(preview, meta);
          service.apply({ previewId, scope: input.actor.scope, reviewedDigest, meta });
          return { previewId, digest: reviewedDigest, applied: true };
        });
      }
      if (operationId === 'searchSkills') {
        const q = requireQueryQ(input.query);
        const limit = parseSkillSearchLimit(input.query.limit);
        const hits = store.transaction(input.actor, (tx: StorageTransaction) =>
          tx.skills.skillSearch(input.actor.scope, q, limit),
        );
        return { items: hits.map(serializeSkillSearchHit) };
      }
      if (operationId === 'getGlobalSkillGraph') {
        requireSkillRead(input.actor);
        const options = parseGlobalGraphOptions(input.query);
        return store.transaction(input.actor, (tx: StorageTransaction) => tx.skills.buildGlobalGraph(input.actor.scope, options));
      }
      if (operationId === 'getSkillGraph') {
        requireSkillRead(input.actor);
        const id = requireIdParam(input.params);
        const options = parseCenteredGraphOptions(input.query);
        return store.transaction(input.actor, (tx: StorageTransaction) => tx.skills.buildCenteredGraph(id, input.actor.scope, options));
      }
      if (operationId === 'getSkillImpact') {
        requireSkillRead(input.actor);
        const id = requireIdParam(input.params);
        const options = parseGlobalGraphOptions(input.query);
        return store.transaction(input.actor, (tx: StorageTransaction) => tx.skills.buildImpactGraph(id, input.actor.scope, options));
      }
      if (operationId === 'listRetrievalEvents') {
        requireSkillRead(input.actor);
        const limit = input.query.limit === undefined ? undefined : parseOptionalPositiveInteger(input.query.limit, 'query.limit');
        const includeQuery = input.query.includeQuery === 'true';
        return { items: store.transaction(input.actor, (tx: StorageTransaction) => tx.skills.listRetrievalEvents(input.actor.scope, limit, includeQuery)) };
      }
      if (operationId === 'getRetrievalEventGraph') {
        requireSkillRead(input.actor);
        return store.transaction(input.actor, (tx: StorageTransaction) => tx.skills.getRetrievalEventGraph(requireIdParam(input.params), input.actor.scope));
      }
      if (operationId === 'getSkillRelations') {
        const id = requireIdParam(input.params);
        const version = parseOptionalPositiveInteger(input.query.version, 'query.version');
        const items = store.transaction(input.actor, (tx: StorageTransaction) => tx.skills.getRelations(id, version, input.actor.scope));
        return { items };
      }
      if (operationId === 'getSkillDependents') {
        const id = requireIdParam(input.params);
        const items = store.transaction(input.actor, (tx: StorageTransaction) => tx.skills.getDependents(id, input.actor.scope));
        return { items };
      }
      if (operationId === 'replaceSkillRelations') {
        const id = requireIdParam(input.params);
        const body = requireObjectBody(input.body);
        const expectedVersion = requireIntegerField(body, 'expectedVersion');
        if (expectedVersion < 1) throw new HubError('VALIDATION', 'body.expectedVersion must be positive', 400);
        if (!Array.isArray(body.relations)) throw new HubError('VALIDATION', 'body.relations must be an array', 400);
        return serializeSkillVersion(store.transaction(input.actor, (tx: StorageTransaction) => tx.skills.replaceRelations(
          id, expectedVersion, body.relations as SkillRelationInput[], input.actor.scope,
          { reason: typeof body.reason === 'string' && body.reason.length > 0 ? body.reason : 'skill relations replaced', requestId: input.requestId },
        )));
      }
      if (operationId === 'resolveSkillGraph') {
        const body = requireObjectBody(input.body);
        const id = requireNonEmptyString(body, 'skill');
        const version = body.version === undefined ? undefined : requirePositiveIntegerValue(body.version, 'body.version');
        const limits = body.limits && typeof body.limits === 'object' && !Array.isArray(body.limits) ? body.limits as Record<string, unknown> : {};
        return store.transaction(input.actor, (tx: StorageTransaction) => tx.skills.resolveGraph(id, version, input.actor.scope, {
          maxDepth: optionalIntegerValue(limits.maxDepth, 'body.limits.maxDepth'),
          maxResolvedSkills: optionalIntegerValue(limits.maxResolvedSkills, 'body.limits.maxResolvedSkills'),
        }));
      }
      if (operationId === 'resolveRetrieval') {
        const body = requireObjectBody(input.body);
        const query = requireNonEmptyString(body, 'query');
        const profile = body.profile === undefined ? 'default' : requireNonEmptyString(body, 'profile');
        const limits = body.limits && typeof body.limits === 'object' && !Array.isArray(body.limits) ? body.limits as Record<string, unknown> : {};
        return store.transaction(input.actor, (tx: StorageTransaction) => tx.skills.resolveRetrieval(query, profile, input.actor.scope, {
          maxCandidates: optionalIntegerValue(limits.maxCandidates, 'body.limits.maxCandidates'),
          maxGraphDepth: optionalIntegerValue(limits.maxGraphDepth, 'body.limits.maxGraphDepth'),
          maxResolvedSkills: optionalIntegerValue(limits.maxResolvedSkills, 'body.limits.maxResolvedSkills'),
          maxBodyBytes: optionalIntegerValue(limits.maxBodyBytes, 'body.limits.maxBodyBytes'),
          canonicalThreshold: optionalNumberValue(limits.canonicalThreshold, 'body.limits.canonicalThreshold'),
          supportingThreshold: optionalNumberValue(limits.supportingThreshold, 'body.limits.supportingThreshold'),
        }));
      }
      if (operationId === 'getSkill') {
        const id = requireIdParam(input.params);
        const head = store.transaction(input.actor, (tx: StorageTransaction) =>
          tx.skills.getHeadVersion(id, input.actor.scope),
        );
        // Agent-facing REST refuses to materialize inactive skills so
        // the runtime cannot accidentally serve a `stale` / `rejected`
        // / `candidate` row as if it were the active head. The storage
        // layer still keeps the historical repository reachable via
        // `getVersion` for audit / replay; the REST surface just does
        // not expose that path.
        if (!head || head.lifecycle !== 'active') throw notFound();
        return serializeSkillVersion(head);
      }
      if (operationId === 'listSkillResources') {
        const id = requireIdParam(input.params);
        const head = store.transaction(input.actor, (tx: StorageTransaction) =>
          tx.skills.getHeadVersion(id, input.actor.scope),
        );
        if (!head || head.lifecycle !== 'active') throw notFound();
        const resources = store.transaction(input.actor, (tx: StorageTransaction) =>
          tx.skills.resourceList(id, input.actor.scope),
        );
        return { items: resources.map(serializeSkillResourceMeta) };
      }
      if (operationId === 'readSkillResource') {
        const id = requireIdParam(input.params);
        const resourcePath = requireResourcePath(input.params);
        const head = store.transaction(input.actor, (tx: StorageTransaction) =>
          tx.skills.getHeadVersion(id, input.actor.scope),
        );
        if (!head || head.lifecycle !== 'active') throw notFound();
        const record = store.transaction(input.actor, (tx: StorageTransaction) =>
          tx.skills.resourceRead(id, resourcePath, input.actor.scope),
        );
        return serializeSkillResourceRecord(record);
      }
      throw new HubError(
        'NOT_IMPLEMENTED',
        `operation ${operationId} is not wired by the launcher`,
        501,
      );
    }) satisfies RestHub['dispatch'],
  };

  const verifier: AuthVerifier | undefined = authMode === 'bearer'
    ? (token: string, requestId?: string) => store.authenticateCredential(token, requestId ?? 'rest-auth', parseRequestedCapabilities(env))
    : bearerToken
      ? (token: string) => (token === bearerToken ? localActor : null)
      : undefined;

  let server: Awaited<ReturnType<typeof listen>>;
  try {
    server = await listen({
      hub,
      localMode: authMode === 'local-dev',
      localActor: authMode === 'local-dev' ? localActor : undefined,
      verifier,
      host,
      port,
      storage,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    writeDiagnostic(stderr, 'error', `failed to bind ${host}:${port}: ${message}`);
    store.close();
    return 1;
  }

  const address = server.address();
  const url = address && typeof address !== 'string'
    ? `http://${address.address}:${address.port}`
    : `http://${host}:${port}`;
  stderr.write(`AGENT_MEMORY_READY ${JSON.stringify({ url, dbPath })}\n`);

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals | 'manual'): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    writeDiagnostic(stderr, 'shutdown', `received ${signal}; closing server then store`);
    server.close((serverError) => {
      if (serverError) writeDiagnostic(stderr, 'error', `server close failed: ${serverError.message}`);
      try {
        store.close();
      } catch (storeError) {
        const message = storeError instanceof Error ? storeError.message : 'unknown error';
        writeDiagnostic(stderr, 'error', `store close failed: ${message}`);
        exit(1);
        return;
      }
      exit(0);
    });
  };

  const onSigterm = options.signals?.onSigterm ?? ((handler: () => void) => process.on('SIGTERM', handler));
  const onSigint = options.signals?.onSigint ?? ((handler: () => void) => process.on('SIGINT', handler));
  onSigterm(() => shutdown('SIGTERM'));
  onSigint(() => shutdown('SIGINT'));

  // Park until the shutdown path exits the process. The signal
  // handlers call `exit()` directly, so this await is the only thing
  // keeping the module-level `runLauncher()` alive after `listen()`
  // resolves.
  return await new Promise<number>((resolveShutdown) => {
    // No-op resolver — the signal handlers own the exit. This promise
    // exists so a stray caller that ignores the signal-handler-driven
    // exit still gets a defined return value.
    void resolveShutdown;
  });
}

/**
 * Validate and normalize the body of a `POST /api/v1/memories` request
 * into a `MemoryCreate` shape that the storage layer will accept.
 *
 * The REST surface accepts a slightly looser payload (no `requestId`,
 * no `reason`) than the in-process `MemoryCreate` contract, so we
 * synthesize those fields from the inbound request. Anything that
 * does not match the contract throws `HubError('VALIDATION', ...)`
 * with HTTP 400; the REST app's error mapper converts that to a JSON
 * response on the wire.
 */
function normalizeMemoryCreate(body: unknown, actor: ActorContext, requestId: string): MemoryCreate {
  if (body === null || typeof body !== 'object') {
    throw new HubError('VALIDATION', 'memory body must be a JSON object', 400);
  }
  const raw = body as Record<string, unknown>;
  const kind = typeof raw.kind === 'string' ? raw.kind : '';
  const scopeKey = typeof raw.scopeKey === 'string' ? raw.scopeKey : '';
  const content = raw.content;
  const reason = typeof raw.reason === 'string' ? raw.reason : '';
  if (kind.length === 0) throw new HubError('VALIDATION', 'memory.kind is required', 400);
  if (scopeKey.length === 0) throw new HubError('VALIDATION', 'memory.scopeKey is required', 400);
  if (content === null || typeof content !== 'object' || Array.isArray(content)) {
    throw new HubError('VALIDATION', 'memory.content must be an object', 400);
  }
  if (reason.length === 0) throw new HubError('VALIDATION', 'memory.reason is required', 400);

  const lifecycle = raw.lifecycle === 'active' ? 'active' : 'candidate';
  const confidence = typeof raw.confidence === 'number' ? raw.confidence : undefined;
  const importance = typeof raw.importance === 'number' ? raw.importance : undefined;
  const sourceEventIds = Array.isArray(raw.sourceEventIds)
    ? raw.sourceEventIds.filter((value): value is string => typeof value === 'string')
    : undefined;

  const create: MemoryCreate = {
    kind: kind as MemoryCreate['kind'],
    scope: actor.scope,
    scopeKey,
    content: content as Record<string, unknown>,
    reason,
    requestId,
    lifecycle,
  };
  if (confidence !== undefined) (create as { confidence?: number }).confidence = confidence;
  if (importance !== undefined) (create as { importance?: number }).importance = importance;
  if (sourceEventIds !== undefined) (create as { sourceEventIds?: string[] }).sourceEventIds = sourceEventIds;
  return create;
}

/**
 * Validate and normalize the body of a `POST /api/v1/memories/{id}/supersede`
 * request into a `MemorySupersede` shape that the storage layer will accept.
 *
 * The REST surface omits `scope` (taken from the actor) and `requestId`
 * (synthesized from the inbound request). Anything that does not match
 * the contract throws `HubError('VALIDATION', ...)` with HTTP 400.
 */
function normalizeMemorySupersede(body: unknown, actor: ActorContext, requestId: string): MemorySupersede {
  const create = normalizeMemoryCreate(body, actor, requestId);
  const expectedVersion = requireIntegerField(body, 'expectedVersion');
  return { ...create, expectedVersion };
}

function requireIdParam(params: Record<string, string>): string {
  const id = params.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new HubError('VALIDATION', 'params.id is required', 400);
  }
  return id;
}

function requireSkillRead(actor: ActorContext): void {
  if (!actor.capabilities.includes('skill.read') && !actor.capabilities.includes('read')) {
    throw new HubError('FORBIDDEN', 'skill.read capability required', 403);
  }
}

function parseGraphLimits(query: Record<string, string>): NonNullable<GlobalGraphOptions['limits']> {
  const limits: NonNullable<GlobalGraphOptions['limits']> = {};
  const maxDepth = parseOptionalPositiveInteger(query.depth ?? query.maxDepth, 'query.depth');
  const maxNodes = parseOptionalPositiveInteger(query.maxNodes, 'query.maxNodes');
  const maxEdges = parseOptionalPositiveInteger(query.maxEdges, 'query.maxEdges');
  if (maxDepth !== undefined) limits.maxDepth = maxDepth;
  if (maxNodes !== undefined) limits.maxNodes = maxNodes;
  if (maxEdges !== undefined) limits.maxEdges = maxEdges;
  return limits;
}

function parseGlobalGraphOptions(query: Record<string, string>): GlobalGraphOptions {
  return {
    limits: parseGraphLimits(query),
    includeHistory: normalizeGraphVersionMode(query.versions) === 'history',
  };
}

function parseCenteredGraphOptions(query: Record<string, string>): CenteredGraphOptions {
  return {
    ...parseGlobalGraphOptions(query),
    mode: normalizeGraphMode(query.mode),
  };
}

/**
 * Validate that a `query.profileId` value is a non-empty string. The
 * launcher is the single source of truth for the memory-blocks REST
 * surface, so it is responsible for refusing untyped or absent query
 * parameters with HTTP 400 before touching storage. Any non-string,
 * empty, or whitespace-only value is treated as missing.
 */
function requireQueryProfileId(query: Record<string, string>): string {
  const raw = query.profileId;
  if (typeof raw !== 'string') {
    throw new HubError('VALIDATION', 'query.profileId is required', 400);
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new HubError('VALIDATION', 'query.profileId must be a non-empty string', 400);
  }
  return trimmed;
}

function requireQueryQ(query: Record<string, string>): string {
  const raw = query.q;
  if (typeof raw !== 'string') {
    throw new HubError('VALIDATION', 'query.q is required', 400);
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new HubError('VALIDATION', 'query.q must be a non-empty string', 400);
  }
  return trimmed;
}

function parseSearchLimit(raw: string | undefined): number {
  if (raw === undefined) return SEARCH_LIMIT_DEFAULT;
  if (!/^[1-9][0-9]*$/u.test(raw)) {
    throw new HubError('VALIDATION', `query.limit must be an integer in 1..${SEARCH_LIMIT_MAX}`, 400);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > SEARCH_LIMIT_MAX) {
    throw new HubError('VALIDATION', `query.limit must be an integer in 1..${SEARCH_LIMIT_MAX}`, 400);
  }
  return value;
}

function parseCatalogKind(raw: string | undefined): 'repository' | 'skill' | 'document' | 'tool' | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'repository' || raw === 'skill' || raw === 'document' || raw === 'tool') return raw;
  throw new HubError('VALIDATION', 'query.kind must be repository, skill, document, or tool', 400);
}

function requireObjectBody(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HubError('VALIDATION', 'request body must be a JSON object', 400);
  }
  return body as Record<string, unknown>;
}

function requireNonEmptyString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HubError('VALIDATION', `body.${field} is required`, 400);
  }
  return value.trim();
}

function normalizeCatalogSyncInput(body: unknown, scope: Scope): SyncInput {
  const raw = requireObjectBody(body);
  if (!Array.isArray(raw.roots) || raw.roots.length === 0) {
    throw new HubError('VALIDATION', 'body.roots must be a non-empty array', 400);
  }
  const roots = raw.roots.map((root, index) => {
    if (root === null || typeof root !== 'object' || Array.isArray(root)) {
      throw new HubError('VALIDATION', `body.roots[${index}] must be an object`, 400);
    }
    const value = root as Record<string, unknown>;
    const id = requireNonEmptyString(value, 'id');
    const path = requireNonEmptyString(value, 'path');
    return { id, path };
  });
  let selectors: string[] | undefined;
  if (raw.selectors !== undefined) {
    if (!Array.isArray(raw.selectors) || raw.selectors.some((value) => typeof value !== 'string' || value.trim().length === 0)) {
      throw new HubError('VALIDATION', 'body.selectors must be an array of non-empty strings', 400);
    }
    selectors = raw.selectors.map((value) => (value as string).trim());
  }
  const profile = raw.profile === undefined ? 'default' : requireNonEmptyString(raw, 'profile');
  const input: SyncInput = { roots, scope, profile };
  if (selectors !== undefined) input.selectors = selectors;
  return input;
}

function requireStringField(body: unknown, field: string): string {
  if (body === null || typeof body !== 'object') {
    throw new HubError('VALIDATION', `${field} requires a JSON object body`, 400);
  }
  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new HubError('VALIDATION', `body.${field} is required`, 400);
  }
  return value;
}

function requireIntegerField(body: unknown, field: string): number {
  if (body === null || typeof body !== 'object') {
    throw new HubError('VALIDATION', `${field} requires a JSON object body`, 400);
  }
  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new HubError('VALIDATION', `body.${field} must be a non-negative integer`, 400);
  }
  return value;
}

function parseOptionalPositiveInteger(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^[1-9][0-9]*$/u.test(raw)) throw new HubError('VALIDATION', `${label} must be a positive integer`, 400);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new HubError('VALIDATION', `${label} must be a positive integer`, 400);
  return value;
}

function requirePositiveIntegerValue(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new HubError('VALIDATION', `${label} must be a positive integer`, 400);
  return Number(value);
}

function optionalIntegerValue(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : requirePositiveIntegerValue(value, label);
}

function optionalNumberValue(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new HubError('VALIDATION', `${label} must be a finite number`, 400);
  return value;
}

function parseRequestedCapabilities(env: Readonly<Record<string, string | undefined>>): string[] | undefined {
  const raw = env.AGENT_MEMORY_CAPABILITIES;
  return raw?.split(',').map((value) => value.trim()).filter(Boolean);
}

function writeDiagnostic(stderr: NodeJS.WritableStream, level: 'start' | 'error' | 'shutdown', message: string): void {
  stderr.write(`agent-memory-rest ${level}: ${message}\n`);
}

/**
 * Bound the `limit` query parameter for `GET /api/v1/skills/search`.
 * Mirrors `parseSearchLimit` (used by `searchMemories`) — same upper
 * bound (100), same default (20), same positive-integer validation —
 * so the two search surfaces share a single wire shape.
 */
function parseSkillSearchLimit(raw: string | undefined): number {
  if (raw === undefined) return SEARCH_LIMIT_DEFAULT;
  if (!/^[1-9][0-9]*$/u.test(raw)) {
    throw new HubError('VALIDATION', `query.limit must be an integer in 1..${SEARCH_LIMIT_MAX}`, 400);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > SEARCH_LIMIT_MAX) {
    throw new HubError('VALIDATION', `query.limit must be an integer in 1..${SEARCH_LIMIT_MAX}`, 400);
  }
  return value;
}

/**
 * Validate the `resourcePath` path parameter. The router decodes the
 * capture group via `decodeURIComponent` before this point, so the
 * value here is already in canonical POSIX form. The launcher still
 * rejects empty strings (which a degenerate `//` would decode to)
 * with HTTP 400 — path traversal is the storage layer's job (it is
 * enforced again at write time), but the REST surface must not let a
 * blank path reach the dispatcher.
 */
function requireResourcePath(params: Record<string, string>): string {
  const value = params.resourcePath;
  if (typeof value !== 'string' || value.length === 0) {
    throw new HubError('VALIDATION', 'params.resourcePath must be a non-empty string', 400);
  }
  return validateResourcePath(value);
}

/** Serialize a bounded discovery hit without the full skill body. */
function serializeSkillSearchHit(hit: SkillSearchHit): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: hit.id,
    scope: { ownerUserId: hit.scope.ownerUserId, agentId: hit.scope.agentId },
    logicalKey: hit.logicalKey,
    kind: hit.kind,
    name: hit.name,
    lifecycle: hit.lifecycle,
    version: hit.version,
    bodySha256: hit.bodySha256,
    totalSize: hit.totalSize,
    metadata: hit.metadata,
    resources: hit.resources.map(serializeSkillResourceMeta),
    createdAt: hit.createdAt,
    updatedAt: hit.updatedAt,
  };
  if (hit.summary !== undefined) base.summary = hit.summary;
  return base;
}

/**
 * Serialize a `SkillVersion` to the REST wire shape:
 *
 *   * `body` is the UTF-8 string (the repo persists it as `Buffer`,
 *     and JSON has no canonical Buffer shape; UTF-8 is the only
 *     lossless text encoding available in JSON).
 *   * `resources` is the per-resource metadata WITHOUT bytes (callers
 *     fetch the bytes via `readSkillResource` which returns them
 *     base64-encoded below).
 *
 * The shape mirrors `SkillVersion` from `packages/core` minus the
 * `Buffer` fields (`body`) plus the canonical field names used by the
 * OpenAPI schema (`./components/schemas.yaml#/SkillVersion`).
 */
function serializeSkillVersion(version: SkillVersion): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: version.id,
    scope: {
      ownerUserId: version.scope.ownerUserId,
      agentId: version.scope.agentId,
    },
    logicalKey: version.logicalKey,
    kind: version.kind,
    name: version.name,
    lifecycle: version.lifecycle,
    version: version.version,
    body: Buffer.from(version.body).toString('utf8'),
    bodySha256: version.bodySha256,
    totalSize: version.totalSize,
    metadata: version.metadata,
    resources: version.resources.map(serializeSkillResourceMeta),
    createdAt: version.createdAt,
    updatedAt: version.updatedAt,
  };
  if (version.summary !== undefined) base.summary = version.summary;
  return base;
}

function serializeSkillResourceMeta(resource: { relativePath: string; mode: 0o644 | 0o755; mime: string; size: number; sha256: string }): Record<string, unknown> {
  return {
    relativePath: resource.relativePath,
    mode: resource.mode,
    mime: resource.mime,
    size: resource.size,
    sha256: resource.sha256,
  };
}

/**
 * Serialize a `SkillResourceRecord` to the REST wire shape. Resource
 * bytes are base64-encoded with an explicit `encoding: 'base64'`
 * marker so the wire format is self-describing — JSON has no canonical
 * Buffer shape, and serializing the raw `Buffer` to JSON would yield
 * an array of byte values which is ambiguous (the same payload could
 * also be a JSON array of numbers in another context). The
 * `encoding`/`bytes` pair is the canonical contract declared by
 * `./components/schemas.yaml#/SkillResourceRecord`.
 */
function serializeSkillResourceRecord(record: { relativePath: string; mode: 0o644 | 0o755; mime: string; size: number; sha256: string; bytes: Buffer }): Record<string, unknown> {
  return {
    relativePath: record.relativePath,
    mode: record.mode,
    mime: record.mime,
    size: record.size,
    sha256: record.sha256,
    encoding: 'base64' as const,
    bytes: Buffer.from(record.bytes).toString('base64'),
  };
}

/** Local `notFound()` to keep the dispatcher readable. */
function notFound(): HubError {
  return new HubError('NOT_FOUND', 'skill not found', 404);
}