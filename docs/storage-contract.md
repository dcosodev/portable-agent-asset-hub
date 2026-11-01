# Storage contract

This document describes the public surface of `@portable-agent-asset-hub/core` and
`@portable-agent-asset-hub/storage-sqlite`, and what `pnpm storage:gate` checks. For
storage modes and path resolution, see [`canonical-storage.md`](canonical-storage.md).

## Core

Core has no SQLite imports. Its public API exports opaque identity types and prefix
validation, policy and actor context, errors, audit, storage contracts and
idempotency types.

- IDs use the prefixes `usr_`, `agt_`, `hrn_` and `bnd_`.
- Creating an Agent requires an existing User. A Harness has no owner.
- Scope is `{ownerUserId, agentId}`. Out-of-scope reads are indistinguishable from a 404.
- Admin capabilities are denied by default.
- Actor context is created by the server and frozen with `Object.freeze`.

## SQLite storage

The package entrypoint exports the governed `SqliteStore`, path-based `backupDatabase`,
`SkillPackApplyCoordinator`, `SqliteExplicitRelationSource`, `HubError` and
non-sensitive diagnostics types.

`HubDatabase`, raw `DatabaseSync`, `doctor(db)`, `migrate(db)` and `loadMigrations` are
not on that entrypoint. The separate `./internal` subpath exposes raw accessors. It is
limited to tests and the REST explicit-candidate analytics path.

- `SqliteStore.transaction(actorContext, callback)` and
  `SqliteStore.idempotent(actorContext, input, callback)` require an actor derived on
  the server. Request payloads cannot supply it.
- SQLite handles are opened only in `packages/storage-sqlite/src`: `database.ts` for
  the store and `backup.ts` for backups.
- Migrations are checksummed. The runner refuses a database whose stored migrations
  drift from the packaged SQL, or whose sequence is not the continuous chain
  `0001..0020`. `SqliteStore.doctor()` compares stored names and checksums with the
  packaged SQL.
- Identity, binding, event and memory repositories append audit events automatically,
  using the same actor, inside the same transaction. An audit failure rolls back the
  domain mutation and every earlier audit event in the transaction.
- Idempotency records store a request digest and append `idempotency.complete` once.
  A replay causes no second mutation or audit event.

## Packaging

Each package tarball must expose coherent `exports`, `types` and `files`, plus
`dist/index.js` and `dist/index.d.ts`. The storage tarball includes every SQL migration
in `packages/storage-sqlite/src/migrations/`. Reproducibility is measured by sorted
archive paths and per-path byte SHA, not tar metadata.

## Runtime limit

`node:sqlite` is experimental on the supported Node `>=22.16` runtime. The gate records
this limit in its evidence and does not hide the warning. No API stability is claimed
beyond the package surface above.

## The gate

`pnpm storage:gate` runs lint, typecheck, targeted and full tests, build, the SQLite
owner scan, a fresh-process migration, doctor and backup check, package reproducibility,
external install, a dependency audit, and the spike regression in an isolated copy. It
writes evidence to `artifacts/storage-evidence.json`. A run passes only when every named
step passes and the targeted tests made at least one assertion.

The gate is local. See [`validation.md`](validation.md) for its current state.
