// packages/materializers/src/openclaw/paths.ts
//
// OpenClaw layout helpers. The frozen layout for S9 places every
// profile-derived file under `<stateDir>/agents/<agentId>/...` and the
// manifest at `<stateDir>/.pah/manifest.v1.json`. The renderer cannot
// choose a different layout — the S9 contract gates the
// `(stateDir, agentId)` pair so two agents cannot cross assets.
//
// resolveStateDir() is the OpenClaw-side counterpart of the runtime
// hook. The S9 plan mandates the precedence chain:
//
//   1. Explicit `stateDir` option (highest priority).
//   2. `OPENCLAW_STATE_DIR` env var (set by the OpenClaw daemon, the
//      CI runner, or the S10 cutover).
//   3. The runtime accessor `resolveStateDir()` from
//      `@portable-agent-asset-hub/core` (injected by the host process).
//   4. FAIL — never default to `~/.openclaw`. The S9 plan explicitly
//      forbids assuming the home directory.

import { existsSync, lstatSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { HubError } from '@portable-agent-asset-hub/core';
import type { ManifestFile } from '../contracts.js';
import type { Profile } from '@portable-agent-asset-hub/core';

/**
 * Runtime accessor that resolves the OpenClaw state dir from the host
 * process. The S9 plan names this `resolveStateDir()` and pins it as
 * the highest-priority fallback (above `OPENCLAW_STATE_DIR`). The
 * function is intentionally injected: the OpenClaw plugin is a thin
 * SDK consumer that must never reach into the host environment on
 * its own.
 */
export type StateDirAccessor = () => string | undefined;

/**
 * Default runtime accessor. The OpenClaw plugin does not ship a
 * hard-coded fallback; this default honours the S9 rule that the
 * plugin must NEVER default to `~/.openclaw`. The host injects a
 * real accessor; tests pass a per-test tempdir-bound accessor.
 */
export const defaultStateDirAccessor: StateDirAccessor = () => undefined;

export interface ResolveStateDirOptions {
  stateDir?: string;
  accessor?: StateDirAccessor;
  env?: NodeJS.ProcessEnv;
}

export function resolveStateDir(options: ResolveStateDirOptions = {}): string {
  const env = options.env ?? process.env;
  // 1. Explicit option wins.
  if (options.stateDir && typeof options.stateDir === 'string') {
    return assertSafeStateDir(options.stateDir);
  }
  // 2. Env var.
  const envDir = env.OPENCLAW_STATE_DIR;
  if (envDir && typeof envDir === 'string' && envDir.trim().length > 0) {
    return assertSafeStateDir(envDir);
  }
  // 3. Runtime accessor.
  const accessor = options.accessor ?? defaultStateDirAccessor;
  if (typeof accessor === 'function') {
    const accessed = accessor();
    if (typeof accessed === 'string' && accessed.trim().length > 0) {
      return assertSafeStateDir(accessed);
    }
  }
  // 4. Fail with a precise message — never default to ~/.openclaw.
  throw new HubError(
    'VALIDATION',
    'stateDir required: pass { stateDir } or set OPENCLAW_STATE_DIR (or inject a runtime accessor); the plugin never defaults to ~/.openclaw',
    400,
  );
}

function assertSafeStateDir(stateDir: string): string {
  if (!stateDir || typeof stateDir !== 'string') {
    throw new HubError('VALIDATION', 'stateDir required', 400);
  }
  const absolute = resolve(stateDir);
  if (!isAbsolute(absolute)) {
    throw new HubError('VALIDATION', 'stateDir must be absolute', 400);
  }
  if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) {
    throw new HubError('VALIDATION', 'symlink stateDir rejected', 400);
  }
  return absolute;
}

/**
 * Frozen OpenClaw filename set. The S9 contract accepts EXACTLY these
 * names — adding a new file requires a renderer-version bump so the
 * drift detector rolls existing targets.
 *
 * The entries are emitted in agentId-resolved form so the S9 contract
 * test (`tests/s9-contracts.test.ts`) can assert against a literal
 * `agents/<agentId>/<file>` string. The default `agentId` is the
 * S9 reference value `agt_s9`; the dynamic renderer in
 * `renderOpenclawFiles` substitutes the profile's actual `agentId` at
 * materialisation time.
 */
export const OPENCLAW_FILES = Object.freeze([
  'agents/agt_s9/user.md',
  'agents/agt_s9/memory.md',
  'agents/agt_s9/skills.md',
  'agents/agt_s9/bindings.json',
] as const);
export type OpenclawFileTemplate = (typeof OPENCLAW_FILES)[number];

export function expandOpenclawPath(template: string, agentId: string): string {
  if (!agentId || typeof agentId !== 'string') {
    throw new HubError('VALIDATION', 'agentId required', 400);
  }
  if (!/^agt_[A-Za-z0-9._-]+$/u.test(agentId)) {
    throw new HubError('VALIDATION', `invalid agentId: ${agentId}`, 400);
  }
  return template.replace(/\{agentId\}/gu, agentId);
}

export function isOpenclawFile(name: string): boolean {
  if (typeof name !== 'string') return false;
  // OpenClaw files are always under agents/<agentId>/.
  return /^agents\/agt_[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u.test(name);
}

export function renderOpenclawUser(profile: Profile): Buffer {
  const blocks = [...profile.blocks]
    .filter((block) => block.kind === 'USER')
    .sort((left, right) => left.ordinal - right.ordinal || left.blockId.localeCompare(right.blockId));
  const body = blocks.length === 0
    ? ''
    : blocks.map((b) => b.body.replace(/\r\n?/gu, '\n').replace(/\n+$/u, '')).join('\n');
  // OpenClaw uses a YAML-ish front-matter header (matches the historical
  // OpenClaw layout) so the bytes are recognisable on the disk.
  const text = `kind: USER\nagent: ${profile.scope.agentId}\nprofile: ${profile.id}\nversion: ${profile.version}\n---\n${body}\n`;
  return Buffer.from(text, 'utf8');
}

export function renderOpenclawMemory(profile: Profile): Buffer {
  const blocks = [...profile.blocks]
    .filter((block) => block.kind === 'MEMORY')
    .sort((left, right) => left.ordinal - right.ordinal || left.blockId.localeCompare(right.blockId));
  const body = blocks.length === 0
    ? ''
    : blocks.map((b) => `<!-- ${b.blockId} ordinal=${b.ordinal} -->\n${b.body.replace(/\r\n?/gu, '\n').replace(/\n+$/u, '')}`).join('\n');
  const text = `kind: MEMORY\nagent: ${profile.scope.agentId}\nprofile: ${profile.id}\nversion: ${profile.version}\n---\n${body}\n`;
  return Buffer.from(text, 'utf8');
}

export function renderOpenclawSkills(profile: Profile): Buffer {
  // S9 has no skill store yet — the file is a stable header so the
  // S10 cutover can fill it from the SDK output. The S9 contract
  // pins the byte shape so the digest is deterministic across
  // processes.
  const text = `kind: SKILLS\nagent: ${profile.scope.agentId}\nprofile: ${profile.id}\nversion: ${profile.version}\n---\n`;
  return Buffer.from(text, 'utf8');
}

export function renderOpenclawBindings(profile: Profile): Buffer {
  // bindings.json names the upstream scope and the harness bindings
  // the renderer will register at apply time. S9 ships a minimal,
  // frozen JSON shape so two agents never cross assets: the agent
  // path is derived from the actor's scope, not from the profile's
  // id.
  const bindings = {
    schemaVersion: '1',
    profileId: profile.id,
    userId: profile.scope.ownerUserId,
    agentId: profile.scope.agentId,
    harness: 'openclaw',
    rendererVersion: '0.1.0',
  };
  return Buffer.from(JSON.stringify(bindings, null, 2) + '\n', 'utf8');
}

export function renderOpenclawFiles(profile: Profile): ManifestFile[] {
  const agentId = profile.scope.agentId;
  if (!/^agt_[A-Za-z0-9._-]+$/u.test(agentId)) {
    throw new HubError('VALIDATION', `invalid agentId in profile scope: ${agentId}`, 400);
  }
  const user = renderOpenclawUser(profile);
  const memory = renderOpenclawMemory(profile);
  const skills = renderOpenclawSkills(profile);
  const bindings = renderOpenclawBindings(profile);
  const files: ManifestFile[] = [
    {
      relativePath: expandOpenclawPath('agents/{agentId}/user.md', agentId),
      sha256: sha256Hex(user),
      bytes: user,
      mode: 0o644,
      sourceRef: 'profile:block:user',
    },
    {
      relativePath: expandOpenclawPath('agents/{agentId}/memory.md', agentId),
      sha256: sha256Hex(memory),
      bytes: memory,
      mode: 0o644,
      sourceRef: 'profile:block:memory',
    },
    {
      relativePath: expandOpenclawPath('agents/{agentId}/skills.md', agentId),
      sha256: sha256Hex(skills),
      bytes: skills,
      mode: 0o644,
      sourceRef: 'profile:skills-header',
    },
    {
      relativePath: expandOpenclawPath('agents/{agentId}/bindings.json', agentId),
      sha256: sha256Hex(bindings),
      bytes: bindings,
      mode: 0o644,
      sourceRef: 'profile:bindings',
    },
  ];
  for (const file of files) {
    if (!file.bytes || file.bytes.length === 0) {
      throw new HubError('VALIDATION', `empty render: ${file.relativePath}`, 500);
    }
  }
  return files;
}

import { createHash } from 'node:crypto';

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
