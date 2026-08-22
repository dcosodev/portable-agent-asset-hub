// packages/materializers/src/openclaw/config.ts
//
// OpenClaw plugin configuration. The S9 plan mandates:
//
//   * Capture is disabled by default.
//   * Context injection is disabled by default.
//   * Both options require an explicit capability to enable. The
//     capability is granted by the host (Hermes / CLI / CI) and
//     surfaced through `actor.capabilities`.
//
// The config file lives at `<stateDir>/openclaw.config.json` by
// convention. The plugin reads it at every adapter call so a host
// can rotate the capability between apply runs (the S9 cutover
// passes `openclaw.capture` only for the migration run, never
// afterwards).
//
// Env vars (`PAH_OPENCLAW_CAPTURE`, `PAH_OPENCLAW_CONTEXT_INJECT`)
// are accepted ONLY when the matching capability is present. Without
// the capability the env var is rejected — the S9 surface must
// never silently activate capture because the host happened to
// export the env var.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { HubError } from '@portable-agent-asset-hub/core';

export const OPENCLAW_CONFIG_SCHEMA_VERSION = '1' as const;
export const CAPABILITY_CAPTURE = 'openclaw.capture';
export const CAPABILITY_CONTEXT_INJECTION = 'openclaw.contextInjection';

export interface OpenclawCaptureConfig {
  /** Capture is disabled by default. Requires capability to enable. */
  enabled: boolean;
  /** Optional scope: 'stateDir' (default) or 'all'. */
  scope?: 'stateDir' | 'all';
}

export interface OpenclawContextInjectionConfig {
  /** Context injection is disabled by default. Requires capability. */
  enabled: boolean;
  /** When disabled, the renderer MUST NOT call /v2 /v3 /cos proxy endpoints. */
  scope?: 'renderer' | 'session';
}

export interface OpenclawConfig {
  schemaVersion: typeof OPENCLAW_CONFIG_SCHEMA_VERSION;
  harness: 'openclaw';
  agentId: string;
  stateDir: string;
  capture: OpenclawCaptureConfig;
  contextInjection: OpenclawContextInjectionConfig;
  /** Capability stamps stored at write time for diagnostics. */
  capabilities?: string[];
  /** Renderer version this config was authored against. */
  rendererVersion: string;
}

export interface OpenclawConfigReadOptions {
  capabilities?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

export function defaultOpenclawConfig(agentId: string, stateDir?: string): OpenclawConfig {
  if (!agentId || !/^agt_[A-Za-z0-9._-]+$/u.test(agentId)) {
    throw new HubError('VALIDATION', `invalid agentId: ${agentId}`, 400);
  }
  return Object.freeze({
    schemaVersion: OPENCLAW_CONFIG_SCHEMA_VERSION,
    harness: 'openclaw' as const,
    agentId,
    stateDir: stateDir ?? '',
    capture: Object.freeze({ enabled: false, scope: 'stateDir' as const }),
    contextInjection: Object.freeze({ enabled: false, scope: 'renderer' as const }),
    rendererVersion: '0.1.0',
  });
}

/**
 * Return a new config with the matching context injection capability
 * applied. Pure: the input config is not mutated.
 */
export function withCapability(config: OpenclawConfig, capability: string): OpenclawConfig {
  if (capability === CAPABILITY_CAPTURE) {
    return {
      ...config,
      capture: { ...config.capture, enabled: true },
      capabilities: dedup([...(config.capabilities ?? []), capability]),
    };
  }
  if (capability === CAPABILITY_CONTEXT_INJECTION) {
    return {
      ...config,
      contextInjection: { ...config.contextInjection, enabled: true },
      capabilities: dedup([...(config.capabilities ?? []), capability]),
    };
  }
  return config;
}

function dedup(items: string[]): string[] {
  return Array.from(new Set(items));
}

/**
 * Resolve `stateDir` for the config writer. Same precedence chain as
 * `resolveStateDir` in paths.ts, but explicit + non-throwing when no
 * source produces a value.
 */
export function configStateDir(stateDir: string | undefined): string | undefined {
  if (stateDir && isAbsolute(resolve(stateDir))) return resolve(stateDir);
  const envDir = process.env.OPENCLAW_STATE_DIR;
  if (envDir && envDir.trim().length > 0) return resolve(envDir);
  return undefined;
}

export function configPath(stateDir: string): string {
  if (!stateDir || typeof stateDir !== 'string') {
    throw new HubError('VALIDATION', 'stateDir required', 400);
  }
  if (!isAbsolute(stateDir)) {
    throw new HubError('VALIDATION', 'stateDir must be absolute', 400);
  }
  return join(stateDir, 'openclaw.config.json');
}

export function readOpenclawConfig(path: string, options: OpenclawConfigReadOptions = {}): OpenclawConfig {
  if (!path || typeof path !== 'string') {
    throw new HubError('VALIDATION', 'configPath required', 400);
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new HubError('NOT_FOUND', `openclaw config not found: ${path}`, 404);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new HubError('VALIDATION', `openclaw config malformed: ${(error as Error).message}`, 400);
  }
  const config = normaliseConfig(parsed);
  const capabilities = new Set(options.capabilities ?? []);

  // Apply env-var overrides ONLY when the matching capability is present.
  const env = options.env ?? process.env;
  // Capture override.
  const captureOverride = env.PAH_OPENCLAW_CAPTURE;
  if (captureOverride && /^(1|true|yes|on)$/iu.test(captureOverride)) {
    if (!capabilities.has(CAPABILITY_CAPTURE)) {
      throw new HubError(
        'FORBIDDEN',
        `PAH_OPENCLAW_CAPTURE=${captureOverride} requires capability ${CAPABILITY_CAPTURE}`,
        403,
      );
    }
    config.capture = { ...config.capture, enabled: true };
  }
  // Context injection override.
  const contextOverride = env.PAH_OPENCLAW_CONTEXT_INJECT;
  if (contextOverride && /^(1|true|yes|on)$/iu.test(contextOverride)) {
    if (!capabilities.has(CAPABILITY_CONTEXT_INJECTION)) {
      throw new HubError(
        'FORBIDDEN',
        `PAH_OPENCLAW_CONTEXT_INJECT=${contextOverride} requires capability ${CAPABILITY_CONTEXT_INJECTION}`,
        403,
      );
    }
    config.contextInjection = { ...config.contextInjection, enabled: true };
  }

  // Final capability check: if the on-disk config has either option
  // enabled, the caller must hold the matching capability. This is
  // the S9 invariant that prevents a tampered config from silently
  // activating capture.
  if (config.capture.enabled && !capabilities.has(CAPABILITY_CAPTURE)) {
    throw new HubError(
      'FORBIDDEN',
      `openclaw.capture requires capability ${CAPABILITY_CAPTURE}`,
      403,
    );
  }
  if (config.contextInjection.enabled && !capabilities.has(CAPABILITY_CONTEXT_INJECTION)) {
    throw new HubError(
      'FORBIDDEN',
      `openclaw.contextInjection requires capability ${CAPABILITY_CONTEXT_INJECTION}`,
      403,
    );
  }

  return config;
}

export function writeOpenclawConfig(path: string, config: OpenclawConfig): void {
  if (!path || typeof path !== 'string') {
    throw new HubError('VALIDATION', 'configPath required', 400);
  }
  const dir = dirname(path);
  if (dir && !existsSync(dir)) {
    throw new HubError('VALIDATION', `config dir not found: ${dir}`, 400);
  }
  const normalised = normaliseConfig(config);
  if (normalised.capture.enabled) {
    throw new HubError(
      'FORBIDDEN',
      `openclaw.capture cannot be persisted as enabled; enable it at runtime via capability ${CAPABILITY_CAPTURE}`,
      403,
    );
  }
  if (normalised.contextInjection.enabled) {
    throw new HubError(
      'FORBIDDEN',
      `openclaw.contextInjection cannot be persisted as enabled; enable it at runtime via capability ${CAPABILITY_CONTEXT_INJECTION}`,
      403,
    );
  }
  writeFileSync(path, JSON.stringify(normalised, null, 2) + '\n', 'utf8');
}

function normaliseConfig(value: unknown): OpenclawConfig {
  if (!value || typeof value !== 'object') {
    throw new HubError('VALIDATION', 'openclaw config must be an object', 400);
  }
  const rec = value as Record<string, unknown>;
  const schemaVersion = rec.schemaVersion;
  if (schemaVersion !== OPENCLAW_CONFIG_SCHEMA_VERSION) {
    throw new HubError(
      'VALIDATION',
      `openclaw config schemaVersion must be ${OPENCLAW_CONFIG_SCHEMA_VERSION}: got ${String(schemaVersion)}`,
      400,
    );
  }
  const harness = rec.harness;
  if (harness !== 'openclaw') {
    throw new HubError('VALIDATION', `openclaw config harness must be 'openclaw': got ${String(harness)}`, 400);
  }
  const agentId = rec.agentId;
  if (typeof agentId !== 'string' || !/^agt_[A-Za-z0-9._-]+$/u.test(agentId)) {
    throw new HubError('VALIDATION', `invalid agentId: ${String(agentId)}`, 400);
  }
  const stateDir = rec.stateDir;
  if (stateDir !== undefined && (typeof stateDir !== 'string' || !isAbsolute(resolve(stateDir)))) {
    throw new HubError('VALIDATION', 'stateDir must be absolute', 400);
  }
  const capture = rec.capture;
  if (!capture || typeof capture !== 'object') {
    throw new HubError('VALIDATION', 'capture config required', 400);
  }
  const captureRec = capture as Record<string, unknown>;
  if (typeof captureRec.enabled !== 'boolean') {
    throw new HubError('VALIDATION', 'capture.enabled must be boolean', 400);
  }
  const contextInjection = rec.contextInjection;
  if (!contextInjection || typeof contextInjection !== 'object') {
    throw new HubError('VALIDATION', 'contextInjection config required', 400);
  }
  const contextRec = contextInjection as Record<string, unknown>;
  if (typeof contextRec.enabled !== 'boolean') {
    throw new HubError('VALIDATION', 'contextInjection.enabled must be boolean', 400);
  }
  const rendererVersion = rec.rendererVersion;
  if (typeof rendererVersion !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9._-]+)?$/u.test(rendererVersion)) {
    throw new HubError('VALIDATION', `invalid rendererVersion: ${String(rendererVersion)}`, 400);
  }
  return {
    schemaVersion: OPENCLAW_CONFIG_SCHEMA_VERSION,
    harness: 'openclaw',
    agentId,
    stateDir: typeof stateDir === 'string' ? resolve(stateDir) : '',
    capture: {
      enabled: captureRec.enabled,
      scope: captureRec.scope === 'all' ? 'all' : 'stateDir',
    },
    contextInjection: {
      enabled: contextRec.enabled,
      scope: contextRec.scope === 'session' ? 'session' : 'renderer',
    },
    capabilities: Array.isArray(rec.capabilities)
      ? (rec.capabilities as unknown[]).filter((c): c is string => typeof c === 'string')
      : undefined,
    rendererVersion,
  };
}
