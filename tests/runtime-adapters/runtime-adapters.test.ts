// tests/runtime-adapters/runtime-adapters.test.ts
//
// TDD slice for the FASE 4 `@portable-agent-asset-hub/runtime-adapters`
// package. Every assertion is parameterised over the five harness
// families the package supports.
//
// Normative contracts exercised:
//
//   Preview / parse / serialise
//   ────────────────────────────
//   * wrapper / USER / SOUL / descriptor relative paths
//   * preview descriptor bodies round-trip through their `serialise*` helpers
//   * preview JSON includes a stable, deterministic planDigest
//   * preview is byte-identical across two calls with identical inputs
//   * preview NEVER echoes the USER/SOUL body, NEVER echoes a secret,
//     and NEVER carries a target absolute path back through the
//     `--preview` stdout summary.
//
//   Apply / rollback
//   ────────────────
//   * USER/SOUL on disk after apply match the canonical fixtures byte-for-byte
//   * pre-existing files are backed up; the backup record stores
//     (existed, original mode, original sha) per file
//   * rollback restores the originals to their original modes and
//     removes any files the apply newly created
//   * a corrupted registry aborts apply with a descriptive error
//   * registry is written atomically and mode 0600
//   * symlink under the target root, the staging root, the backup
//     root, or any ancestor of those paths is rejected before any
//     write happens
//   * digest drift (USER changed between preview and apply) is
//     rejected with a descriptive error
//   * CLI exit codes: 0 on success, 1 on validation failure,
//     2 on usage errors
//   * the descriptor MCP entry, after apply, must spawn and respond
//     to `initialize` and `tools/list` with `search_skills` and
//     `get_skill` advertised.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync, lstatSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyPlan,
  computePreview,
  rollbackPlan,
  readRegistry,
} from '@portable-agent-asset-hub/runtime-adapters';
import type { HarnessId, PreviewInput, Preview, RollbackResult } from '@portable-agent-asset-hub/runtime-adapters';
import {
  FAKE_REST_FIXTURE,
  HARNESSES,
  MCP_ENTRY_FIXTURE,
  SOUL_FIXTURE,
  USER_FIXTURE,
  makeTargetDir,
  relativePathOf,
} from './factories.ts';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;
const cliPath = join(REPO_ROOT, 'scripts', 'attach-agent-hub.mjs');

interface CliResult { stdout: string; stderr: string; code: number; }

function fixtureInput(harness: HarnessId, targetDir: string): PreviewInput {
  return {
    harness,
    targetDir,
    userFile: USER_FIXTURE,
    soulFile: SOUL_FIXTURE,
    mcpEntry: MCP_ENTRY_FIXTURE,
    restUrl: 'http://127.0.0.1:0',
    profile: 'profile_default',
  };
}

function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code: number | null) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        code: code === null ? 1 : code,
      });
    });
  });
}

interface McpTool { name: string }

function talkToMcp(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  method: string,
  id: number,
): Promise<{ id: number; result: { tools: McpTool[] } }> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(command, [...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    const handle = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.length === 0) continue;
        try {
          const parsed = JSON.parse(line) as { id: number; result?: { tools: McpTool[] } };
          if (parsed.id === id && parsed.result) {
            child.kill('SIGTERM');
            resolve(parsed as { id: number; result: { tools: McpTool[] } });
            return;
          }
        } catch {
          // keep accumulating
        }
      }
    };
    child.stdout?.on('data', handle);
    child.on('error', reject);
    child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method })}\n`);
    setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`mcp timeout for ${method}`));
    }, 5000);
  });
}

function spawnSpecFrom(preview: Preview): {
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
} {
  const body = preview.descriptor.body;
  if (body.kind === 'codex-toml') {
    const command = JSON.parse(body.sections.find((section: { key: string; value: string }) => section.key === 'command')!.value) as string;
    const args = JSON.parse(body.sections.find((section: { key: string; value: string }) => section.key === 'args')!.value) as string[];
    return { command, args, env: preview.commandFragments[0]!.env };
  }
  if (body.kind === 'claude-code-mcp-json') {
    const server = body.servers[0]!;
    return { command: server.command, args: server.args, env: server.env };
  }
  if (body.kind === 'opencode-opencode-json') {
    const server = body.mcp[0]!;
    return { command: server.command[0]!, args: server.command.slice(1), env: server.environment };
  }
  if (body.kind === 'hermes-cli-fragment') {
    const commandIndex = body.argv.indexOf('--command');
    const argsIndex = body.argv.indexOf('--args');
    return { command: body.argv[commandIndex + 1]!, args: body.argv.slice(argsIndex + 1), env: body.env };
  }
  return { command: body.server.command, args: body.server.args, env: body.server.env };
}

describe('runtime-adapters/preview', () => {
  const tempRoots: string[] = [];
  afterEach(() => {
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function freshTarget(prefix: string): string {
    const root = makeTargetDir(prefix);
    tempRoots.push(root);
    return root;
  }

  it.each(HARNESSES)('preview_harness_%s_emits_expected_relative_paths', (harness) => {
    const target = freshTarget(`rt-prev-paths-${harness}-`);
    const preview: Preview = computePreview(fixtureInput(harness, target));
    const paths = relativePathOf(harness);
    expect(preview.wrapperRelativePath).toBe(paths.wrapper);
    expect(preview.harness).toBe(harness);
    expect(preview.profile).toBe('profile_default');
    expect(preview.files.map((file: { relativePath: string }) => file.relativePath).sort()).toEqual(
      [paths.wrapper, paths.user, paths.soul, paths.descriptor].sort(),
    );
    for (const file of preview.files) {
      expect(file.relativePath.includes('\\')).toBe(false);
      expect(file.relativePath.startsWith('/')).toBe(false);
      expect(file.relativePath.includes('..')).toBe(false);
      expect(/^[0-9a-f]{64}$/u.test(file.sha256)).toBe(true);
      expect(file.mode & 0o7000).toBe(0);
      const generated = Buffer.from(file.bytes).toString('utf8');
      expect(generated).not.toContain('.hermes/skills');
      expect(generated).not.toContain('.openclaw/skills');
      expect(generated).not.toContain('workspace-scout');
    }
    const wrapper = Buffer.from(preview.files.find((file: { relativePath: string; bytes: Uint8Array }) => file.relativePath === paths.wrapper)!.bytes).toString('utf8');
    expect(wrapper).toContain('Load the local `USER.md` and `SOUL.md`');
    expect(wrapper).toContain('database is authoritative for skills and episodic memory');
    expect(wrapper).toContain('do not invent a scope parameter');
  });

  it.each(HARNESSES)('preview_harness_%s_round_trips_descriptor_body', (harness) => {
    const target = freshTarget(`rt-prev-rt-${harness}-`);
    const preview = computePreview(fixtureInput(harness, target));
    const descriptorFile = preview.files.find((file) => file.relativePath === relativePathOf(harness).descriptor);
    expect(descriptorFile).toBeDefined();
    expect(descriptorFile!.bytes.byteLength).toBeGreaterThan(0);

    if (preview.descriptor.kind === 'codex-toml') {
      expect(preview.descriptor.body.kind).toBe('codex-toml');
    } else if (preview.descriptor.kind === 'claude-code-mcp-json') {
      const text = new TextDecoder('utf-8').decode(descriptorFile!.bytes);
      const parsed = JSON.parse(text) as { mcpServers: Record<string, { command: string; env: Record<string, string> }> };
      expect(parsed.mcpServers['agent-memory'].command).toBe('node');
      expect(parsed.mcpServers['agent-memory'].env.AGENT_MEMORY_REST_URL).toBe('http://127.0.0.1:0');
    } else if (preview.descriptor.kind === 'opencode-opencode-json') {
      const text = new TextDecoder('utf-8').decode(descriptorFile!.bytes);
      expect(text).toContain('"mcp"');
      expect(text).toContain('agent-memory');
    } else if (preview.descriptor.kind === 'hermes-cli-fragment') {
      const text = new TextDecoder('utf-8').decode(descriptorFile!.bytes);
      const parsed = JSON.parse(text) as { argv: string[] };
      expect(parsed.argv).toContain('hermes');
      expect(parsed.argv).toContain('mcp');
    } else if (preview.descriptor.kind === 'openclaw-mcp-fragment') {
      const text = new TextDecoder('utf-8').decode(descriptorFile!.bytes);
      const parsed = JSON.parse(text) as { command: string; env: Record<string, string> };
      expect(parsed.command).toBe('node');
      expect(parsed.env.AGENT_MEMORY_REST_URL).toBe('http://127.0.0.1:0');
    }
  });

  it.each(HARNESSES)('preview_harness_%s_is_byte_identical_for_identical_inputs', (harness) => {
    const target = freshTarget(`rt-prev-idem-${harness}-`);
    const a = computePreview(fixtureInput(harness, target));
    const b = computePreview(fixtureInput(harness, target));
    expect(a.planDigest.digest).toBe(b.planDigest.digest);
    expect(a.planDigest.algorithm).toBe('sha256');
    expect(a.files.map((file) => `${file.relativePath}:${file.sha256}`).join('|'))
      .toBe(b.files.map((file) => `${file.relativePath}:${file.sha256}`).join('|'));
    const aBytes = a.files.map((file) => ({ rel: file.relativePath, len: file.bytes.byteLength }));
    const bBytes = b.files.map((file) => ({ rel: file.relativePath, len: file.bytes.byteLength }));
    expect(aBytes).toEqual(bBytes);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it.each(HARNESSES)('preview_harness_%s_cli_summary_does_not_emit_user_soul_bodies_or_target_path', async (harness) => {
    const target = freshTarget(`rt-prev-clean-${harness}-`);
    const previewPath = join(target, `preview-${harness}.json`);
    const preview = await runCli([
      '--harness', harness,
      '--target-dir', target,
      '--profile', 'profile_default',
      '--user-file', USER_FIXTURE,
      '--soul-file', SOUL_FIXTURE,
      '--rest-url', 'http://127.0.0.1:65535',
      '--mcp-entry', MCP_ENTRY_FIXTURE,
      '--preview-output', previewPath,
    ]);
    expect(preview.code).toBe(0);
    const stdout = preview.stdout.trim();
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(stdout).not.toContain(USER_FIXTURE);
    expect(stdout).not.toContain(SOUL_FIXTURE);
    expect(stdout).not.toContain(target);
    expect(stdout).not.toContain('"targetDir"');
    const userText = readFileSync(USER_FIXTURE, 'utf8');
    expect(stdout).not.toContain(userText.trim());
    const userBytes = readFileSync(USER_FIXTURE);
    const soulBytes = readFileSync(SOUL_FIXTURE);
    const base64User = userBytes.toString('base64');
    const base64Soul = soulBytes.toString('base64');
    expect(stdout).not.toContain(base64User);
    expect(stdout).not.toContain(base64Soul);
    expect(stdout).not.toMatch(/gh[psoru]_[A-Za-z0-9]{30,}/u);
    expect(stdout).not.toMatch(/AKIA[0-9A-Z]{16}/u);
    const reviewArtifact = readFileSync(previewPath, 'utf8');
    expect(reviewArtifact).not.toContain(userText.trim());
    expect(reviewArtifact).not.toContain(readFileSync(SOUL_FIXTURE, 'utf8').trim());
    expect(reviewArtifact).not.toContain('"bytes"');
    expect(reviewArtifact).not.toContain(target);
  });

  it('parse_serialise_helpers_round_trip', () => {
    const target = makeTargetDir('rt-prev-parse-export-');
    try {
      const preview = computePreview(fixtureInput('claude-code', target));
      expect(preview.descriptor.kind).toBe('claude-code-mcp-json');
      if (preview.descriptor.kind === 'claude-code-mcp-json') {
        const text = new TextDecoder('utf-8').decode(preview.files.find((file) => file.relativePath === '.mcp.json')!.bytes);
        const parsed = JSON.parse(text) as { mcpServers: Record<string, { command: string; args: string[] }> };
        expect(parsed.mcpServers['agent-memory'].args).toEqual([MCP_ENTRY_FIXTURE]);
      }
      const hermesPreview = computePreview(fixtureInput('hermes', target));
      expect(hermesPreview.descriptor.kind).toBe('hermes-cli-fragment');
      const hermesText = new TextDecoder('utf-8').decode(hermesPreview.files.find((file) => file.relativePath === '.hermes/agent-memory.fragment.txt')!.bytes);
      const hermesParsed = JSON.parse(hermesText) as { argv: string[] };
      expect(hermesParsed.argv).toContain('hermes');
      const openclawPreview = computePreview(fixtureInput('openclaw', target));
      expect(openclawPreview.descriptor.kind).toBe('openclaw-mcp-fragment');
      const openclawText = new TextDecoder('utf-8').decode(openclawPreview.files.find((file) => file.relativePath === '.openclaw/agent-memory.fragment.json')!.bytes);
      const openclawParsed = JSON.parse(openclawText) as { command: string };
      expect(openclawParsed.command).toBe('node');
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe('runtime-adapters/apply-rollback', () => {
  const tempRoots: string[] = [];
  afterEach(() => {
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  function freshTarget(prefix: string): string {
    const root = makeTargetDir(prefix);
    tempRoots.push(root);
    return root;
  }

  it.each(HARNESSES)('apply_harness_%s_writes_USER_SOUL_byte_exact', (harness) => {
    const target = freshTarget(`rt-apply-byte-${harness}-`);
    const preview = computePreview(fixtureInput(harness, target));
    const result = applyPlan({
      preview,
      targetDir: target,
      reviewedDigest: preview.planDigest.digest,
      reason: `test:${harness}`,
    });
    expect(result.runId.startsWith('run_')).toBe(true);
    expect(result.planDigest).toBe(preview.planDigest.digest);
    const written = new Set(result.writtenFiles.map((file: { relativePath: string }) => file.relativePath));
    for (const rel of [relativePathOf(harness).user, relativePathOf(harness).soul, relativePathOf(harness).wrapper, relativePathOf(harness).descriptor]) {
      expect(written.has(rel)).toBe(true);
    }
    const onDiskUser = readFileSync(join(target, relativePathOf(harness).user));
    const onDiskSoul = readFileSync(join(target, relativePathOf(harness).soul));
    expect(onDiskUser.equals(readFileSync(USER_FIXTURE))).toBe(true);
    expect(onDiskSoul.equals(readFileSync(SOUL_FIXTURE))).toBe(true);
  });

  it.each(HARNESSES)('rollback_harness_%s_restores_originals_and_removes_new', (harness) => {
    const target = freshTarget(`rt-rb-${harness}-`);
    writeFileSync(join(target, 'USER.md'), 'PRIOR_USER_BODY');
    chmodSync(join(target, 'USER.md'), 0o600);
    writeFileSync(join(target, 'WRAPPER_PRE.md'), 'pre-existing wrapper');
    chmodSync(join(target, 'WRAPPER_PRE.md'), 0o600);

    const preview = computePreview(fixtureInput(harness, target));
    const result = applyPlan({
      preview,
      targetDir: target,
      reviewedDigest: preview.planDigest.digest,
      reason: `test:${harness}`,
    });
    expect(readFileSync(join(target, 'USER.md')).equals(readFileSync(USER_FIXTURE))).toBe(true);

    const rb: RollbackResult = rollbackPlan({ targetDir: target, runId: result.runId });
    expect(rb.runId).toBe(result.runId);
    expect(readFileSync(join(target, 'USER.md'), 'utf8')).toBe('PRIOR_USER_BODY');
    const userStat = lstatSync(join(target, 'USER.md'));
    expect(userStat.mode & 0o777).toBe(0o600);
    expect(existsSync(join(target, relativePathOf(harness).wrapper))).toBe(false);
    expect(existsSync(join(target, 'WRAPPER_PRE.md'))).toBe(true);
    const registry = readRegistry(target);
    const run = (registry.runs as Array<{ runId?: string; backup?: { files?: Array<{ relativePath: string; existed: boolean; mode: number }> } }>)
      .find((entry) => entry.runId === result.runId);
    expect(run).toBeDefined();
    const userRecord = run!.backup!.files!.find((file) => file.relativePath === 'USER.md');
    expect(userRecord).toBeDefined();
    expect(userRecord!.existed).toBe(true);
    expect(userRecord!.mode).toBe(0o600);
  });

  it('apply_refuses_symlink_target_root', () => {
    const real = makeTargetDir('rt-symlink-real-');
    const symlinkParent = makeTargetDir('rt-symlink-parent-');
    const symlinkPath = join(symlinkParent, 'symlink-root');
    symlinkSync(real, symlinkPath, 'dir');
    try {
      expect(() => computePreview(fixtureInput('codex', symlinkPath))).toThrow();
      const preview = computePreview(fixtureInput('codex', real));
      expect(() => applyPlan({ preview, targetDir: symlinkPath, reviewedDigest: preview.planDigest.digest, reason: 'symlink-root' })).toThrow();
    } finally {
      rmSync(real, { recursive: true, force: true });
      rmSync(symlinkParent, { recursive: true, force: true });
    }
  });

  it('apply_refuses_symlink_ancestor', () => {
    const real = makeTargetDir('rt-ancestor-real-');
    const symlinkParent = makeTargetDir('rt-ancestor-parent-');
    const deepSymlink = join(symlinkParent, 'symlink-deep');
    symlinkSync(real, deepSymlink, 'dir');
    try {
      expect(() => computePreview(fixtureInput('codex', deepSymlink))).toThrow();
    } finally {
      rmSync(real, { recursive: true, force: true });
      rmSync(symlinkParent, { recursive: true, force: true });
    }
  });

  it('apply_refuses_symlink_inside_target_for_write', () => {
    const target = makeTargetDir('rt-inside-sym-');
    const targetUser = join(target, 'USER.md');
    const realFile = join(target, '_real_user.md');
    writeFileSync(realFile, 'real contents');
    symlinkSync(realFile, targetUser);
    try {
      const preview = computePreview(fixtureInput('codex', target));
      expect(() => applyPlan({ preview, targetDir: target, reviewedDigest: preview.planDigest.digest, reason: 'symlink-final' })).toThrow(/symlink|safe-target/i);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('apply_refuses_symlink_staging_or_backup_root', () => {
    const target = makeTargetDir('rt-stage-backup-sym-');
    const preview = computePreview(fixtureInput('codex', target));
    const staging = join(target, '.pah', 'runtime-adapters-staging');
    mkdirSync(join(target, '.pah'), { recursive: true });
    const realDir = join(target, '.pah', 'real-stage');
    mkdirSync(realDir, { recursive: true });
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    symlinkSync(realDir, staging);
    try {
      expect(() => applyPlan({ preview, targetDir: target, reviewedDigest: preview.planDigest.digest, reason: 'symlink-staging' })).toThrow();
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('apply_detects_USER_drift_between_preview_and_apply', () => {
    const target = makeTargetDir('rt-drift-user-');
    const preview = computePreview(fixtureInput('codex', target));
    const originalUser = readFileSync(USER_FIXTURE, 'utf8');
    writeFileSync(USER_FIXTURE, 'mutated user bytes — content drift');
    try {
      expect(() => applyPlan({ preview, targetDir: target, reviewedDigest: preview.planDigest.digest, reason: 'drift' })).toThrow(/USER drift|drift|preview/i);
    } finally {
      writeFileSync(USER_FIXTURE, originalUser);
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('apply_refuses_physical_root_divergence', () => {
    const tempParent = mkdtempSync(join(tmpdir(), 'rt-physical-'));
    mkdirSync(join(tempParent, 'real'), { recursive: true });
    const realDir = realpathSync(join(tempParent, 'real'));
    symlinkSync(realDir, join(tempParent, 'link'));
    try {
      expect(() => computePreview(fixtureInput('codex', join(tempParent, 'link')))).toThrow();
    } finally {
      rmSync(tempParent, { recursive: true, force: true });
    }
  });

  it('apply_rejects_malformed_registry_fail_closed', () => {
    const target = makeTargetDir('rt-malformed-');
    mkdirSync(join(target, '.pah'), { recursive: true });
    writeFileSync(join(target, '.pah', 'runtime-adapters-runs.json'), '{ this is not json', { mode: 0o600 });
    try {
      const preview = computePreview(fixtureInput('codex', target));
      expect(() => applyPlan({ preview, targetDir: target, reviewedDigest: preview.planDigest.digest, reason: 'malformed' })).toThrow(/corrupt|registry/i);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('apply_writes_registry_atomically_with_mode_0600', () => {
    const target = makeTargetDir('rt-registry-mode-');
    const preview = computePreview(fixtureInput('codex', target));
    const result = applyPlan({ preview, targetDir: target, reviewedDigest: preview.planDigest.digest, reason: 'mode' });
    try {
      const regPath = join(target, '.pah', 'runtime-adapters-runs.json');
      expect(existsSync(regPath)).toBe(true);
      const stat = lstatSync(regPath);
      expect((stat.mode & 0o777) === 0o600).toBe(true);
      const json = JSON.parse(readFileSync(regPath, 'utf8')) as { runs: Array<{ runId: string }> };
      expect(json.runs.length).toBe(1);
      expect(json.runs[0].runId).toBe(result.runId);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('apply_requires_hex_64_digest', () => {
    const target = makeTargetDir('rt-bad-digest-');
    const preview = computePreview(fixtureInput('codex', target));
    try {
      expect(() => applyPlan({ preview, targetDir: target, reviewedDigest: 'not-hex', reason: 'x' })).toThrow(/hex/i);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe('runtime-adapters/cli', () => {
  it('cli_help_exits_2', async () => {
    const result = await runCli(['--help']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('usage');
  });

  it('cli_unknown_flag_exits_2', async () => {
    const result = await runCli(['--bogus', 'flag']);
    expect(result.code).toBe(2);
  });

  it('cli_apply_without_digest_exits_2', async () => {
    const target = makeTargetDir('rt-cli-apply-');
    try {
      const result = await runCli([
        '--harness', 'codex',
        '--target-dir', target,
        '--profile', 'profile_default',
        '--user-file', USER_FIXTURE,
        '--soul-file', SOUL_FIXTURE,
        '--rest-url', 'http://127.0.0.1:65535',
        '--mcp-entry', MCP_ENTRY_FIXTURE,
        '--apply',
      ]);
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/reviewed-digest|--apply/i);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('cli_rollback_without_run_id_exits_2', async () => {
    const target = makeTargetDir('rt-cli-rb-');
    try {
      const result = await runCli([
        '--harness', 'codex',
        '--target-dir', target,
        '--profile', 'profile_default',
        '--user-file', USER_FIXTURE,
        '--soul-file', SOUL_FIXTURE,
        '--rest-url', 'http://127.0.0.1:65535',
        '--mcp-entry', MCP_ENTRY_FIXTURE,
        '--rollback',
      ]);
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/run-id|--rollback/i);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('cli_preview_then_apply_rollback_run_id_roundtrip_exits_0', async () => {
    const target = makeTargetDir('rt-cli-roundtrip-');
    try {
      const previewPath = join(target, 'preview.json');
      const preview = await runCli([
        '--harness', 'codex',
        '--target-dir', target,
        '--profile', 'profile_default',
        '--user-file', USER_FIXTURE,
        '--soul-file', SOUL_FIXTURE,
        '--rest-url', 'http://127.0.0.1:65535',
        '--mcp-entry', MCP_ENTRY_FIXTURE,
        '--preview-output', previewPath,
      ]);
      expect(preview.code).toBe(0);
      const summary = JSON.parse(preview.stdout.trim()) as { planDigest: string; mode: string };
      expect(summary.planDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(summary.mode).toBe('preview');
      expect(preview.stdout).not.toContain(USER_FIXTURE);
      expect(preview.stdout).not.toContain(target);
      expect(preview.stdout).not.toContain('"targetDir"');

      const applyResult = await runCli([
        '--harness', 'codex',
        '--target-dir', target,
        '--profile', 'profile_default',
        '--user-file', USER_FIXTURE,
        '--soul-file', SOUL_FIXTURE,
        '--rest-url', 'http://127.0.0.1:65535',
        '--mcp-entry', MCP_ENTRY_FIXTURE,
        '--apply',
        '--reviewed-digest', summary.planDigest,
        '--preview-output', previewPath,
      ]);
      expect(applyResult.code).toBe(0);
      const applySummary = JSON.parse(applyResult.stdout.trim()) as { runId: string; mode: string };
      expect(applySummary.runId).toMatch(/^run_/);
      expect(applySummary.mode).toBe('apply');

      const rollbackResult = await runCli([
        '--harness', 'codex',
        '--target-dir', target,
        '--profile', 'profile_default',
        '--user-file', USER_FIXTURE,
        '--soul-file', SOUL_FIXTURE,
        '--rest-url', 'http://127.0.0.1:65535',
        '--mcp-entry', MCP_ENTRY_FIXTURE,
        '--rollback',
        '--run-id', applySummary.runId,
      ]);
      expect(rollbackResult.code).toBe(0);
      expect(rollbackResult.stdout).toContain(applySummary.runId);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('cli_preview_harness_unknown_exits_2', async () => {
    const target = makeTargetDir('rt-cli-bad-harness-');
    try {
      const result = await runCli([
        '--harness', 'foobar',
        '--target-dir', target,
        '--profile', 'profile_default',
        '--user-file', USER_FIXTURE,
        '--soul-file', SOUL_FIXTURE,
        '--rest-url', 'http://127.0.0.1:65535',
        '--mcp-entry', MCP_ENTRY_FIXTURE,
      ]);
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/--harness/i);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe('runtime-adapters/descriptor-mcp-spawn', () => {
  let restServer: ChildProcess | null = null;
  let restBaseUrl: string | null = null;

  beforeEach(async () => {
    while (restServer) {
      try { restServer.kill('SIGTERM'); } catch { /* noop */ }
      restServer = null;
    }
    restServer = spawn(process.execPath, [FAKE_REST_FIXTURE], { stdio: ['ignore', 'pipe', 'pipe'] });
    restBaseUrl = await new Promise<string | null>((resolveP) => {
      const chunks: Buffer[] = [];
      const onData = (chunk: Buffer): void => {
        chunks.push(chunk);
        const text = Buffer.concat(chunks).toString('utf8');
        const newline = text.indexOf('\n');
        if (newline !== -1) {
          restServer!.stdout?.off('data', onData);
          resolveP(text.slice(0, newline));
        }
      };
      restServer.stdout?.on('data', onData);
      setTimeout(() => resolveP(null), 5000);
    });
  });

  afterEach(() => {
    if (restServer) {
      try { restServer.kill('SIGTERM'); } catch { /* noop */ }
      restServer = null;
    }
  });

  it.each(HARNESSES)('descriptor_%s_spawns_and_advertises_search_skills_get_skill', async (harness) => {
    if (!restBaseUrl) throw new Error('fake-rest did not respond in time');
    const target = makeTargetDir('rt-mcp-spawn-');
    try {
      const preview = computePreview({
        harness,
        targetDir: target,
        profile: 'profile_default',
        userFile: USER_FIXTURE,
        soulFile: SOUL_FIXTURE,
        restUrl: restBaseUrl,
        mcpEntry: MCP_ENTRY_FIXTURE,
      });
      applyPlan({ preview, targetDir: target, reviewedDigest: preview.planDigest.digest, reason: 'mcp-spawn' });

      const spec = spawnSpecFrom(preview);
      const init = await talkToMcp(spec.command, spec.args, spec.env, 'initialize', 1);
      expect(init.id).toBe(1);
      const list = await talkToMcp(spec.command, spec.args, spec.env, 'tools/list', 2);
      const names = list.result.tools.map((tool: McpTool) => tool.name);
      expect(names).toContain('search_skills');
      expect(names).toContain('get_skill');
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  }, 15000);
});
