// tests/s9-contracts.test.ts
//
// Normative contracts for the S9 OpenClaw materializer. These tests
// pin the public surface of the OpenClaw adapter BEFORE any production
// code is written. They mirror the S8 Hermes contract on the same
// renderer-agnostic pipeline and add the OpenClaw-specific guardrails:
// state dir resolution (runtime > OPENCLAW_STATE_DIR > no ~/.openclaw),
// capture-disabled-by-default, explicit capability gating for context
// injection, no Tencent / /v2 / /v3 / COS / Proxy leakage, and the
// same `snapshot_id` + rendererVersion as Hermes.
//
// OpenClaw layout (frozen by this contract):
//
//   <stateDir>/agents/<agentId>/user.md
//   <stateDir>/agents/<agentId>/memory.md
//   <stateDir>/agents/<agentId>/skills.md
//   <stateDir>/agents/<agentId>/bindings.json
//   <stateDir>/.pah/manifest.v1.json
//
// The `--state-dir` flag the S9 plugin accepts at `init` time is the
// single source of truth for where the layout lives; the runtime
// accessor supplies the default. The plugin never reads `~/.openclaw`
// directly.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createActorContext,
  type Profile,
  type ProfileBlock,
  type Storage,
} from '@portable-agent-asset-hub/core';
import { SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';

const ROOT_TMP = tmpdir();
const cleanup: string[] = [];

afterEach(() => {
  // Reset all process.env overrides the tests may have set.
  delete process.env.OPENCLAW_STATE_DIR;
  delete process.env.PAH_OPENCLAW_CAPTURE;
  delete process.env.PAH_OPENCLAW_CONTEXT_INJECT;
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const tempRoot = (label: string): string => {
  const dir = mkdtempSync(join(ROOT_TMP, `s9-contracts-${label}-`));
  cleanup.push(dir);
  return dir;
};

const actor = createActorContext({
  userId: 'usr_s9',
  agentId: 'agt_s9',
  role: 'user',
  capabilities: ['admin.materialize'],
});

const secondActor = createActorContext({
  userId: 'usr_s9_other',
  agentId: 'agt_s9_other',
  role: 'user',
  capabilities: ['admin.materialize'],
});

const mutation = (reason: string): { reason: string; requestId: string } => ({
  reason,
  requestId: `req-${reason}`,
});

const userBlock = (id: string, body: string): ProfileBlock => ({
  blockId: id,
  ordinal: Number(id.replace(/[^0-9]/g, '')) || 1,
  kind: 'USER',
  body,
});

const memoryBlock = (id: string, body: string): ProfileBlock => ({
  blockId: id,
  ordinal: Number(id.replace(/[^0-9]/g, '')) || 1,
  kind: 'MEMORY',
  body,
});

const newStore = (): Storage => new SqliteStore(':memory:');

describe('S9 contracts: module surface', () => {
  it('exposes the OpenClaw adapter subpath with adapter, paths, config, plugin-manifest', async () => {
    const root = tempRoot('surface');
    void root;
    const mod = await import('@portable-agent-asset-hub/materializers/openclaw');
    expect(typeof mod.openclawAdapter).toBe('object');
    expect(typeof mod.openclawAdapter.render).toBe('function');
    expect(typeof mod.buildOpenclawManifest).toBe('function');
    expect(typeof mod.OPENCLAW_RENDERER_VERSION).toBe('string');
    expect(typeof mod.renderOpenclawFiles).toBe('function');
    expect(typeof mod.isOpenclawFile).toBe('function');
    expect(typeof mod.resolveStateDir).toBe('function');
    expect(typeof mod.readOpenclawConfig).toBe('function');
    expect(typeof mod.writeOpenclawConfig).toBe('function');
    expect(typeof mod.defaultOpenclawConfig).toBe('function');
    expect(typeof mod.openclawPreview).toBe('function');
    expect(typeof mod.openclawApply).toBe('function');
    expect(typeof mod.openclawRollback).toBe('function');
    expect(typeof mod.openclawMaterializerDispatcher).toBe('function');
    expect(typeof mod.buildOpenclawPluginManifest).toBe('function');
    expect(typeof mod.OPENCLAW_PLUGIN_KIND).toBe('string');
  });

  it('registers the openclaw adapter on the renderer-agnostic index', async () => {
    const root = tempRoot('register');
    void root;
    const core = await import('@portable-agent-asset-hub/materializers');
    expect(typeof core.getAdapter).toBe('function');
    const adapter = core.getAdapter('openclaw');
    expect(adapter.id).toBe('openclaw');
    expect(typeof adapter.render).toBe('function');
  });
});

describe('S9 resolveStateDir: precedence chain, no ~/.openclaw assumption', () => {
  it('returns the explicit option when provided', async () => {
    const { resolveStateDir } = await import('@portable-agent-asset-hub/materializers/openclaw');
    const explicit = tempRoot('explicit');
    const resolved = resolveStateDir({ stateDir: explicit });
    expect(resolved).toBe(explicit);
  });

  it('falls back to OPENCLAW_STATE_DIR env var when no option is given', async () => {
    const { resolveStateDir } = await import('@portable-agent-asset-hub/materializers/openclaw');
    const envDir = tempRoot('env');
    process.env.OPENCLAW_STATE_DIR = envDir;
    const resolved = resolveStateDir({});
    expect(resolved).toBe(envDir);
  });

  it('prefers the explicit option over OPENCLAW_STATE_DIR', async () => {
    const { resolveStateDir } = await import('@portable-agent-asset-hub/materializers/openclaw');
    const envDir = tempRoot('env2');
    const explicit = tempRoot('explicit2');
    process.env.OPENCLAW_STATE_DIR = envDir;
    const resolved = resolveStateDir({ stateDir: explicit });
    expect(resolved).toBe(explicit);
  });

  it('rejects callers that try to default to ~/.openclaw', async () => {
    const { resolveStateDir } = await import('@portable-agent-asset-hub/materializers/openclaw');
    // No env, no option. The function must NOT silently invent a path.
    expect(() => resolveStateDir({})).toThrow(/stateDir/i);
  });

  it('rejects a symlinked state dir (defence in depth, matches S8)', async () => {
    const { resolveStateDir } = await import('@portable-agent-asset-hub/materializers/openclaw');
    const outer = tempRoot('sym-outer');
    const real = mkdtempSync(join(outer, 'real-'));
    cleanup.push(real);
    const { symlinkSync } = await import('node:fs');
    const link = join(outer, 'link');
    symlinkSync(real, link);
    expect(() => resolveStateDir({ stateDir: link })).toThrow(/symlink/i);
  });
});

describe('S9 paths: frozen openclaw layout', () => {
  it('renders agents/<agentId>/{user,memory,skills,bindings}.md', async () => {
    const { renderOpenclawFiles, OPENCLAW_FILES } = await import(
      '@portable-agent-asset-hub/materializers/openclaw'
    );
    const profile: Profile = {
      id: 'prf_layout',
      scope: actor.scope,
      version: 1,
      blocks: [userBlock('u-1', 'layout user'), memoryBlock('m-1', 'layout memory')],
    };
    const files = renderOpenclawFiles(profile);
    const names = files.map((f) => f.relativePath).sort();
    expect(names).toEqual([
      'agents/agt_s9/bindings.json',
      'agents/agt_s9/memory.md',
      'agents/agt_s9/skills.md',
      'agents/agt_s9/user.md',
    ]);
    expect(OPENCLAW_FILES).toContain('agents/agt_s9/user.md');
    for (const f of files) {
      expect(f.relativePath.startsWith(sep)).toBe(false);
      expect(f.relativePath).not.toContain('..');
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(f.bytes.length).toBeGreaterThan(0);
    }
  });

  it('scopes the agent dir to the actor.agentId (no asset crossing)', async () => {
    const { renderOpenclawFiles } = await import('@portable-agent-asset-hub/materializers/openclaw');
    const profileA: Profile = {
      id: 'prf_a',
      scope: actor.scope,
      version: 1,
      blocks: [userBlock('u', 'A'), memoryBlock('m', 'A')],
    };
    const profileB: Profile = {
      id: 'prf_b',
      scope: secondActor.scope,
      version: 1,
      blocks: [userBlock('u', 'B'), memoryBlock('m', 'B')],
    };
    const filesA = renderOpenclawFiles(profileA).map((f) => f.relativePath);
    const filesB = renderOpenclawFiles(profileB).map((f) => f.relativePath);
    expect(filesA.some((p) => p.startsWith('agents/agt_s9/'))).toBe(true);
    expect(filesA.some((p) => p.startsWith('agents/agt_s9_other/'))).toBe(false);
    expect(filesB.some((p) => p.startsWith('agents/agt_s9_other/'))).toBe(true);
    expect(filesB.some((p) => p.startsWith('agents/agt_s9/'))).toBe(false);
  });
});

describe('S9 config: capture off by default, context injection disabled by default', () => {
  it('defaultOpenclawConfig has capture disabled and context injection off', async () => {
    const { defaultOpenclawConfig } = await import('@portable-agent-asset-hub/materializers/openclaw');
    const cfg = defaultOpenclawConfig('agt_s9');
    expect(cfg.capture.enabled).toBe(false);
    expect(cfg.contextInjection.enabled).toBe(false);
    expect(cfg.harness).toBe('openclaw');
    expect(cfg.schemaVersion).toBe('1');
  });

  it('accepts an explicit capability to enable context injection', async () => {
    const { defaultOpenclawConfig, withCapability } = await import(
      '@portable-agent-asset-hub/materializers/openclaw'
    );
    const base = defaultOpenclawConfig('agt_s9');
    const enabled = withCapability(base, 'openclaw.contextInjection');
    expect(enabled.contextInjection.enabled).toBe(true);
    // base is frozen semantics — withCapability returns a new value.
    expect(base.contextInjection.enabled).toBe(false);
  });

  it('rejects capture=true without the explicit capability', async () => {
    const { defaultOpenclawConfig, readOpenclawConfig } = await import(
      '@portable-agent-asset-hub/materializers/openclaw'
    );
    const dir = tempRoot('cfg');
    const path = join(dir, 'openclaw.config.json');
    const base = defaultOpenclawConfig('agt_s9');
    // Capture on, capability absent — must be rejected at read time.
    const tampered = { ...base, capture: { ...base.capture, enabled: true } };
    writeFileSync(path, JSON.stringify(tampered));
    expect(() => readOpenclawConfig(path, { capabilities: ['admin.materialize'] })).toThrow(
      /capability/i,
    );
  });

  it('accepts capture=true when the explicit capability is present', async () => {
    const { defaultOpenclawConfig, readOpenclawConfig } = await import(
      '@portable-agent-asset-hub/materializers/openclaw'
    );
    const dir = tempRoot('cfg-cap');
    const path = join(dir, 'openclaw.config.json');
    const base = defaultOpenclawConfig('agt_s9');
    const tampered = {
      ...base,
      capture: { ...base.capture, enabled: true },
      capabilities: ['openclaw.capture'],
    };
    writeFileSync(path, JSON.stringify(tampered));
    const cfg = readOpenclawConfig(path, { capabilities: ['openclaw.capture'] });
    expect(cfg.capture.enabled).toBe(true);
  });

  it('rejects PAH_OPENCLAW_CAPTURE=1 without the explicit capability', async () => {
    const { readOpenclawConfig, defaultOpenclawConfig } = await import(
      '@portable-agent-asset-hub/materializers/openclaw'
    );
    const dir = tempRoot('cfg-env');
    const path = join(dir, 'openclaw.config.json');
    writeFileSync(path, JSON.stringify(defaultOpenclawConfig('agt_s9')));
    process.env.PAH_OPENCLAW_CAPTURE = '1';
    expect(() => readOpenclawConfig(path, { capabilities: [] })).toThrow(/capability/i);
  });
});

describe('S9 plugin-manifest: openclaw.plugin.json contract', () => {
  it('produces a stable manifest with the same snapshot_id/rendererVersion as Hermes', async () => {
    const { buildOpenclawPluginManifest, OPENCLAW_RENDERER_VERSION } = await import(
      '@portable-agent-asset-hub/materializers/openclaw'
    );
    const manifest = buildOpenclawPluginManifest({
      name: 'pah-openclaw',
      version: '0.1.0',
      snapshotId: 'snap_oc1',
      profileId: 'prf_oc1',
      stateDir: tempRoot('pm'),
      capabilities: ['openclaw.assets.read'],
    });
    expect(manifest.kind).toBe('openclaw');
    expect(manifest.snapshotId).toBe('snap_oc1');
    expect(manifest.profileId).toBe('prf_oc1');
    expect(manifest.rendererVersion).toBe(OPENCLAW_RENDERER_VERSION);
    expect(manifest.entry).toBe('index.js');
    expect(Array.isArray(manifest.commands)).toBe(true);
    expect(Array.isArray(manifest.requiredCapabilities)).toBe(true);
    expect(manifest.requiredCapabilities).toContain('openclaw.assets.read');
    // No Tencent / /v2 / /v3 / COS / Proxy references.
    const flat = JSON.stringify(manifest);
    expect(flat).not.toMatch(/Tencent|tencent|cos|COS|proxy|\/v2|\/v3/u);
  });

  it('survives a JSON round-trip and binds the same rendererVersion', async () => {
    const { buildOpenclawPluginManifest } = await import(
      '@portable-agent-asset-hub/materializers/openclaw'
    );
    const manifest = buildOpenclawPluginManifest({
      name: 'pah-openclaw',
      version: '0.1.0',
      snapshotId: 'snap_oc2',
      profileId: 'prf_oc2',
      stateDir: tempRoot('pm2'),
      capabilities: ['openclaw.assets.read'],
    });
    const round = JSON.parse(JSON.stringify(manifest));
    expect(round.rendererVersion).toBe(manifest.rendererVersion);
    expect(round.snapshotId).toBe(manifest.snapshotId);
  });
});

describe('S9 openclaw preview: deterministic, validation, scope isolation', () => {
  let store: Storage;

  beforeEach(() => {
    store = newStore();
    store.transaction(actor, (tx) => {
      tx.profiles.create(
        {
          id: 'prf_oc',
          scope: actor.scope,
          version: 1,
          blocks: [userBlock('u', 'oc user'), memoryBlock('m', 'oc memory')],
        },
        mutation('create'),
      );
    });
    store.transaction(secondActor, (tx) => {
      tx.profiles.create(
        {
          id: 'prf_oc_other',
          scope: secondActor.scope,
          version: 1,
          blocks: [userBlock('u', 'other'), memoryBlock('m', 'other')],
        },
        mutation('create'),
      );
    });
  });

  afterEach(() => {
    store.close();
  });

  it('produces a deterministic file list for the same snapshot + harness + stateDir', async () => {
    const { openclawPreview } = await import('@portable-agent-asset-hub/materializers/openclaw');
    const stateDir = tempRoot('prev');
    const a = openclawPreview(store, actor, {
      harness: 'openclaw',
      profileId: 'prf_oc',
      snapshotId: 'snap_oc',
      stateDir,
    });
    const b = openclawPreview(store, actor, {
      harness: 'openclaw',
      profileId: 'prf_oc',
      snapshotId: 'snap_oc',
      stateDir,
    });
    expect(a.plan.files.map((f) => f.relativePath)).toEqual(
      b.plan.files.map((f) => f.relativePath),
    );
    expect(a.observedDigest).toBe(b.observedDigest);
  });

  it('rejects traversal in any rendered relative path', async () => {
    const { openclawPreview } = await import('@portable-agent-asset-hub/materializers/openclaw');
    const stateDir = tempRoot('prev-trav');
    const preview = openclawPreview(store, actor, {
      harness: 'openclaw',
      profileId: 'prf_oc',
      snapshotId: 'snap_oc',
      stateDir,
    });
    for (const f of preview.plan.files) {
      expect(f.relativePath.startsWith(sep)).toBe(false);
      expect(f.relativePath).not.toContain('..');
    }
  });

  it('rejects a missing stateDir (no ~/.openclaw assumption)', async () => {
    const { openclawPreview } = await import('@portable-agent-asset-hub/materializers/openclaw');
    expect(() =>
      openclawPreview(store, actor, {
        harness: 'openclaw',
        profileId: 'prf_oc',
        snapshotId: 'snap_oc',
        // stateDir intentionally omitted
      }),
    ).toThrow(/stateDir/i);
  });

  it('two agents do not cross assets: each preview only contains its own agentId', async () => {
    const { openclawPreview } = await import('@portable-agent-asset-hub/materializers/openclaw');
    const stateDir = tempRoot('iso');
    const a = openclawPreview(store, actor, {
      harness: 'openclaw',
      profileId: 'prf_oc',
      snapshotId: 'snap_oc',
      stateDir,
    });
    const b = openclawPreview(store, secondActor, {
      harness: 'openclaw',
      profileId: 'prf_oc_other',
      snapshotId: 'snap_oc',
      stateDir,
    });
    const aPaths = a.plan.files.map((f) => f.relativePath);
    const bPaths = b.plan.files.map((f) => f.relativePath);
    expect(aPaths.some((p) => p.startsWith('agents/agt_s9/'))).toBe(true);
    expect(aPaths.some((p) => p.startsWith('agents/agt_s9_other/'))).toBe(false);
    expect(bPaths.some((p) => p.startsWith('agents/agt_s9_other/'))).toBe(true);
    expect(bPaths.some((p) => p.startsWith('agents/agt_s9/'))).toBe(false);
  });
});

describe('S9 openclaw apply: renderer-agnostic pipeline, drift, rollback', () => {
  let store: Storage;

  beforeEach(() => {
    store = newStore();
    store.transaction(actor, (tx) => {
      tx.profiles.create(
        {
          id: 'prf_apply_oc',
          scope: actor.scope,
          version: 1,
          blocks: [userBlock('u', 'apply user'), memoryBlock('m', 'apply mem')],
        },
        mutation('create'),
      );
    });
  });

  afterEach(() => {
    store.close();
  });

  it('writes every file and the manifest at the end', async () => {
    const { openclawApply, openclawPreview } = await import(
      '@portable-agent-asset-hub/materializers/openclaw'
    );
    const stateDir = tempRoot('apply');
    const preview = openclawPreview(store, actor, {
      harness: 'openclaw',
      profileId: 'prf_apply_oc',
      snapshotId: 'snap_oc',
      stateDir,
    });
    const result = openclawApply(store, actor, {
      preview,
      stateDir,
      reason: 'apply-test',
    });
    expect(result.runId).toMatch(/^run_/u);
    for (const file of preview.plan.files) {
      const absolute = join(stateDir, file.relativePath);
      expect(existsSync(absolute)).toBe(true);
      expect(readFileSync(absolute)).toEqual(file.bytes);
    }
    expect(existsSync(join(stateDir, '.pah', 'manifest.v1.json'))).toBe(true);
  });

  it('rejects a tampered follow-up apply with drift (HTTP 412)', async () => {
    const { openclawApply, openclawPreview, observedManifestDigest } = await import(
      '@portable-agent-asset-hub/materializers/openclaw'
    );
    const stateDir = tempRoot('drift');
    const preview = openclawPreview(store, actor, {
      harness: 'openclaw',
      profileId: 'prf_apply_oc',
      snapshotId: 'snap_oc',
      stateDir,
    });
    openclawApply(store, actor, { preview, stateDir, reason: 'first' });
    const memory = preview.plan.files.find((f) => f.relativePath.endsWith('memory.md'));
    expect(memory).toBeTruthy();
    if (memory) writeFileSync(join(stateDir, memory.relativePath), 'tampered');
    const observed = observedManifestDigest(stateDir);
    expect(observed).not.toBe(preview.observedDigest);
    expect(() =>
      openclawApply(store, actor, {
        preview,
        stateDir,
        observedDigest: observed,
        reason: 'second',
      }),
    ).toThrow(/drift|conflict/i);
  });

  it('rollback restores original bytes and removes the manifest', async () => {
    const { openclawApply, openclawPreview, openclawRollback } = await import(
      '@portable-agent-asset-hub/materializers/openclaw'
    );
    const stateDir = tempRoot('rb');
    const userPath = join(stateDir, 'agents', 'agt_s9', 'user.md');
    mkdirSync(join(userPath, '..'), { recursive: true });
    writeFileSync(userPath, 'original-user');
    const preview = openclawPreview(store, actor, {
      harness: 'openclaw',
      profileId: 'prf_apply_oc',
      snapshotId: 'snap_oc',
      stateDir,
    });
    const result = openclawApply(store, actor, { preview, stateDir, reason: 'rb-apply' });
    expect(readFileSync(userPath)).not.toEqual(Buffer.from('original-user'));
    openclawRollback(store, actor, { runId: result.runId, reason: 'rb-rollback' });
    expect(readFileSync(userPath)).toEqual(Buffer.from('original-user'));
    expect(existsSync(join(stateDir, '.pah', 'manifest.v1.json'))).toBe(false);
  });

  it('shares the same rendererVersion and snapshotId as Hermes manifests', async () => {
    const { openclawPreview, OPENCLAW_RENDERER_VERSION } = await import(
      '@portable-agent-asset-hub/materializers/openclaw'
    );
    const hermes = await import('@portable-agent-asset-hub/materializers/hermes');
    const stateDir = tempRoot('shared');
    const oc = openclawPreview(store, actor, {
      harness: 'openclaw',
      profileId: 'prf_apply_oc',
      snapshotId: 'snap_oc',
      stateDir,
    });
    const hp = hermes.hermesPreview(
      { store, actor, targetRoot: stateDir, lockDir: stateDir },
      { harness: 'hermes', profileId: 'prf_apply_oc', snapshotId: 'snap_oc' },
    );
    expect(oc.plan.snapshotId).toBe(hp.plan.snapshotId);
    expect(OPENCLAW_RENDERER_VERSION).toBe(hermes.HERMES_RENDERER_VERSION);
    // Layout differs (different relativePath prefixes), but the renderer
    // stamp is identical — the S9 contract requires "Manifests
    // Hermes/OpenClaw difieren sólo en layout/renderer".
    const ocPaths = oc.plan.files.map((f) => f.relativePath).sort();
    const hpPaths = hp.plan.files.map((f) => f.relativePath).sort();
    expect(ocPaths).not.toEqual(hpPaths);
    expect(oc.plan.rendererVersion).toBe(hp.plan.rendererVersion);
  });
});

describe('S9 openclaw dispatcher: REST binding', () => {
  it('exposes preview/apply/rollback operations and rejects unknown', async () => {
    const { openclawMaterializerDispatcher } = await import(
      '@portable-agent-asset-hub/materializers/openclaw'
    );
    const stateDir = tempRoot('disp');
    const dispatcher = openclawMaterializerDispatcher({
      store: newStore(),
      actor,
      stateDir,
    });
    expect(typeof dispatcher).toBe('function');
    expect(() => dispatcher('notAnOperation', { body: {}, params: {}, query: {}, actor, requestId: 'r' })).toThrow(
      /unsupported/i,
    );
  });
});
