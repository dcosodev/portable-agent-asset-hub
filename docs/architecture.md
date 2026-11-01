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

Reads and writes reach the hub through REST, MCP stdio or the SDKs, and all writes pass through the same core services and storage adapters. The five runtimes hang off one adapter package: `computePreview` produces a digest, `applyPlan` refuses a stale one, and `rollbackPlan` undoes exactly what was applied. A runtime never reaches SQLite. Adding a runtime adds a renderer, not a source of truth.

## What ships

- **OpenAPI 3.1 contract** in [`openapi/openapi.yaml`](../openapi/openapi.yaml), with `x-mcp.*` extensions and drift detection. See [`api-surface.md`](api-surface.md).
- **REST** at `/api/v1/...` on `node:http`: bearer auth, optional loopback `localMode`, `If-Match` CAS on mutating routes that declare it, `x-request-id` propagation and structured `HubError` responses.
- **MCP stdio server** whose tool registry is derived from the OpenAPI `x-mcp.*` extensions, so each tool maps 1:1 to a REST operation. It has no local database and no local-mode fallback.
- **TypeScript and Python SDKs** generated with OpenAPI Generator `7.10.0` (`typescript-fetch` and `python`), with a `PROVENANCE.json` per tree and pinned `contract_fixtures/`.
- **Skills** owned by the database: immutable integer versions, byte-exact resources, catalog FTS, and a skill-pack importer with secret scanning (migrations 0014 to 0016). `SKILL.md` is never relation truth.
- **Skill graph and mandatory retrieval** ([`skill-graph-retrieval.md`](skill-graph-retrieval.md)): eight canonical relation types, bounded structural expansion, immutable version resolution and an append-only `retrieval_events` audit with a redacted query. The query classifier is a deterministic Spanish and English lexical matcher; other languages fall back to `general_knowledge`.
- **Relation proposals** ([`skill-relations.md`](skill-relations.md), [`relation-proposal-workflow.md`](relation-proposal-workflow.md)): discovery and explicit `related_skills` metadata produce candidates, never canonical edges. Review, apply preview, plan digest and governed apply are the only path into `skill_relations` (migrations 0018 and 0019).
- **Materializers** for Hermes and OpenClaw with `preview`, `apply` and `rollback`, driven by versioned manifests and a CAS-based lock.
- **Runtime adapters** ([`runtime-adapters.md`](runtime-adapters.md)) for Codex, Claude Code, OpenCode, Hermes and OpenClaw.
- **Skill export**: deterministic focal and full exports with canonical relation manifests.
- **Graph Explorer** ([`web-graph-explorer.md`](web-graph-explorer.md)): a React and Cytoscape UI behind a BFF. It never opens SQLite. The only writes it forwards are an anchored allowlist of governed relation actions on loopback. Serving to a private LAN is opt-in and refuses every mutation.
- **Migration surface**: classifier, redactor, shadow, replay, retirement and cutover.
- **Runtime credential bindings** and the `GET /api/v1/capabilities` handshake (migration 0017).
- **Telemetry** ([`observability.md`](observability.md)): opt-in OpenTelemetry, off by default and fail-open, with a Docker stack under [`observability/`](../observability/README.md).
- **`hub` CLI** in Go ([`architecture/go-product-shell.md`](architecture/go-product-shell.md)).

## Domain surfaces

| Subsystem | Implementation | Public interface | Persistence / tests |
|---|---|---|---|
| Runtime and actor context | `packages/rest/src/launcher.ts`, `packages/core/src/runtime/actor-context.ts` | `ActorContext`, capabilities, scope | REST auth/runtime tests |
| MCP | `packages/mcp`, generated registry | stdio tools derived from OpenAPI | `tests/mcp/*` |
| REST | `packages/rest/src/app.ts`, `packages/rest/src/routes/*.ts` | OpenAPI operations, listed in [`api-surface.md`](api-surface.md) | `tests/rest/*`, drift gate |
| Storage resolution | `packages/core/src/storage/config.ts` | canonical/temporary/test mode and path precedence | `tests/storage-config.test.ts` |
| SQLite storage | `packages/storage-sqlite/src` | public `SqliteStore`; `./internal` only for authorized production analytics/tests | storage boundary and storage tests |
| Skills | `packages/storage-sqlite/src/repositories/skill.ts` | entries, immutable versions, resources | storage/import/export tests |
| Retrieval | `packages/core/src/skills/retrieval.ts`, storage FTS repositories | search and graph retrieval DTOs | retrieval and MCP tests |
| Canonical graph | `packages/core/src/skills/graph*.ts`, storage graph repository | graph REST endpoints | graph explorer/storage tests |
| Relation proposals | `packages/core/src/skills/relation-proposals.ts`, storage repository | list/create/review/preview/apply | proposal tests |
| Explicit metadata candidates | `packages/core/src/skills/explicit-relations.ts`, storage adapter, `ExplicitRelationQueue.tsx` | list, impact preview, stage | explicit relation tests and Graph Explorer |
| Discovery / FTS | `scripts/relations.mjs`, proposal discovery service | suggestions only | discovery tests; never canonical truth |
| Import/export | `scripts/import-agent-skills.mjs`, `scripts/export-agent-skills.mjs` | manifests and official CLI flows | import/export tests |
| Doctor | storage `doctor.ts`, `/api/v1/admin/doctor` | integrity and runtime diagnostics | doctor/gate tests |
| OpenAPI / SDK | `openapi/`, `scripts/check-openapi-drift.mjs`, `scripts/generate-sdks.mjs` | REST contract and generated TS/Python clients | OpenAPI contract and drift tests |
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
