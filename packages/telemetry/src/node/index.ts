/**
 * Node SDK subpath. Owns the OTel Node SDK, OTLP HTTP exporters for both
 * traces and metrics, the batch span processor, the periodic metric reader
 * and the bounded shutdown.
 *
 * The root package (`@portable-agent-asset-hub/telemetry`) MUST NOT depend
 * on this subpath. Integration seams import from
 * `@portable-agent-asset-hub/telemetry/node` only when they actually need a
 * live SDK; the root handle returned by `startTelemetry` is good enough for
 * the no-op / fail-open case.
 *
 * Shutdown timing is bounded: any exporter that hangs longer than the
 * configured deadline is abandoned. The application process is never held
 * hostage by a stalled collector.
 */

import { diag, DiagConsoleLogger, DiagLogLevel, propagation } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  type ReadableSpan,
  type Span,
} from '@opentelemetry/sdk-trace-base';
import {
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  resourceFromAttributes,
  type Resource,
} from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

import type {
  HubTelemetryHandle,
  TelemetryConfig,
  TelemetryDiagnostic,
} from '../types.js';

const SHUTDOWN_DEADLINE_MS = 2_000;

function buildResource(config: TelemetryConfig): Resource {
  return resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: '0.0.0',
  });
}

function buildTraceExporter(endpoint: string): OTLPTraceExporter {
  return new OTLPTraceExporter({
    url: `${endpoint}/v1/traces`,
  });
}

function buildMetricExporter(endpoint: string): OTLPMetricExporter {
  return new OTLPMetricExporter({
    url: `${endpoint}/v1/metrics`,
  });
}

/**
 * Internal handle carrying a live Node SDK. The public surface is the same
 * `HubTelemetryHandle`; `shutdown()` is bounded by `SHUTDOWN_DEADLINE_MS` and
 * idempotent.
 */
class NodeTelemetryHandle implements HubTelemetryHandle {
  readonly level: HubTelemetryHandle['level'];
  private readonly sdk: NodeSDK;
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    level: HubTelemetryHandle['level'],
    sdk: NodeSDK,
  ) {
    this.level = level;
    this.sdk = sdk;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.runBoundedShutdown();
    return this.shutdownPromise;
  }

  private async runBoundedShutdown(): Promise<void> {
    const deadline = new Promise<void>((resolve) => {
      setTimeout(resolve, SHUTDOWN_DEADLINE_MS).unref();
    });
    const sdkShutdown = (async () => {
      try {
        await this.sdk.shutdown();
      } catch {
        /* swallow */
      }
    })();
    await Promise.race([
      sdkShutdown,
      deadline,
    ]);
  }
}

/**
 * Start a Node SDK with OTLP HTTP trace + metric exporters. The handle
 * returned is bounded; callers should still wrap shutdown in their own
 * deadline if the process is being terminated by SIGKILL.
 *
 * Failures inside `start()` never throw: we always return either a real
 * handle or a no-op handle at level `off`.
 */
export async function startNodeTelemetry(
  config: TelemetryConfig,
  diagnostics: TelemetryDiagnostic[],
): Promise<HubTelemetryHandle> {
  if (!config.endpoint) {
    diagnostics.push({
      category: 'endpoint',
      message: 'telemetry endpoint missing; telemetry disabled',
    });
    return { level: 'off', shutdown: async () => undefined };
  }
  const resource = buildResource(config);
  const traceExporter = buildTraceExporter(config.endpoint);
  const metricExporter = buildMetricExporter(config.endpoint);
  const spanProcessor = new BatchSpanProcessor(traceExporter, {
    maxQueueSize: 1024,
    maxExportBatchSize: 256,
    scheduledDelayMillis: config.exportIntervalMs,
    exportTimeoutMillis: Math.min(config.exportIntervalMs, SHUTDOWN_DEADLINE_MS),
  });
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: config.exportIntervalMs,
    exportTimeoutMillis: Math.min(config.exportIntervalMs, SHUTDOWN_DEADLINE_MS),
  });

  // Surface exporter failures through the OTel diag channel so the
  // bounded `telemetry.export.failure` event can be attached downstream.
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

  const sdk = new NodeSDK({
    resource,
    spanProcessors: [spanProcessor],
    metricReader,
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(config.sampleRatio),
    }),
    instrumentations: [],
  });

  try {
    // W3C trace context propagation is opt-in. We register it before
    // `sdk.start()` so the inbound carrier is parsed for `traceparent`
    // /`tracestate` from the very first request, and outbound HTTP
    // clients (REST, MCP) can inject the active context. NodeSDK also
    // registers a propagator internally; we detect that by checking
    // whether the global propagator is already set via the private
    // helper exposed by `@opentelemetry/api`.
    if (!(propagation as unknown as { _getGlobalPropagator?: () => unknown })._getGlobalPropagator?.()) {
      propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    }
    sdk.start();
  } catch {
    diagnostics.push({
      category: 'provider',
      message: 'telemetry SDK failed to start; telemetry disabled',
    });
    return { level: 'off', shutdown: async () => undefined };
  }

  return new NodeTelemetryHandle(config.level, sdk);
}

// Touch the imports so `verbatimModuleSyntax` does not eliminate them when
// only the types are used elsewhere. None of these re-exports are part of
// the public surface: they exist to keep the SDK exports type-correct.
export type { ReadableSpan, Span };