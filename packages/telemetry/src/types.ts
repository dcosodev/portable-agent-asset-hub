/**
 * Public types of the telemetry kernel. Kept in a dedicated module so the
 * root export and the Node subpath can share the same surface without
 * importing each other.
 */

export type TelemetryLevel = 'off' | 'basic' | 'standard' | 'debug';

export interface TelemetryDiagnostic {
  readonly category: 'level' | 'endpoint' | 'sample_ratio' | 'export_interval' | 'provider';
  readonly message: string;
}

export interface TelemetryConfig {
  readonly level: TelemetryLevel;
  readonly enabled: boolean;
  readonly endpoint?: string;
  readonly serviceName: string;
  readonly sampleRatio: number;
  readonly exportIntervalMs: number;
  readonly diagnostics: readonly TelemetryDiagnostic[];
}

export interface HubTelemetryHandle {
  readonly level: TelemetryLevel;
  shutdown(): Promise<void>;
}

/**
 * Input shape for `parseTelemetryConfig`. The `undefined` slots come straight
 * from `process.env` reads; they are normalized inside the parser so callers
 * can pass raw env objects.
 */
export interface TelemetryConfigInput {
  TELEMETRY_ENABLED?: string | undefined;
  TELEMETRY_LEVEL?: string | undefined;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string | undefined;
  OTEL_SERVICE_NAME?: string | undefined;
  TELEMETRY_SAMPLE_RATIO?: string | undefined;
  TELEMETRY_EXPORT_INTERVAL_MS?: string | undefined;
}