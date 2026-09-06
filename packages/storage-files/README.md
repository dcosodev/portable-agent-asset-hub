# `@portable-agent-asset-hub/storage-files`

Filesystem-backed storage adapter. It implements the storage contracts
declared in `@portable-agent-asset-hub/core` (`core/src/storage/contracts.ts`)
against plain files on disk instead of SQLite.

## What lives here

- **`root-scanner.ts`** — walks a filesystem root and discovers candidate
  assets (skill packs, resources) to feed into the catalog.
- **`skill-pack-importer.ts`** — imports a skill pack directory into the
  domain shapes `core` expects, including the secret-scanning and
  derivation steps from `core/src/importer/`.
- **`materializer.ts`** — writes materialized files back to disk (the
  filesystem side of a `preview → apply` cycle).
- **`sync-coordinator.ts`** / **`sync-marker.ts`** — coordinate and mark
  catalog sync runs so a re-scan can tell what changed since the last one.

## Role in the system

`core` never touches the filesystem directly for domain data. When a flow
needs to read from or write to a directory tree — importing a skill pack,
scanning a catalog source, materializing a projection — it goes through
this package. `@portable-agent-asset-hub/storage-sqlite` is the *canonical*
authority (per [ADR 0001](../../docs/adr/0001-single-sqlite-owner.md));
this package is used for portable fixtures and for the filesystem side of
import/materialization flows, not as an alternative source of truth.

## Build

```sh
pnpm --filter @portable-agent-asset-hub/storage-files build
```
