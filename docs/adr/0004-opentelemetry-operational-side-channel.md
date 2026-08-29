# ADR 0004: OpenTelemetry as operational side channel

Status: ACCEPTED — kernel, REST/MCP seams and local Docker/Grafana stack
implemented under TDD.
Date: 2026-08-26.
Supersedes: none.
Related: `.hermes/plans/2026-08-25_235111-opentelemetry-grafana-implementation-orchestration.md`.

Current implementation note: the original decision was delivered beyond its
neutral-kernel slice. REST and MCP now propagate W3C context, the Compose stack
ships Collector/Prometheus/Tempo/Grafana, and `pnpm observability:gate` plus
`pnpm docker:gate` enforce privacy, cardinality, fail-open and runtime behavior.
The decision and non-goals below remain authoritative; slice-specific wording
in Consequences records the state when the ADR was first accepted.

## Context

The Portable Agent Asset Hub exposes a REST/MCP surface backed by SQLite
evidence (audit, events, retrieval_events). Operators need bounded, opt-in
visibility into latency, error mix and retrieval counts without rewriting
OpenAPI, contaminating stdout with structured logs or duplicating evidence
into the canonical store. OpenTelemetry is the existing neutral side channel
for these answers. Adoption must be:

- OFF / no-op by default (zero exporter traffic, zero new dependencies in core).
- Strictly fail-open: a down collector, malformed env or exporter crash never
  changes status, payload or transaction outcome.
- Bounded cardinality: only allowlisted attribute keys and metric labels reach
  exporters. No query, body, header value, request id, trace id, session id,
  actor id, skill id or path may appear as a metric label.
- No raw text: skill body, resource bytes, prompts, bearer/JWT/PEM/token
  payloads, raw query strings and OTLP headers never leave the process via
  telemetry.
- Audit vs telemetry separation: `audit`, `events` and `retrieval_events`
  remain the canonical durable evidence; OpenTelemetry is disposable.

## Decision

1. **Side channel, not source of truth.** Telemetry is observable, replayable
   and discardable. The canonical store is SQLite; audit and retrieval
   evidence are not replaced, forked or mirrored.
2. **No-op kernel by default.** A neutral `@portable-agent-asset-hub/telemetry`
   package owns configuration, attribute/label allowlists, redaction helpers,
   span/metric helpers and a bounded shutdown. When `TELEMETRY_ENABLED=false`,
   `TELEMETRY_LEVEL=off`, env is invalid, the endpoint is malformed or the
   provider cannot start, helpers degrade to no-op without throwing.
3. **Configuration surface (off / basic / standard / debug).** Strict parse:
   unknown level / disabled / unset → off. Invalid sample ratio or endpoint
   disables telemetry and surfaces a sanitized diagnostic in the process
   diagnostics channel; never throws.
4. **Allowlisted telemetry surface.** Span attributes and metric labels are
   restricted to a closed set declared in the kernel. Forbidden keys and
   values are redacted or dropped before reaching any exporter. Cardinality
   tests are colocated with the kernel.
5. **Core stays free of OpenTelemetry.** Core does not import any
   `@opentelemetry/*` package. The telemetry kernel lives in
   `packages/telemetry/`; `rest`, `storage-sqlite` and `mcp` integrate later
   through that kernel.
6. **Node SDK isolation.** The Node SDK, OTLP exporters, batch processors and
   resource detectors live under `@portable-agent-asset-hub/telemetry/node`.
   The root export remains free of Node-specific dependencies so the kernel
   can be imported from edge runtimes in future slices without dragging the
   SDK.
7. **Testing subpath.** `@portable-agent-asset-hub/telemetry/testing`
   re-exports the public-stable `InMemorySpanExporter` and
   `InMemoryMetricExporter` so tests can run without network. No production
   code path imports from `/testing`.
8. **Frozen lockfile.** OTel dependency versions are pinned exactly and
   verified by `pnpm install --frozen-lockfile`. Floating ranges are not
   accepted for operational infrastructure.
9. **Local Grafana first.** Cloud adoption, retention policies, pseudonymous
   multi-tenant correlation and DEBUG-level raw payloads are explicit
   unresolved questions (plan §9) and are not enabled in this slice.
10. **Process-bound correlation.** Reserved headers (`authorization`,
    `traceparent`, `tracestate`, `baggage`, `x-agent-runtime`,
    `x-agent-client-version`, `x-request-id`) are stripped from any
    model-controlled input and re-injected from process env / W3C context.
    Propagation is handled by the kernel and never by model arguments.

## Consequences

- Core code paths remain unchanged in this slice; only `packages/telemetry`,
  the workspace shared files (`tsconfig.json`, `vitest.config.ts`, root
  `package.json`) and the test directory `tests/telemetry/` receive writes.
- `rest`, `storage-sqlite`, `mcp`, `materializers` and pre-existing tests
  stay untouched in this slice; they integrate in later slices.
- The 3 PRE-EXISTING test failures (0020 relation proposal migration not
  yet propagated through schema tests) remain untouched; the kernel is
  independent of that migration.
- Adding telemetry later in REST/MCP/storage requires zero changes to the
  kernel contracts declared here; only seam wiring.

## Non-goals

- Loki / log export in MVP.
- Telemetry table in SQLite.
- Public REST surface for telemetry.
- Grafana dashboards in MVP (delivered in Tarea 8 by separate subagent).
- Cloud OTLP smoke (no credentials available).
- Exporter implementation beyond OTLP HTTP/protobuf for trace and metrics.