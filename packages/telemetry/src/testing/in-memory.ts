import { context, metrics, propagation, trace } from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import type { HubTelemetryHandle, TelemetryLevel } from '../types.js';

export type InMemoryTelemetry = {
  spanExporter: InMemorySpanExporter;
  metricExporter: InMemoryMetricExporter;
  handle: HubTelemetryHandle;
  forceFlush(): Promise<void>;
};

let active: InMemoryTelemetry | undefined;

export function installInMemoryTelemetry(level: TelemetryLevel = 'standard'): InMemoryTelemetry {
  const cm = new AsyncHooksContextManager();
  cm.enable();
  (context as unknown as { setGlobalContextManager?: (m: unknown) => boolean }).setGlobalContextManager?.(cm);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.disable();
  metrics.disable();

  const spanExporter = new InMemorySpanExporter();
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });
  trace.setGlobalTracerProvider(tracerProvider);

  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 60_000,
  });
  const meterProvider = new MeterProvider({ readers: [metricReader] });
  metrics.setGlobalMeterProvider(meterProvider);

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= Promise.allSettled([
      tracerProvider.shutdown(),
      meterProvider.shutdown(),
    ]).then(() => undefined);
    return shutdownPromise;
  };

  const installed: InMemoryTelemetry = {
    spanExporter,
    metricExporter,
    handle: Object.freeze({ level, shutdown }),
    async forceFlush(): Promise<void> {
      await Promise.all([tracerProvider.forceFlush(), meterProvider.forceFlush()]);
    },
  };
  active = installed;
  return installed;
}

export async function resetInMemoryTelemetry(): Promise<void> {
  const installed = active;
  active = undefined;
  trace.disable();
  metrics.disable();
  if (installed) await installed.handle.shutdown();
}
