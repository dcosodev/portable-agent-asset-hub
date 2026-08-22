# ADR 0001: Single SQLite owner

- **Status:** Accepted
- **Date:** 2026-08 (public export)

## Context

Several workspace packages interact with persisted state: `core` dispatches
domain operations, `rest` serves the HTTP surface, `mcp` exposes the MCP
facade, and `migration` and `materializers` read and write assets. If each
of these packages were allowed to open the canonical SQLite database
directly, the system would face three recurring problems:

1. **Ownership ambiguity.** Concurrent writers with independent connections
   make transactional guarantees (audit-on-mutation, idempotency replay,
   rollback of partial writes) impossible to enforce in one place.
2. **Migration races.** Any package could observe or mutate a database that
   another package was mid-migration on, with no single checksum authority.
3. **Auditability.** The contract requires that every domain mutation appends
   its audit event inside the same transaction. That invariant can only be
   enforced where the connection is created.

The runtime also uses `node:sqlite`, which is experimental on the supported
Node >= 22.16 line; concentrating its use in one package limits the blast
radius of upstream API changes.

## Decision

Only `@portable-agent-asset-hub/storage-sqlite` may open the canonical
SQLite database, and inside that package only
`packages/storage-sqlite/src/database.ts` performs the open. Every other
package consumes storage through the governed `SqliteStore` contract
exported by that package (or through the filesystem adapter in
`storage-files`). The MCP facade never opens a database at all: it talks to
the REST surface through `rest-transport.ts`.

The rule is enforced mechanically, not by convention:

- `scripts/scan-sqlite-owner.mjs` scans the workspace for out-of-owner
  SQLite imports and fails the staged gates on any violation.
- `tests/mcp/no-sqlite-import.test.ts` asserts the MCP package has no
  SQLite dependency, direct or transitive.
- Migrations `0001`–`0013` are checksummed by the runner in the owning
  package and fail closed on drift; `SqliteStore.doctor()` compares stored
  names and checksums against the packaged canonical SQL.

## Consequences

- Migrations, checksums, doctor, and backup logic live in exactly one
  package, and the audit-in-same-transaction invariant is enforceable.
- Other packages pay a small indirection cost: they cannot reach for a raw
  connection even for reads, and internal handles (`HubDatabase`, raw
  `DatabaseSync`, `migrate(db)`, `loadMigrations`) are deliberately absent
  from the public package exports.
- The gates carry a permanent enforcement step (owner scan), so a future
  violation is a build failure rather than a code-review catch.
