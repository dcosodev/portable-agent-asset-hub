/**
 * Public entry point of the telemetry kernel.
 *
 * Re-exports the stable surface from the internal modules. Anything exported
 * here is part of the kernel contract; anything that lives in a sibling module
 * but is NOT re-exported here is internal.
 *
 * The root entry point deliberately does NOT touch OTel Node SDK packages:
 * callers that need the live SDK import from `@portable-agent-asset-hub/telemetry/node`.
 */

// Types
export type {
  HubTelemetryHandle,
  TelemetryConfig,
  TelemetryConfigInput,
  TelemetryDiagnostic,
  TelemetryLevel,
} from './types.js';
export type { Span } from '@opentelemetry/api';

// Attributes / cardinality contract
export {
  ALLOWED_METRIC_LABEL_KEYS,
  ALLOWED_METRIC_NAMES,
  ALLOWED_SPAN_ATTRIBUTE_KEYS,
  isAllowedMetricLabelKey,
  isAllowedMetricName,
  isAllowedSpanAttributeKey,
} from './attributes.js';

// Redaction / privacy contract
export {
  redactAttributeValue,
  scrubAttributes,
  scrubMetricLabels,
  scrubSpanName,
} from './redaction.js';

// Config parser and no-op handle
export {
  createNoopTelemetryHandle,
  parseTelemetryConfig,
  startTelemetry,
} from './config.js';

// kernel
export {
  activeContext,
  extractTraceparentContext,
  injectTraceparentIntoHeaders,
  addEvent,
  captureActiveSpan,
  countMetric,
  getMeter,
  getTracer,
  histogramMetric,
  recordMetric,
  setSpanAttributes,
  setSpanStatus,
  withSpan,
  withSpanInContext,
  withSpanSync,
} from './api.js';
