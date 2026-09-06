# `@portable-agent-asset-hub/core`

Domain layer of the hub. Every other package depends on this one; this one
depends on nothing else in the workspace.

## What lives here

- **Domain types and contracts** for identities, profiles, memories, the
  skill catalog, the skill graph, and storage — the shapes every adapter
  (REST, MCP, SDKs, materializers) is built against.
- **`HubError`** (`src/errors.ts`) — the single structured error type the
  rest of the system maps to HTTP status codes, MCP error payloads, etc.
- **`ActorContext`** (`src/runtime/actor-context.ts`) and **policy /
  capabilities** (`src/policy/`) — who is making a request and what they are
  authorized to do. Authorization is enforced here; callers (REST routes,
  MCP tools) are expected to check `capabilities.includes(...)` at their
  boundary rather than re-implement the rule.
- **Services with real logic**, not just types:
  - `catalog/` — source scanning, sanitization, sync.
  - `memory/` — lifecycle, redaction, search.
  - `importer/` — MIME detection, secret scanning, derivation for imported
    files.
  - `skills/` — the versioned skill graph, relation types, relation
    proposals (discovery + governed review), and the mandatory-retrieval
    classifier. See the module-level comments in
    `src/skills/*.ts` and [`../../docs/skill-graph-retrieval.md`](../../docs/skill-graph-retrieval.md)
    for the full contract.
  - `events/`, `audit/`, `identity/`, `auth/`, `profiles/` — supporting
    domain services.
- **`storage/contracts.ts`** — the interfaces that `@portable-agent-asset-hub/storage-sqlite`
  and `@portable-agent-asset-hub/storage-files` implement. `core` defines the
  shape; it never opens a database itself except through those adapters.

## What does NOT live here

- No HTTP, no MCP, no filesystem I/O, no SQL. Those belong to `rest`, `mcp`,
  `storage-files` and `storage-sqlite` respectively. `core` stays a pure
  TypeScript domain package so it can be tested and reasoned about without
  a running server or database.

## Ownership note

Per [ADR 0001](../../docs/adr/0001-single-sqlite-owner.md), `core` is the
only package allowed to own the SQLite connection lifecycle (through the
storage adapter it is given). Everything downstream — REST, MCP, the
materializers — reaches storage by calling into `core`, never by opening a
database file directly.

## Build

```sh
pnpm --filter @portable-agent-asset-hub/core build
```

Consumed via `dist/index.js` (see `package.json#main`) once built; see the
root [`README.md`](../../README.md#quickstart) for the full workspace build.
