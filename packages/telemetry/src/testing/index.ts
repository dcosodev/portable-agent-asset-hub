/**
 * Testing subpath. Re-exports the stable in-memory exporters and readers
 * from the OpenTelemetry SDKs so tests can collect spans / metrics without
 * touching the network. The kernel itself never imports from this subpath;
 * only test fixtures do.
 *
 * Names are pinned to the public-stable API exposed by:
 * - `@opentelemetry/sdk-trace-base@2.10.0` → `InMemorySpanExporter`
 * - `@opentelemetry/sdk-metrics@2.10.0`  → `InMemoryMetricExporter`
 *
 * When the upstream package is replaced (or renamed) the failure is loud
 * here and at the test imports, never silent at runtime.
 */

export { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
export { InMemoryMetricExporter } from '@opentelemetry/sdk-metrics';
export { installInMemoryTelemetry, resetInMemoryTelemetry } from './in-memory.js';
export type { InMemoryTelemetry } from './in-memory.js';

export type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
export type { ResourceMetrics, ScopeMetrics } from '@opentelemetry/sdk-metrics';
