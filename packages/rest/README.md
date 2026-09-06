# `@portable-agent-asset-hub/rest`

The REST surface: `/api/v1/...` served by a plain `node:http` server, wired
from the same OpenAPI contract (`openapi/openapi.yaml`) that drives the MCP
facade and both generated SDKs.

## What lives here

- **`app.ts`** — `createApp`: builds the request handler (routing, auth,
  telemetry spans, error mapping) without binding a port.
- **`launcher.ts`** — the process-level entrypoint. Wires a real
  `@portable-agent-asset-hub/storage-sqlite` backend and documents the
  env-var contract the CLI shim reads (`AGENT_MEMORY_DB_PATH` and friends
  — see the header comment in that file for the full list).
- **`index.ts`** — `createRestServer` / `listen`, the public entry point.
- **`auth.ts`** — bearer auth, plus the opt-in loopback `localMode` that
  skips it for local-only deployments.
- **`context.ts`** — builds the `ActorContext` for a request (identity,
  scope) that every downstream `core` call receives.
- **`error-mapper.ts`** — maps `HubError` to HTTP status + structured JSON
  body, consistently across every route.
- **`routes/`** — one file per resource group: `admin`, `catalog`,
  `events`, `explicit-relations`, `health`, `identities`,
  `materializations`, `memories`, `memory-blocks`, `profiles`,
  `relation-proposals`, `skills`, `sync`. Each route only calls into
  `core`; there is no business logic in this package beyond HTTP framing.
- **`bin/agent-memory-rest.mjs`** — the `agent-memory-rest` CLI shim that
  invokes `launcher.ts`.

## Contract-driven, not hand-routed

Route existence, methods, `If-Match` CAS requirements (`x-cas-required`),
and idempotency (`x-idempotent`) all trace back to
[`../../openapi/openapi.yaml`](../../openapi/openapi.yaml) — see the "API
surface at a glance" table in the root
[`README.md`](../../README.md#api-surface-at-a-glance). `pnpm s6:drift`
fails if this package's behavior and the OpenAPI contract disagree.

## Build & run

```sh
pnpm --filter @portable-agent-asset-hub/rest build
AGENT_MEMORY_DB_PATH=/path/to/db.sqlite node packages/rest/bin/agent-memory-rest.mjs
```
