import { describe, expect, it } from 'vitest';
import {
  parseTelemetryConfig,
  startTelemetry,
  type TelemetryConfigInput,
} from '@portable-agent-asset-hub/telemetry';

const baseEnv = (over: Record<string, string | undefined> = {}): TelemetryConfigInput => ({
  TELEMETRY_ENABLED: undefined,
  TELEMETRY_LEVEL: undefined,
  OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
  OTEL_SERVICE_NAME: undefined,
  TELEMETRY_SAMPLE_RATIO: undefined,
  TELEMETRY_EXPORT_INTERVAL_MS: undefined,
  ...over,
});

describe('telemetry config parser', () => {
  it('defaults to OFF when TELEMETRY_ENABLED is missing or not "true"', () => {
    for (const v of [undefined, '', 'false', '0', 'no', 'off']) {
      const r = parseTelemetryConfig(baseEnv({ TELEMETRY_ENABLED: v }));
      expect(r.level).toBe('off');
      expect(r.enabled).toBe(false);
    }
  });

  it('defaults to OFF when TELEMETRY_LEVEL is missing', () => {
    expect(parseTelemetryConfig(baseEnv()).level).toBe('off');
  });

  it.each(['basic', 'standard', 'debug'] as const)('accepts %s as a level', (level) => {
    const r = parseTelemetryConfig(baseEnv({ TELEMETRY_ENABLED: 'true', TELEMETRY_LEVEL: level }));
    expect(r.level).toBe(level);
    expect(r.enabled).toBe(true);
  });

  it('rejects an unknown level as OFF with a sanitized diagnostic', () => {
    const r = parseTelemetryConfig(baseEnv({ TELEMETRY_ENABLED: 'true', TELEMETRY_LEVEL: 'ludicrous' }));
    expect(r.level).toBe('off');
    expect(r.enabled).toBe(false);
    expect(r.diagnostics.some((d) => /level/i.test(d.message))).toBe(true);
    for (const d of r.diagnostics) {
      // diagnostics MUST NOT echo the raw value verbatim — they only describe the
      // failure category. (sanitized: never contains raw header/bearer/etc.)
      expect(d.message).not.toMatch(/[A-Za-z0-9_-]{24,}/);
    }
  });

  it('rejects a malformed endpoint and downgrades to OFF with a sanitized diagnostic', () => {
    const r = parseTelemetryConfig(baseEnv({
      TELEMETRY_ENABLED: 'true',
      TELEMETRY_LEVEL: 'basic',
      OTEL_EXPORTER_OTLP_ENDPOINT: '::::',
    }));
    expect(r.level).toBe('off');
    expect(r.diagnostics.some((d) => /endpoint/i.test(d.message))).toBe(true);
  });

  it('accepts a valid http endpoint', () => {
    const r = parseTelemetryConfig(baseEnv({
      TELEMETRY_ENABLED: 'true',
      TELEMETRY_LEVEL: 'basic',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
    }));
    expect(r.level).toBe('basic');
    expect(r.endpoint).toBe('http://127.0.0.1:4318');
  });

  it('clamps sample ratio below 0 to 0 and above 1 to 1', () => {
    const lo = parseTelemetryConfig(baseEnv({ TELEMETRY_ENABLED: 'true', TELEMETRY_SAMPLE_RATIO: '-1' }));
    expect(lo.sampleRatio).toBe(0);
    const hi = parseTelemetryConfig(baseEnv({ TELEMETRY_ENABLED: 'true', TELEMETRY_SAMPLE_RATIO: '2.5' }));
    expect(hi.sampleRatio).toBe(1);
  });

  it('accepts sample ratio inside [0,1]', () => {
    const r = parseTelemetryConfig(baseEnv({ TELEMETRY_ENABLED: 'true', TELEMETRY_SAMPLE_RATIO: '0.25' }));
    expect(r.sampleRatio).toBe(0.25);
  });

  it('keeps the kernel OFF when TELEMETRY_ENABLED=false even with a valid level', () => {
    const r = parseTelemetryConfig(baseEnv({ TELEMETRY_ENABLED: 'false', TELEMETRY_LEVEL: 'standard' }));
    expect(r.level).toBe('off');
    expect(r.enabled).toBe(false);
  });

  it('startTelemetry returns a no-op handle for invalid config without throwing', async () => {
    const handle = await startTelemetry(baseEnv({
      TELEMETRY_ENABLED: 'true',
      TELEMETRY_LEVEL: 'unknown-level',
    }), []);
    expect(handle.level).toBe('off');
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  it('startTelemetry returns a no-op handle when TELEMETRY_ENABLED is missing', async () => {
    const handle = await startTelemetry(baseEnv(), []);
    expect(handle.level).toBe('off');
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });
});