// packages/materializers/src/openclaw/plugin-manifest.ts
//
// OpenClaw plugin manifest builder. The plugin manifest is the
// descriptor the host loads when wiring the OpenClaw adapter into a
// runtime. It pins the renderer version + snapshot/profile the plugin
// was built against so a host can refuse to load a stale plugin
// against a newer snapshot.
//
// Contract (see `integrations/openclaw/openclaw.plugin.schema.json`):
//
//   * `kind` is always `'openclaw'` — the S9 surface only ships one
//     plugin kind.
//   * `name` / `version` are author-supplied.
//   * `snapshotId` / `profileId` tie the plugin to the snapshot+profile
//     pair the manifest was generated from. Two plugins for two
//     snapshots MUST have different (name, version, snapshotId,
//     profileId) tuples.
//   * `rendererVersion` equals `OPENCLAW_RENDERER_VERSION`. A renderer
//     bump forces a re-preview, which forces a plugin re-build, which
//     forces the host to reload — the chain keeps the plugin
//     timestamped to the renderer.
//   * `entry` is the JS entry point the host spawns. Always
//     `'index.js'` for the S9 reference implementation.
//   * `commands` lists the plugin commands the host surfaces. The
//     default `init` + `recall` set matches the S9 plan; consumers can
//     append their own without touching this file.
//   * `requiredCapabilities` is the list of capabilities a host must
//     grant before invoking any of the commands. The OpenClaw daemon
//     grants `openclaw.assets.read` to every user; capture and
//     context injection require `openclaw.capture` /
//     `openclaw.contextInjection` respectively (added by the host
//     based on the run's permissions).
//
// No Tencent, /v2, /v3, COS, or proxy references anywhere — the
// schema test (tests/s9-schemas.test.ts) asserts the JSON-stringified
// manifest never contains these tokens.

import { OPENCLAW_RENDERER_VERSION } from './manifest.js';

export const OPENCLAW_PLUGIN_KIND = 'openclaw' as const;

export type OpenclawPluginCommand = {
  name: string;
  description: string;
};

export type OpenclawPluginManifest = {
  kind: typeof OPENCLAW_PLUGIN_KIND;
  name: string;
  version: string;
  snapshotId: string;
  profileId: string;
  rendererVersion: string;
  /** Absolute state dir the plugin was built against. */
  stateDir: string;
  /** JS entry point the host spawns. */
  entry: 'index.js';
  /** Commands the plugin surfaces. */
  commands: OpenclawPluginCommand[];
  /** Capabilities the host must grant before any command runs. */
  requiredCapabilities: string[];
};

const DEFAULT_COMMANDS: ReadonlyArray<OpenclawPluginCommand> = Object.freeze([
  Object.freeze({ name: 'init', description: 'initialize the openclaw state dir' }),
  Object.freeze({ name: 'recall', description: 'recall assets for the active snapshot' }),
  Object.freeze({ name: 'capture', description: 'capture a new asset into the state dir (requires openclaw.capture)' }),
  Object.freeze({ name: 'inject', description: 'inject context into the renderer (requires openclaw.contextInjection)' }),
]);

export interface BuildOpenclawPluginManifestInput {
  name: string;
  version: string;
  snapshotId: string;
  profileId: string;
  stateDir: string;
  capabilities: readonly string[];
  /** Optional command list override; defaults to the S9 reference set. */
  commands?: readonly OpenclawPluginCommand[];
}

/**
 * Build a frozen OpenClaw plugin manifest. Pure: no side effects.
 */
export function buildOpenclawPluginManifest(
  input: BuildOpenclawPluginManifestInput,
): OpenclawPluginManifest {
  if (!input.name || typeof input.name !== 'string') {
    throw new TypeError('plugin name required');
  }
  if (!input.version || typeof input.version !== 'string') {
    throw new TypeError('plugin version required');
  }
  if (!/^snap_[A-Za-z0-9._-]+$/u.test(input.snapshotId)) {
    throw new TypeError(`invalid snapshotId: ${input.snapshotId}`);
  }
  if (!/^prf_[A-Za-z0-9._-]+$/u.test(input.profileId)) {
    throw new TypeError(`invalid profileId: ${input.profileId}`);
  }
  if (!input.stateDir || typeof input.stateDir !== 'string') {
    throw new TypeError('stateDir required');
  }
  const capabilities = Array.from(
    new Set((input.capabilities ?? []).filter((c): c is string => typeof c === 'string')),
  );
  const commands = (input.commands ?? DEFAULT_COMMANDS).map((cmd) =>
    Object.freeze({ name: cmd.name, description: cmd.description }),
  );
  const manifest: OpenclawPluginManifest = {
    kind: OPENCLAW_PLUGIN_KIND,
    name: input.name,
    version: input.version,
    snapshotId: input.snapshotId,
    profileId: input.profileId,
    rendererVersion: OPENCLAW_RENDERER_VERSION,
    stateDir: input.stateDir,
    entry: 'index.js',
    commands,
    requiredCapabilities: capabilities,
  };
  return Object.freeze(manifest);
}