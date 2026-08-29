/**
 * Strict parser for the telemetry kernel configuration. The parser is the
 * source of truth for "is the kernel on?" — it never throws and it never
 * returns ambiguous states. When env is missing, malformed, disabled or
 * unparseable, the kernel falls back to OFF with a sanitized diagnostic.
 */

import {
  type HubTelemetryHandle,
  type TelemetryConfig,
  type TelemetryConfigInput,
  type TelemetryDiagnostic,
  type TelemetryLevel,
} from './types.js';

const KNOWN_LEVELS: readonly TelemetryLevel[] = ['off', 'basic', 'standard', 'debug'];

const DEFAULT_SERVICE_NAME = 'portable-agent-asset-hub';
const DEFAULT_SAMPLE_RATIO = 1.0;
const DEFAULT_EXPORT_INTERVAL_MS = 30_000;
const MIN_EXPORT_INTERVAL_MS = 1_000;
const MAX_EXPORT_INTERVAL_MS = 5 * 60_000;

function normalizeLevel(raw: string | undefined): TelemetryLevel {
  if (!raw) return 'off';
  const trimmed = raw.trim().toLowerCase();
  if ((KNOWN_LEVELS as readonly string[]).includes(trimmed)) {
    return trimmed as TelemetryLevel;
  }
  return 'off';
}

function isEnabled(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

/**
 * Validate an OTLP HTTP endpoint. We accept only `http` and `https` URLs that
 * parse cleanly under `URL`; everything else is rejected and the kernel
 * downgrades to OFF. The raw URL value is NEVER echoed in diagnostics.
 */
function parseEndpoint(
  raw: string | undefined,
  diagnostics: TelemetryDiagnostic[],
): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    diagnostics.push({
      category: 'endpoint',
      message: 'telemetry endpoint malformed; telemetry disabled',
    });
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    diagnostics.push({
      category: 'endpoint',
      message: 'telemetry endpoint must use http or https; telemetry disabled',
    });
    return undefined;
  }
  return parsed.toString().replace(/\/$/, '');
}

/**
 * Clamp the sample ratio to [0, 1]. Out-of-range numeric input is clamped
 * silently — the test contract documents this. Non-numeric input drops to
 * the kernel default.
 */
function parseSampleRatio(
  raw: string | undefined,
  diagnostics: TelemetryDiagnostic[],
): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_SAMPLE_RATIO;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    diagnostics.push({
      category: 'sample_ratio',
      message: 'telemetry sample ratio unparseable; defaulted to 1.0',
    });
    return DEFAULT_SAMPLE_RATIO;
  }
  if (n < 0) {
    diagnostics.push({
      category: 'sample_ratio',
      message: 'telemetry sample ratio below 0 clamped to 0',
    });
    return 0;
  }
  if (n > 1) {
    diagnostics.push({
      category: 'sample_ratio',
      message: 'telemetry sample ratio above 1 clamped to 1',
    });
    return 1;
  }
  return n;
}

function parseExportInterval(
  raw: string | undefined,
  diagnostics: TelemetryDiagnostic[],
): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_EXPORT_INTERVAL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    diagnostics.push({
      category: 'export_interval',
      message: 'telemetry export interval unparseable; defaulted',
    });
    return DEFAULT_EXPORT_INTERVAL_MS;
  }
  if (n < MIN_EXPORT_INTERVAL_MS) {
    diagnostics.push({
      category: 'export_interval',
      message: 'telemetry export interval below minimum; clamped',
    });
    return MIN_EXPORT_INTERVAL_MS;
  }
  if (n > MAX_EXPORT_INTERVAL_MS) {
    diagnostics.push({
      category: 'export_interval',
      message: 'telemetry export interval above maximum; clamped',
    });
    return MAX_EXPORT_INTERVAL_MS;
  }
  return Math.floor(n);
}

/**
 * Pure parser. Always returns a TelemetryConfig; never throws. Diagnostics
 * are sanitized: they describe the failure category without echoing raw
 * values back to logs.
 */
export function parseTelemetryConfig(
  env: TelemetryConfigInput,
): TelemetryConfig {
  const diagnostics: TelemetryDiagnostic[] = [];
  const enabled = isEnabled(env.TELEMETRY_ENABLED);
  const requestedLevel = normalizeLevel(env.TELEMETRY_LEVEL);
  if (enabled && requestedLevel === 'off' && env.TELEMETRY_LEVEL) {
    diagnostics.push({
      category: 'level',
      message: 'telemetry level unrecognized; telemetry disabled',
    });
  }
  const endpoint = enabled ? parseEndpoint(env.OTEL_EXPORTER_OTLP_ENDPOINT, diagnostics) : undefined;
  const endpointWasProvided = Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim());
  const invalidEndpoint = enabled && endpointWasProvided && endpoint === undefined;
  // Disabled, invalid level, or an explicitly malformed endpoint collapses
  // to OFF. A missing endpoint is allowed at parse time so callers can
  // inspect a valid opt-in config before choosing an exporter.
  const level: TelemetryLevel = enabled && !invalidEndpoint ? requestedLevel : 'off';
  const sampleRatio = parseSampleRatio(env.TELEMETRY_SAMPLE_RATIO, diagnostics);
  const exportIntervalMs = parseExportInterval(
    env.TELEMETRY_EXPORT_INTERVAL_MS,
    diagnostics,
  );
  const serviceName = (env.OTEL_SERVICE_NAME ?? '').trim() || DEFAULT_SERVICE_NAME;
  return {
    level,
    enabled: enabled && level !== 'off',
    endpoint,
    serviceName,
    sampleRatio,
    exportIntervalMs,
    diagnostics,
  };
}

export function createNoopTelemetryHandle(level: TelemetryLevel): HubTelemetryHandle {
  return {
    level,
    shutdown: async () => undefined,
  };
}

/**
 * Start the telemetry kernel. Returns a HubTelemetryHandle that is ALWAYS
 * safe to call. When the parser reports an OFF result (no env, disabled, bad
 * endpoint, unparseable level) the handle is a no-op; when the parser
 * succeeds the handle is wired to the Node SDK returned by the subpath
 * `@portable-agent-asset-hub/telemetry/node`.
 *
 * This function is the single entry point used by integration seams.
 * It never throws and never blocks longer than the bounded shutdown of the
 * underlying SDK.
 */
export async function startTelemetry(
  env: TelemetryConfigInput,
  diagnostics: TelemetryDiagnostic[] = [],
): Promise<HubTelemetryHandle> {
  const config = parseTelemetryConfig(env);
  for (const d of config.diagnostics) diagnostics.push(d);
  if (!config.enabled || !config.endpoint) {
    return createNoopTelemetryHandle('off');
  }
  // Lazy import the Node subpath: the root package stays free of
  // Node-specific dependencies. When the Node SDK fails to load (e.g.
  // bundling for the edge) we degrade to a no-op handle.
  try {
    const mod = await import('./node/index.js');
    return await mod.startNodeTelemetry(config, diagnostics);
  } catch {
    diagnostics.push({
      category: 'provider',
      message: 'telemetry Node SDK unavailable; telemetry disabled',
    });
    return createNoopTelemetryHandle('off');
  }
}