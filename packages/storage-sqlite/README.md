# `@portable-agent-asset-hub/storage-sqlite`

The **canonical** storage adapter. This is the single package allowed to own
the SQLite connection lifecycle — see
[ADR 0001](../../docs/adr/0001-single-sqlite-owner.md) for why.

## What lives here

- **`database.ts`** (`HubDatabase`) — opens and owns the `node:sqlite`
  connection. Intentionally *not* re-exported from the public entry point;
  tests that need a second connection go through the `/internal` entry
  point instead.
- **`migrations/0001_*.sql` … `0020_*.sql`** — the full schema history, run
  in order by `migrations/runner.ts`. Each file is additive; see
  `docs/canonical-storage.md` and the migration comments for what each one
  introduced (identities → harnesses → bindings → memories → catalog →
  skills → skill graph/retrieval → relation proposals).
- **`repositories/`** — one repository per domain entity (`audit`,
  `binding`, `credential`, `event`, `explicit-relations`, `identity`,
  `memory`, `memory-source`, `relation-proposal`, `skill`). Each repository
  is the only place that writes raw SQL for that entity; `core` calls into
  these through the `Storage` interface, never through ad-hoc queries.
- **`search/memory-fts.ts`** — the FTS5-backed full-text search used by
  memory retrieval.
- **`backup.ts`** / **`doctor.ts`** — online backup and a diagnostic report
  (`GET /api/v1/admin/doctor`) over the live database.
- **`catalog-sync-repository.ts`**, **`profile-repository.ts`**,
  **`skill-pack-coordinator.ts`** — catalog sync bookkeeping, profile
  persistence, and the coordinator that applies an imported skill pack
  transactionally.
- **`transaction.ts`** — the shared transaction helper every repository
  writes through, so multi-repository writes stay atomic.

## Role in the system

Every mutating and most reading paths in `rest` and `mcp` ultimately reach
this package through `core`'s `Storage` interface. Nothing outside this
package (and its `/internal` escape hatch for tests) opens the database
file directly.

## Build

```sh
pnpm --filter @portable-agent-asset-hub/storage-sqlite build
```

`pnpm build` at the workspace root also copies the `migrations/*.sql` files
into `dist/` (see the root `package.json#build` script) since they are read
from disk at runtime, not bundled.
