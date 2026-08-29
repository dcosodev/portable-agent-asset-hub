/**
 * Span / metric helpers. The kernel exports a neutral, no-op-friendly API:
 *
 * - `withSpan` / `withSpanSync` invoke a block while a logical span exists.
 *   In a no-op handle the block runs but no exporter is touched.
 * - `addEvent` attaches a bounded, scrubbed event to the active span.
 * - `recordMetric` / `countMetric` / `histogramMetric` translate user calls
 *   into OTel instruments; when no provider exists they become no-ops.
 *
 * Helpers NEVER throw. The whole point of this module is to give callers a
 * safe surface so they can wrap operational paths without leaking errors
 * from telemetry itself.
 */

import {
  context,
  defaultTextMapGetter,
  defaultTextMapSetter,
  metrics,
  propagation,
  trace,
  SpanStatusCode,
  type Span,
  type Context,
} from '@opentelemetry/api';
import type { HubTelemetryHandle, TelemetryLevel } from './types.js';
import { isAllowedMetricName } from './attributes.js';
import { scrubAttributes, scrubMetricLabels, scrubSpanName } from './redaction.js';

export type { HubTelemetryHandle, TelemetryLevel };
export type { Span } from '@opentelemetry/api';

function safeSpanName(raw: string): string {
  return scrubSpanName(raw);
}

/**
 * Resolve a tracer / meter from the global OTel API. When no provider is
 * registered the helpers fall back to a no-op tracer / meter, which never
 * throws and never allocates exporters.
 */
function tracerFor(): ReturnType<typeof trace.getTracer> {
  return trace.getTracer('@portable-agent-asset-hub/telemetry');
}

function meterFor(): ReturnType<typeof metrics.getMeter> {
  return metrics.getMeter('@portable-agent-asset-hub/telemetry');
}

/**
 * Run `block` while a logical span exists. The span name is scrubbed and
 * attributes are restricted to the allowlist before any exporter is touched.
 * Returns whatever `block` returns. NEVER throws — but if the block throws,
 * the error propagates to the caller (helpers do not swallow application
 * errors).
 */
export async function withSpan<T>(
  handle: HubTelemetryHandle,
  name: string,
  attributes: Record<string, unknown> | undefined,
  block: (span: Span | undefined) => Promise<T>,
): Promise<T> {
  if (handle.level === 'off') return await block(undefined);
  return await withSpanInternal(handle, name, attributes, undefined, block);
}

export async function withSpanInContext<T>(
  handle: HubTelemetryHandle,
  name: string,
  attributes: Record<string, unknown> | undefined,
  parent: Context | undefined,
  block: (span: Span | undefined) => Promise<T>,
): Promise<T> {
  if (handle.level === 'off') return await block(undefined);
  return await withSpanInternal(handle, name, attributes, parent, block);
}

async function withSpanInternal<T>(
  handle: HubTelemetryHandle,
  name: string,
  attributes: Record<string, unknown> | undefined,
  parent: Context | undefined,
  block: (span: Span | undefined) => Promise<T>,
): Promise<T> {
  const cleanedName = safeSpanName(name);
  const cleanedAttrs = scrubAttributes(attributes);

  let blockSpan: Span | undefined;
  const runBlock = async (span: Span | undefined): Promise<T> => {
    try {
      return await block(span);
    } catch (err) {
      if (span) {
        try {
          span.setStatus({ code: SpanStatusCode.ERROR });
        } catch {
          /* never throw from telemetry while preserving the business error */
        }
      }
      throw err;
    } finally {
      if (span) {
        try {
          span.end();
        } catch {
          /* never throw from telemetry */
        }
      }
    }
  };

  try {
    const tracer = tracerFor();
    blockSpan = parent
      ? tracer.startSpan(cleanedName, { attributes: cleanedAttrs }, parent)
      : tracer.startSpan(cleanedName, { attributes: cleanedAttrs });
    const activeCtx = trace.setSpan(parent ?? context.active(), blockSpan);
    const result = await context.with(activeCtx, () => runBlock(blockSpan));
    return result;
  } catch {
    return await runBlock(blockSpan ?? undefined);
  }
}

/**
 * Synchronous variant. The block may not be async; it is invoked directly.
 */
export function withSpanSync<T>(
  handle: HubTelemetryHandle,
  name: string,
  attributes: Record<string, unknown> | undefined,
  block: (span: Span | undefined) => T,
): T {
  if (handle.level === 'off') return block(undefined);
  const cleanedName = safeSpanName(name);
  const cleanedAttrs = scrubAttributes(attributes);
  let span: Span;
  try {
    span = tracerFor().startSpan(cleanedName, { attributes: cleanedAttrs });
  } catch {
    return block(undefined);
  }
  try {
    return block(span);
  } catch (err) {
    try {
      span.setStatus({ code: SpanStatusCode.ERROR });
    } catch {
      /* preserve the business error */
    }
    throw err;
  } finally {
    try {
      span.end();
    } catch {
      /* never throw from telemetry */
    }
  }
}

/**
 * Attach a bounded event to the active span, or to a no-op span if no
 * provider is registered. Events NEVER throw.
 */
export function addEvent(
  handle: HubTelemetryHandle,
  name: string,
  attributes: Record<string, unknown> | undefined,
): void {
  if (handle.level === 'off') return;
  try {
    const span = trace.getActiveSpan();
    const cleaned = scrubAttributes(attributes);
    if (span) {
      span.addEvent(name, cleaned);
    }
    // If no active span exists, the event is dropped. The kernel keeps no
    // out-of-span queue by design: telemetry is disposable.
  } catch {
    /* never throw */
  }
}

/**
 * Attach bounded attributes to the supplied span (or to the active span when
 * none is supplied). NEVER throws.
 */
export function setSpanAttributes(
  handle: HubTelemetryHandle,
  attributesOrSpan: Record<string, unknown> | undefined | Span,
  maybeAttributes?: Record<string, unknown> | undefined,
): void {
  if (handle.level === 'off') return;
  try {
    let span: Span | undefined;
    let attrs: Record<string, unknown> | undefined;
    if (attributesOrSpan && typeof (attributesOrSpan as Span).setAttributes === 'function') {
      span = attributesOrSpan as Span;
      attrs = maybeAttributes;
    } else {
      span = trace.getActiveSpan();
      attrs = attributesOrSpan as Record<string, unknown> | undefined;
    }
    if (span) span.setAttributes(scrubAttributes(attrs));
  } catch {
    /* never throw */
  }
}

export function setSpanStatus(
  handle: HubTelemetryHandle,
  status: 'ok' | 'error',
): void {
  if (handle.level === 'off') return;
  try {
    trace.getActiveSpan()?.setStatus({
      code: status === 'ok' ? SpanStatusCode.OK : SpanStatusCode.ERROR,
    });
  } catch {
    /* never throw */
  }
}

/**
 * Internal helper: capture the active span from inside `withSpan`'s block
 * so callers can still write attributes / status even after the OTel
 * context has already been restored. Returns `undefined` if no provider
 * or no active span is registered.
 */
export function captureActiveSpan(handle: HubTelemetryHandle): Span | undefined {
  if (handle.level === 'off') return undefined;
  return trace.getActiveSpan() ?? undefined;
}

/**
 * Increment a counter-style metric. Labels go through `scrubMetricLabels`.
 */
export function recordMetric(
  handle: HubTelemetryHandle,
  name: string,
  value: number,
  labels: Record<string, unknown> | undefined,
): void {
  if (handle.level === 'off') return;
  try {
    if (!isAllowedMetricName(name)) return;
    const cleaned = scrubMetricLabels(labels);
    meterFor().createCounter(name).add(value, cleaned);
  } catch {
    /* swallow */
  }
}

export function countMetric(
  handle: HubTelemetryHandle,
  name: string,
  value: number,
  labels: Record<string, unknown> | undefined,
): void {
  recordMetric(handle, name, value, labels);
}

/**
 * Record a histogram observation. The `unit` argument is informational only;
 * it is intentionally NOT added as a label (would explode cardinality).
 */
export function histogramMetric(
  handle: HubTelemetryHandle,
  name: string,
  value: number,
  _unit: string,
  labels: Record<string, unknown> | undefined,
): void {
  if (handle.level === 'off') return;
  try {
    if (!isAllowedMetricName(name)) return;
    const cleaned = scrubMetricLabels(labels);
    meterFor().createHistogram(name).record(value, cleaned);
  } catch {
    /* swallow */
  }
}

/**
 * Re-exported helpers for advanced callers. The default no-op tracer is
 * used when no provider is registered, which means these calls are
 * inexpensive but never allocate exporters.
 */
export function getTracer(name = '@portable-agent-asset-hub/telemetry') {
  return trace.getTracer(name);
}

export function getMeter(name = '@portable-agent-asset-hub/telemetry') {
  return metrics.getMeter(name);
}

/**
 * Propagate the active context as a carrier object. Used by integration
 * seams (REST, MCP) to attach the W3C `traceparent` to outbound requests.
 * Caller MUST treat the returned context as opaque.
 */
export function activeContext(): Context {
  return context.active();
}

/**
 * Extract a W3C traceparent/tracestate context from a plain HTTP headers
 * record. The kernel never accepts arbitrary headers; only the canonical
 * W3C carriers are inspected. The carrier object is mutated only locally.
 * Returns the resulting active context — caller should pass it to
 * `withSpan`'s downstream code paths via `context.with(...)`.
 */
export function extractTraceparentContext(headers: Readonly<Record<string, string | string[] | undefined>>): Context {
  const carrier: Record<string, string> = {};
  for (const key of ['traceparent', 'tracestate']) {
    const value = headers[key];
    if (typeof value === 'string') carrier[key.toLowerCase()] = value;
  }
  try {
    return propagation.extract(context.active(), carrier, defaultTextMapGetter);
  } catch {
    return context.active();
  }
}

/**
 * Inject the active context as W3C carriers into the supplied headers
 * object. Caller decides whether the headers belong to an outbound HTTP
 * request, an upstream callback, or another carrier. The headers object
 * is mutated in place; entries are lowercased to match OTel convention.
 */
export function injectTraceparentIntoHeaders(headers: Record<string, string>): void {
  try {
    propagation.inject(context.active(), headers, defaultTextMapSetter);
  } catch {
    /* never throw */
  }
}