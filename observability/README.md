# Portable Docker stack

This directory runs the persistent Hub backend and its local observability stack. Hermes is not a product service and is not part of this Compose deployment.

## Architecture

```text
agent / harness
  └─ docker compose run --rm --no-deps -T hub-mcp
                         │ MCP stdio process (ephemeral)
                         ▼
                     hub-rest:39421
                         │ owns /data/hub.sqlite
                         └─ OTLP/HTTP → otel-collector:4318
                                             ├─ OTLP/gRPC → tempo:4317
                                             └─ metrics :9464 ← prometheus
                                                                    │
                                                       grafana ←────┴─→ tempo
```

Only `hub-rest` mounts `hub-data`. MCP processes call REST and never open SQLite, so multiple agents share one canonical database without duplicating state.

## Requirements

- Docker Engine with Docker Compose.
- ARM64 is exercised by the local gate; the Node base image is multi-architecture.
- Ports `127.0.0.1:39421` and `127.0.0.1:3000` must be free.

Colima is a valid local backend on macOS, not a product requirement. If it is
not the implicit context, use `docker --context colima compose ...` in place of
`docker compose ...`.

## Start

```sh
# Recommended: supply a private token in your shell. It is consumed by
# hub-rest and ephemeral hub-mcp processes and is not written to the repo.
export HUB_BEARER_TOKEN="$(openssl rand -hex 24)"

docker compose -p portable-hub \
  -f observability/compose.yaml \
  up -d --build --wait
```

Compose has a known local-development fallback when `HUB_BEARER_TOKEN` is absent. That fallback is suitable only because default host publications are loopback-only. Set a private value before any non-local adaptation.

Check REST and Grafana:

```sh
curl -fsS \
  -H "Authorization: Bearer ${HUB_BEARER_TOKEN}" \
  http://127.0.0.1:39421/api/v1/health

curl -fsS http://127.0.0.1:3000/api/health
open http://127.0.0.1:3000
```

## Connect one or more MCP agents

MCP stdio is one process per agent connection. The process is stateless and ephemeral; all sessions point to the same `hub-rest` service.

Use this command in a harness configuration:

```text
docker compose -p portable-hub -f /absolute/path/to/observability/compose.yaml \
  --profile mcp run --rm --no-deps -T hub-mcp
```

Important details:

- Keep stdin open; do not allocate a TTY (`-T`).
- `--no-deps` prevents an MCP connection from recreating the persistent Hub.
- Protocol frames are the only MCP output on stdout. Diagnostics and Compose lifecycle messages use stderr.
- Every process receives `AGENT_MEMORY_REST_URL=http://hub-rest:39421` and the same bearer token through Compose.
- Starting two or more MCP processes does not create additional databases.

A local Node launcher remains supported separately; point it at `http://127.0.0.1:39421` and provide the same bearer token. A persistent remote MCP Streamable HTTP service is intentionally deferred until target-harness compatibility is validated.

### OpenClaw managed stdio

Register the command above as an OpenClaw-managed MCP stdio server. The
descriptor needs only:

- command: `docker`;
- arguments: Compose project/file, `--profile mcp run --rm --no-deps -T hub-mcp`;
- repository `cwd` and bounded startup/tool timeouts.

Do not put `HUB_BEARER_TOKEN` in the OpenClaw descriptor. Compose resolves it
from the operator environment and injects it into both containers. The included
MCP profile grants `write.memory`, which exposes the read baseline plus memory
create/supersede/forget; it grants no admin bucket and no DB access.

After `mcp reload` or a capability/config change, open a completely new agent
session. An already-running TUI may retain its old MCP child process and keep
returning stale tool schemas or transport errors even when a fresh probe works.
For a native integration proof, require real `agent-memory__*` tool calls from
that fresh session; shell `curl` or manual JSON-RPC is backend diagnosis only.

## Published ports

Default Compose publishes only:

| Host address | Service | Purpose |
|---|---|---|
| `127.0.0.1:39421` | Hub REST | authenticated API |
| `127.0.0.1:3000` | Grafana | local dashboards |

Collector, Tempo and Prometheus stay inside the Compose network. For manual diagnostics only:

```sh
docker compose -p portable-hub \
  -f observability/compose.yaml \
  -f observability/compose.debug.yaml \
  up -d
```

The override publishes OTLP `4318`, Collector metrics `9464`, Tempo `3200/4317` and Prometheus `9090`, all on host loopback.

## Persistence and teardown

`hub-data` is a named volume mounted only by `hub-rest`; the canonical file is `/data/hub.sqlite`.

```sh
# Recreate containers while preserving canonical data
docker compose -p portable-hub -f observability/compose.yaml down
docker compose -p portable-hub -f observability/compose.yaml up -d --wait

# Destructive: remove canonical Hub data plus local telemetry data
docker compose -p portable-hub -f observability/compose.yaml down -v
```

Never mount the same SQLite file into another writer. Do not place the database on a network filesystem.

## Verification

Static contract only:

```sh
pnpm docker:contract
```

Full isolated runtime gate:

```sh
pnpm docker:smoke
# or contract + smoke
pnpm docker:gate
```

The smoke uses a unique Compose project, asks Docker for dynamic host ports and
always runs `down -v` for that isolated project in `finally`. It can therefore
run alongside a persistent `portable-hub` stack without colliding with ports or
deleting its volumes. It verifies:

- REST and MCP image builds, ARM64 architecture and non-root users;
- authenticated REST health;
- non-empty `hub_requests_total` in Prometheus;
- real `hub.request` traces in Tempo;
- Grafana health, both datasources and four provisioned dashboards;
- semantic SQLite persistence after recreating `hub-rest`;
- two sequential MCP stdio sessions with JSON-only stdout;
- REST fail-open while Collector is stopped and telemetry recovery afterward;
- isolated cleanup.

Machine-readable evidence is written to:

```text
artifacts/docker-stack-smoke.json
```

## Provisioned dashboards

- Hub overview
- Retrieval
- Relations
- Health

Grafana uses internal datasource URLs `http://prometheus:9090` and `http://tempo:3200`.

## Security and limits

- Host publications are loopback-only by default; do not expose them to LAN or a public tunnel.
- The Hub requires bearer authentication because it binds `0.0.0.0` inside the private Compose network.
- Grafana anonymous Viewer access is acceptable only on host loopback in this development stack.
- The committed fallback bearer is development-only. Supply a private value for
  any real local data and rotate it if it may have been exposed.
- Telemetry is operational and disposable; SQLite remains canonical.
- Telemetry is opt-in in the application generally. This Compose profile explicitly opts into `standard` telemetry.
- Export failures are fail-open and do not block REST or SQLite writes.
- No cloud exporter, TLS termination or long-term observability retention is configured.
