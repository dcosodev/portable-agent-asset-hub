# `@portable-agent-asset-hub/telemetry`

An opt-in OpenTelemetry side channel: off by default, fail-open when
misconfigured or unreachable, and never a substitute for the durable audit
trail. See [`../../docs/observability.md`](../../docs/observability.md)
and [ADR 0004](../../docs/adr/0004-opentelemetry-operational-side-channel.md)
for the full rationale.

## What lives here

- **`src/index.ts`** — the root entry point. Deliberately does **not**
  import the OTel Node SDK packages, so importing telemetry types doesn't
  drag a live SDK into a process that only wants the noop/testing surface.
- **`src/node/index.ts`** — the real implementation, backed by
  `@opentelemetry/sdk-node` and the OTLP HTTP exporters. Callers that want
  a live SDK import from this subpath explicitly.
- **`api.ts`** — the span/metric API surface (`withSpanInContext`,
  `recordMetric`, `histogramMetric`, etc.) used by `rest` and `mcp`.
- **`attributes.ts`** — the bounded, allowlisted set of attributes a span
  or metric may carry.
- **`redaction.ts`** — strips anything that isn't in that allowlist —
  request bodies, prompts, query text, bearer tokens never leave the
  process through this channel.
- **`config.ts`** / **`types.ts`** — config parsing and the public types
  (`TelemetryConfig`, `HubTelemetryHandle`, `TelemetryLevel`, …).
- **`testing/in-memory.ts`** — an in-memory exporter for tests, so test
  suites can assert on emitted spans without a real Collector.

## Why it's structured this way

`rest` and `mcp` depend on the *root* entry point (types + noop/testing
surface), never on `node/`. That keeps the OTel Node SDK an optional,
lazily-loaded dependency of whichever process actually enables telemetry,
rather than a hard dependency of every consumer of this package.

## Validation

```sh
pnpm observability:lint       # static contract: bounded attributes, no unredacted values
pnpm observability:contract   # privacy, cardinality, fail-open, config and noop behavior
```

## Build

```sh
pnpm --filter @portable-agent-asset-hub/telemetry build
```
