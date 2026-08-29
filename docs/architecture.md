# Architecture

Status: current product architecture. Run-specific counts belong in audit artifacts, not in this document.

## System map

```text
Runtime adapters (Codex / Claude Code / OpenCode / Hermes / OpenClaw)
        |
        v
      MCP stdio
        |
        v                                     .... OTLP (opt-in, fail-open)
 REST loopback / Graph Explorer BFF  ...............> OTel Collector
        |                                                 |
        v                                                 v
 Governed domain services                    Prometheus / Tempo / Grafana
        |
        v
 SQLite canonical hub (schema migrations 0001..0020) + FTS5
```

SQLite is the canonical authority for skills, versions, resources, proposals and the applied relation graph. Filesystem skill projections, generated SDKs and browser state are projections or clients; none is the relation authority.

The dotted branch is a side channel, drawn deliberately off the main path. Telemetry is off unless an operator opts in, degrades to a noop when misconfigured or unreachable, and carries no request bodies, prompts, query text or bearer tokens. It never substitutes for the durable audit trail, and no hub behavior depends on whether it is present, absent or broken. See [`observability.md`](observability.md) and [`adr/0004-opentelemetry-operational-side-channel.md`](adr/0004-opentelemetry-operational-side-channel.md).

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
| Graph Explorer BFF | `packages/graph-ui/server.ts` | read paths, plus an anchored allowlist of governed relation mutations on loopback | BFF allowlist and LAN boundary tests |
| Telemetry | `packages/telemetry` | opt-in spans and metrics with bounded attributes; noop by default | `tests/telemetry/*`, `observability:lint` |
| Observability stack | `observability/`, `Dockerfile` | non-root REST/MCP images, Collector, Prometheus, Tempo, Grafana | `docker:contract` (static), `docker:smoke` (live) |

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

Every arrow in that diagram is a human decision. Migration 0020 records *how* a proposal was approved (`approval_mode`, `auto_approve_rule`), and two closed-by-default eligibility predicates exist in `packages/core/src/skills/`, but nothing calls them: there is no persisted opt-in, no versioned policy and no runtime decision path. Review remains the only way a proposal becomes a relation.

## Storage contract

The server resolves storage using explicit CLI path, environment override, configured persistent directory, then platform persistent default. The resolved mode is server-side state. Canonical writes are refused when the resolved mode is temporary or test. See [`canonical-storage.md`](canonical-storage.md).

REST advertises the schema version it expects through `getStatus` and `getCapabilities`, and the migration runner refuses to open a database whose migration sequence is not the continuous chain `0001..0020`. A gap fails closed rather than migrating around it.

## Export/import

The official skill export contains skill/version/resource manifests plus canonical relation manifests. Import reconstructs the product DB through migrations and manifests. Proposals are staging data and are not silently promoted to canonical relations.

## Compatibility

Runtime adapters depend on the public REST/MCP contract rather than storage internals. `HubDatabase` is not exported from `@portable-agent-asset-hub/storage-sqlite`; the `./internal` subpath is an explicitly named internal-but-production-authorized boundary used only by the REST explicit-candidate analytics path and tests.
