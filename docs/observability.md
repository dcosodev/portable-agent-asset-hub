# Observability (telemetry kernel)

This document describes the implemented operational telemetry kernel and its
REST/MCP/Docker integration. It is the current contract for allowed signals,
environment variables, lifecycle, privacy and failure behavior. Deployment
commands live in [`../observability/README.md`](../observability/README.md); the
system boundary lives in [`architecture.md`](architecture.md).

## Defaults

Telemetry is **OFF by default**. No exporter, no Node SDK, no listener is
created unless operators opt in through environment variables:

```text
TELEMETRY_ENABLED=false
TELEMETRY_LEVEL=off
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
OTEL_SERVICE_NAME=portable-agent-asset-hub
TELEMETRY_SAMPLE_RATIO=1.0
TELEMETRY_EXPORT_INTERVAL_MS=30000
```

`OTEL_EXPORTER_OTLP_HEADERS` is intentionally undocumented here: those values
are operational secrets. They must arrive from the process environment or a
secret manager and must never be committed to source or docs.

## Levels

| Level    | Description                                                       |
|----------|--------------------------------------------------------------------|
| `off`    | Kernel returns a no-op handle. No exporters, no SDK, no traffic.  |
| `basic`  | Root spans and metrics for operation/status/duration only.        |
| `standard` | Adds child spans for retrieval, FTS and graph stages.           |
| `debug`  | No raw text, bodies, queries, resources or headers. Diagnostics only. |

Unknown values, malformed endpoints, sample ratios outside `[0,1]` and a
disabled env downgraded to a no-op handle with a sanitized diagnostic. The
process never throws because of telemetry.

## Audit vs telemetry

| Concern                | Owner                       | Retention        |
|------------------------|-----------------------------|------------------|
| Domain events          | `audit`, `events`, `auth_events`, `retrieval_events` (SQLite) | Durable / replay |
| Conversation history   | Agent runtime (Hermes, etc.) | Runtime-owned    |
| Operational telemetry  | `@portable-agent-asset-hub/telemetry` | Bounded / disposable |

Telemetry never replaces, mirrors or alters SQLite evidence. The kernel never
writes to SQLite: traces and audit rows use independent code paths.

## Allowed attribute and label sets

Span attributes and metric labels are restricted to a closed allowlist
defined inside the kernel. Forbidden keys (`query`, `prompt`, `body`,
`skill_id`, `resource_path`, `request_id`, `trace_id`, `session_id`,
`user_id`, `agent_id`, `token`, `authorization` and any raw header value)
are redacted or dropped before they reach an exporter.

The exact sets are enforced by:

- `tests/telemetry/cardinality-contract.test.ts` — only allowlisted labels
  generate metric series.
- `tests/telemetry/privacy-contract.test.ts` — bearer / JWT / PEM /
  password / token / query / body / resource bytes are redacted.
- `tests/telemetry/noop.test.ts` — no helper throws without a provider.

## Failure model

- Exporter down: kernel keeps the no-op handle and records the failure as a
  bounded internal span event (`telemetry.export.failure`).
- Collector returns 5xx: same path; HTTP payload and Hub response are
  untouched.
- Sample ratio out of range: clamped to nearest valid bound; default
  remains 1.0 for local.
- `shutdown()` is bounded; it never blocks application stop indefinitely.

## Lifecycle

1. The kernel returns a `HubTelemetryHandle` synchronously; helpers such as
   `withSpan` and `recordMetric` work with or without a provider.
2. When enabled and configured, the Node SDK is started inside the
   `@portable-agent-asset-hub/telemetry/node` subpath; the root export
   stays free of Node-specific packages.
3. `shutdown()` flushes and stops the SDK in bounded time and is idempotent.

## Reserved headers (handled by integration seams)

```text
authorization
traceparent
tracestate
baggage
x-agent-runtime
x-agent-client-version
x-request-id
```

These headers must not be writable from model-controlled input. Integration
seams for REST and MCP enforce this in their respective slices; the kernel
exposes the helpers, not the enforcement.

## Environment variables

The launcher reads a Hub alias for the telemetry level
(`AGENT_MEMORY_TELEMETRY_LEVEL`) and the canonical OTel env names for
everything else. Either surface works; the Hub alias wins when both are
set.

| Variable                          | Default                       | Purpose                                                  |
|-----------------------------------|-------------------------------|----------------------------------------------------------|
| `AGENT_MEMORY_TELEMETRY_LEVEL`    | `off`                         | Kernel level: `off`, `basic`, `standard`, `debug`        |
| `TELEMETRY_LEVEL`                 | inherits the Hub alias         | OpenTelemetry SDK alias; the Hub alias wins              |
| `TELEMETRY_ENABLED`               | `false`                       | Master switch; when `false` the SDK never starts          |
| `OTEL_EXPORTER_OTLP_ENDPOINT`     | (none)                        | OTLP HTTP/HTTPS endpoint, e.g. `http://127.0.0.1:4318`    |
| `OTEL_SERVICE_NAME`               | `portable-agent-asset-hub`    | Resource service name on every span                      |
| `TELEMETRY_SAMPLE_RATIO`          | `1.0`                         | Head sampling ratio; out-of-range is clamped             |
| `TELEMETRY_EXPORT_INTERVAL_MS`    | `30000` (kernel minimum 1000) | Periodic reader interval; below 1000 is clamped         |

`OTEL_EXPORTER_OTLP_HEADERS` is intentionally not enumerated here. It is
the operator's responsibility to provide auth headers (and any other
secrets) through the process environment, a secret manager, or a
sidecar — never through documentation or version control.

## Full local Docker and Grafana stack (verified)

`observability/compose.yaml` runs `hub-rest`, the OpenTelemetry Collector,
Tempo, Prometheus and Grafana on one internal Compose network. The Hub exports
OTLP to `otel-collector:4318`; the Collector exports traces to `tempo:4317`
and metrics on `:9464`; Grafana uses `http://tempo:3200` and
`http://prometheus:9090`. Only authenticated REST on host loopback `39421`
and Grafana on host loopback `3000` are published by default.

The verified gate is `pnpm docker:gate`. Its runtime smoke uses dynamic host
ports and an isolated Compose project, so it can run beside the persistent
development stack. It builds both ARM64
Hub images, drives real requests, requires non-empty PromQL and Tempo results,
queries both Grafana datasource paths and provisioned dashboards, recreates
`hub-rest` to prove semantic SQLite persistence, opens two independent MCP
stdio sessions, stops the Collector to prove REST fail-open, verifies recovery,
and removes its isolated Compose project and volumes in `finally`. Evidence is
written to `artifacts/docker-stack-smoke.json`.

See `observability/README.md` for startup, bearer-token handling, multi-agent
MCP commands, debug-only port publication and destructive teardown guidance.

## Cloud adoption (decision deferred)

Grafana Cloud is not enabled by default. The collector's
`debug` exporter surfaces every payload to stderr so an operator can
preview what the cloud adapter would receive, but no `otlphttp` exporter
points off-box. Adopting Grafana Cloud requires a documented change in
`observability/otel-collector.yaml` plus a rotation of the
`OTEL_EXPORTER_OTLP_HEADERS` secret.

## Rollback

Disable telemetry:

```sh
TELEMETRY_ENABLED=false pnpm hub:start:temp
```

No SQLite migration, no schema change and no canonical store impact. The
application returns to its pre-telemetry behavior. The kernel returns a
no-op handle from `startTelemetry` when disabled; `withSpan`,
`recordMetric`, `addEvent` and the rest of the helpers are no-ops against
that handle.

## Troubleshooting

- **Collector down.** The kernel records a bounded internal span event
  (`telemetry.export.failure`) and keeps responding. The Hub's HTTP
  response and SQLite writes are unaffected. The launcher logs the
  diagnostic on stderr but does not exit.
- **`OTEL_EXPORTER_OTLP_ENDPOINT` not set.** The kernel returns a no-op
  handle and the launcher logs `telemetry: endpoint: telemetry endpoint
  missing; telemetry disabled` on stderr.
- **Exporter times out.** The kernel swallows the exception inside the
  per-request `finally` and the response still ships. The exception is
  recorded as a span event on the active span.
- **High cardinality.** The allowlist is the only source of truth. A
  regression that adds a new label would be caught by
  `tests/telemetry/cardinality-contract.test.ts`.

## Test infrastructure notes

`vitest.config.ts` declares `testTimeout: 20_000` and `hookTimeout: 30_000`.
The longer bound is **defensive, not permissive**: every test assertion is
strict (status codes, attribute keys, label allowlists, scrubbed values);
no assertion relies on the timer. The bound exists because the in-memory
telemetry install path (`installInMemoryTelemetry` + `AsyncHooksContextManager`
+ `MeterProvider` + `PeriodicExportingMetricReader` + first forced flush)
takes longer than the previous 5 s default. The smoke tests that spawn the
real launcher binary (`tests/rest/launcher-smoke.test.ts`,
`tests/rest/{catalog,memory,skill}-control-plane.test.ts`,
`tests/mcp/stdio-*-smoke.test.ts`) load the kernel imports and therefore
also need the longer ceiling. No assertion is weakened by this.