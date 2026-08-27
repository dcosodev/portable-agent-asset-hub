# Architecture

Status: current product architecture. Run-specific counts belong in audit artifacts, not in this document.

## System map

```text
Runtime adapters (Codex / Claude Code / OpenCode / Hermes / OpenClaw)
        |
        v
      MCP stdio
        |
        v
 REST loopback / Graph Explorer BFF
        |
        v
 Governed domain services
        |
        v
 SQLite canonical hub (schema migrations 0001..0019) + FTS5
```

SQLite is the canonical authority for skills, versions, resources, proposals and the applied relation graph. Filesystem skill projections, generated SDKs and browser state are projections or clients; none is the relation authority.

## Domain surfaces

| Subsystem | Implementation | Public interface | Persistence / tests |
|---|---|---|---|
| Runtime and actor context | `packages/rest/src/launcher.ts`, `packages/core/src/runtime/actor-context.ts` | `ActorContext`, capabilities, scope | REST auth/runtime tests |
| MCP | `packages/mcp`, generated registry | stdio tools derived from OpenAPI | `tests/mcp/*` |
| REST | `packages/rest/src/app.ts`, `packages/rest/src/routes/*.ts` | OpenAPI operations; 51 operationIds | `tests/rest/*`, drift gate |
| Storage resolution | `packages/core/src/storage/config.ts` | canonical/temporary/test mode and path precedence | `tests/storage-config.test.ts` |
| SQLite storage | `packages/storage-sqlite/src` | public `SqliteStore`; `./internal` only for authorized production analytics/tests | S2 boundary and storage tests |
| Skills | `packages/storage-sqlite/src/repositories/skill.ts` | entries, immutable versions, resources | storage/import/export tests |
| Retrieval | `packages/core/src/skills/retrieval.ts`, storage FTS repositories | search and graph retrieval DTOs | retrieval and MCP tests |
| Canonical graph | `packages/core/src/skills/graph*.ts`, storage graph repository | graph REST endpoints | graph explorer/storage tests |
| Relation proposals | `packages/core/src/skills/relation-proposals.ts`, storage repository | list/create/review/preview/apply | proposal tests |
| Explicit metadata candidates | `packages/core/src/skills/explicit-relations.ts`, storage adapter, `ExplicitRelationQueue.tsx` | list, impact preview, stage | explicit relation tests and Graph Explorer |
| Discovery / FTS | `scripts/relations.mjs`, proposal discovery service | suggestions only | discovery tests; never canonical truth |
| Import/export | `scripts/import-agent-skills.mjs`, `scripts/export-agent-skills.mjs` | manifests and official CLI flows | import/export tests |
| Doctor | storage `doctor.ts`, `/api/v1/admin/doctor` | integrity and runtime diagnostics | doctor/gate tests |
| OpenAPI / SDK | `openapi/`, `scripts/check-openapi-drift.mjs`, `scripts/generate-sdks.mjs` | REST contract and generated TS/Python clients | S6 contract/drift tests |

## Relation flow

```text
Explicit metadata       Discovery / FTS       Manual review
        \                     |                    /
         +------ skill_relation_proposals ------+
                              |
                    review -> preview -> planDigest
                              |
                       governed apply
                              |
                       skill_relations
```

`skill_relations` is the canonical graph. Graph Explorer is REST/BFF-only and never opens SQLite directly.

## Storage contract

The server resolves storage using explicit CLI path, environment override, configured persistent directory, then platform persistent default. The resolved mode is server-side state. Canonical writes are refused when the resolved mode is temporary or test. See [`canonical-storage.md`](canonical-storage.md).

## Export/import

The official skill export contains skill/version/resource manifests plus canonical relation manifests. Import reconstructs the product DB through migrations and manifests. Proposals are staging data and are not silently promoted to canonical relations.

## Compatibility

Runtime adapters depend on the public REST/MCP contract rather than storage internals. `HubDatabase` is not exported from `@portable-agent-asset-hub/storage-sqlite`; the `./internal` subpath is an explicitly named internal-but-production-authorized boundary used only by the REST explicit-candidate analytics path and tests.
