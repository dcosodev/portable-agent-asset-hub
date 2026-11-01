# Packages and repository layout

## Packages

Each package has a README with a file-by-file breakdown.

| Package | Role |
| --- | --- |
| [`core`](../packages/core/README.md) | Domain types, `HubError`, `ActorContext`, policy, events, skill-pack importer and core services. No SQLite imports. |
| [`rest`](../packages/rest/README.md) | `node:http` server for `/api/v1/...`: bearer auth, loopback `localMode`, `If-Match` CAS and `x-request-id` propagation. |
| [`mcp`](../packages/mcp/README.md) | MCP stdio server. Has no database; calls REST through `rest-transport.ts`. Its tool registry comes from the `x-mcp.*` OpenAPI extensions. |
| [`materializers`](../packages/materializers/README.md) | Hermes (`./hermes`) and OpenClaw (`./openclaw`) materializers with `preview`, `apply` and `rollback`, versioned manifests and a CAS-based lock. |
| [`runtime-adapters`](../packages/runtime-adapters/README.md) | Attaches a hub to Codex, Claude Code, OpenCode, Hermes or OpenClaw. See [`runtime-adapters.md`](runtime-adapters.md). |
| [`storage-sqlite`](../packages/storage-sqlite/README.md) | SQLite storage and the only package that opens the database ([ADR 0001](adr/0001-single-sqlite-owner.md)). |
| [`storage-files`](../packages/storage-files/README.md) | Filesystem storage adapter. |
| [`skill-export`](../packages/skill-export/README.md) | Deterministic focal and full exports with canonical relation manifests. Proposals are not exported as canonical graph data. |
| [`migration`](../packages/migration/README.md) | Migration and cutover: classifier, redactor, shadow, replay, retirement. |
| [`graph-ui`](../packages/graph-ui/README.md) | Web Graph Explorer (React, Vite, Cytoscape.js) and its BFF. See [`web-graph-explorer.md`](web-graph-explorer.md). |
| [`telemetry`](../packages/telemetry/README.md) | Opt-in OpenTelemetry kernel. See [`observability.md`](observability.md). |
| [`baseline`](../packages/baseline/README.md) | Builds and verifies the public-surface manifest. |
| [`sdk-ts`](../packages/sdk-ts/README.md) | TypeScript client, with a generated `typescript-fetch` tree. |
| [`sdk-python`](../packages/sdk-python/README.md) | Generated Python SDK. |

Workspace package names take the form `@portable-agent-asset-hub/<name>`.

## Repository layout

| Path | Contents |
|---|---|
| `openapi/` | The API contract: `openapi.yaml` and `components/`. |
| `packages/` | The packages above. |
| `cmd/hub/`, `internal/` | The Go `hub` CLI. See [`architecture/go-product-shell.md`](architecture/go-product-shell.md). |
| `schemas/` | JSON Schema files used by the MCP tool generator, the gates and the tests. |
| `scripts/` | Generators, drift checks and gates. See [`validation.md`](validation.md). |
| `tests/` | Contract, integration, E2E and gate tests. |
| `examples/demo/` | The end-to-end demo. See [`demo.md`](demo.md). |
| `integrations/openclaw/` | OpenClaw plugin schema and integration files. |
| `observability/` | Compose stack: Collector, Prometheus, Tempo, Grafana. See [`../observability/README.md`](../observability/README.md). |
| `slices/` | Isolated spikes and their decision records. See [`../slices/README.md`](../slices/README.md). |
| `docs/adr/` | Architecture decision records. |
| `docs/baseline/` | Public baseline fixture and manifest. Hash-pinned: do not edit by hand. |
| `artifacts/` | Gate evidence. Git-ignored. |
