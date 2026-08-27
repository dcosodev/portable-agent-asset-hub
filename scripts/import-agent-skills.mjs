#!/usr/bin/env node
// scripts/import-agent-skills.mjs
//
// Phase 2 skill pack import CLI.
//
// Contract:
//
//   * Default mode is `--preview`: the CLI runs the storage-files
//     `SkillPackImporter.scan` and writes a deterministic JSON
//     preview to `--preview-output`. The preview never carries
//     bodies, base64-encoded bytes or absolute paths; only counts,
//     ids, hashes and relative paths under each package.
//   * `--apply` requires an explicit `--reviewed-digest` that must
//     match the freshly computed `planDigest`. The CLI refuses to
//     run `--apply` without the digest and returns exit code 2.
//   * The preview/result JSON files are written atomically and
//     chmod 0600.
//   * stdout carries bounded summary JSON only; stderr is the
//     redacted diagnostic channel. Exit codes are 0 (success),
//     1 (validation/fingerprint fail), 2 (usage error).
//   * Bodies / base64 / absolute paths are NEVER echoed in preview
//     stdout. Values from secret hits are NEVER echoed in stderr.
//
// The CLI imports compiled packages; you MUST run `pnpm run build`
// before invoking it. The package version of `node:fs` is used
// directly so we never depend on the source TS surface.

import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { argv, exit, stderr, stdout } from 'node:process';

import { createActorContext, HubError } from '@portable-agent-asset-hub/core';
import { SkillPackApplyCoordinator } from '@portable-agent-asset-hub/storage-sqlite';
import { SkillPackImporter, readInventory, readRootsConfig } from '@portable-agent-asset-hub/storage-files';

const REPO_ROOT = new URL('..', import.meta.url).pathname;

const USAGE = [
  'usage: import-agent-skills.mjs \\',
  '  --roots-config <path> --inventory <path> \\',
  '  [--db <path> --backup-dir <path>] \\',
  '  [--preview-output <path>] [--apply --reviewed-digest <hex>] \\',
  '  [--user-id usr_local --agent-id agt_local]',
].join('\n');

function parseCli(argvList) {
  let rootsConfig;
  let inventory;
  let db;
  let backupDir;
  let previewOutput;
  let apply = false;
  let reviewedDigest;
  let userId = 'usr_local';
  let agentId = 'agt_local';
  for (let index = 0; index < argvList.length; index += 1) {
    const arg = argvList[index];
    const next = argvList[index + 1];
    const takeValue = (flag, label) => {
      if (typeof next !== 'string') throw new Error(`${flag} requires <${label}>`);
      index += 1;
      return next;
    };
    if (arg === '--roots-config') rootsConfig = takeValue('--roots-config', 'path');
    else if (arg === '--inventory') inventory = takeValue('--inventory', 'path');
    else if (arg === '--db') db = takeValue('--db', 'path');
    else if (arg === '--backup-dir') backupDir = takeValue('--backup-dir', 'path');
    else if (arg === '--preview-output') previewOutput = takeValue('--preview-output', 'path');
    else if (arg === '--apply') apply = true;
    else if (arg === '--reviewed-digest') reviewedDigest = takeValue('--reviewed-digest', 'hex');
    else if (arg === '--user-id') userId = takeValue('--user-id', 'id');
    else if (arg === '--agent-id') agentId = takeValue('--agent-id', 'id');
    else if (arg === '--help' || arg === '-h') throw new Error('');
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!rootsConfig) throw new Error('--roots-config is required');
  if (!inventory) throw new Error('--inventory is required');
  if (apply && !reviewedDigest) throw new Error('--apply requires --reviewed-digest');
  if (apply && (!db || !backupDir)) throw new Error('--apply requires --db and --backup-dir');
  return {
    rootsConfig: resolve(rootsConfig),
    inventory: resolve(inventory),
    ...(db !== undefined ? { db: resolve(db) } : {}),
    ...(backupDir !== undefined ? { backupDir: resolve(backupDir) } : {}),
    previewOutput: resolve(previewOutput ?? `${REPO_ROOT}artifacts/s2-import-preview-${Date.now()}.json`),
    apply,
    ...(reviewedDigest !== undefined ? { reviewedDigest } : {}),
    userId,
    agentId,
  };
}

/**
 * Redacts concrete assignments and well-known token formats so the
 * secret value never reaches stderr. The patterns are conservative
 * placeholders — we never emit the matched fragment.
 */
function redact(input) {
  return String(input)
    .replaceAll(/(secret|access[_-]?token|client[_-]?secret|api[_-]?key|token|password)\s*[:=]\s*["']?([^\s"',;]{24,})/giu, '$1=<redacted>')
    .replaceAll(/AKIA[0-9A-Z]{16}/g, 'AKIA<redacted>')
    .replaceAll(/gh[psoru]_[A-Za-z0-9]{30,}/g, 'gh<redacted>')
    .replaceAll(/\bsk-[A-Za-z0-9_-]{32,}\b/g, 'sk-<redacted>')
    .replaceAll(/sk_live_[A-Za-z0-9]{20,}/g, 'sk_live_<redacted>')
    .replaceAll(/xox[abprs]-[A-Za-z0-9-]{10,}/g, 'xox<redacted>')
    .replaceAll(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, '<private-key-redacted>');
}

/**
 * Atomic write to `path` with mode 0600. Throws on `EEXIST` so callers
 * can detect collisions. Temporary files are removed on failure.
 */
function atomicWrite0600(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, `${content}\n`, { mode: 0o600 });
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  } finally {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best effort
    }
  }
}

function emitSummary(payload) {
  stdout.write(`${JSON.stringify(payload)}\n`);
}

async function main() {
  const args = parseCli(argv.slice(2));

  const inventory = readInventory(args.inventory);
  // Pre-flight so the CLI surfaces missing/garbage inputs as usage
  // errors rather than as deep HubErrors.
  readRootsConfig(args.rootsConfig);

  if (!args.apply) {
    const importer = new SkillPackImporter();
    const { plan } = importer.scan({
      rootsConfigPath: args.rootsConfig,
      inventoryPath: args.inventory,
    });
    atomicWrite0600(args.previewOutput, JSON.stringify(plan, null, 2));
    emitSummary({
      mode: 'preview',
      planDigest: plan.planDigest,
      inventoryDigest: plan.inventoryDigest,
      scope: plan.scope,
      profile: plan.profile,
      counts: plan.counts,
    });
    exit(0);
    return;
  }

  const actor = createActorContext({
    userId: args.userId,
    agentId: args.agentId,
    role: 'admin',
    capabilities: ['write.skill', 'admin'],
  });
  const coord = new SkillPackApplyCoordinator({
    dbPath: args.db,
    backupDir: args.backupDir,
    rootsConfigPath: args.rootsConfig,
    inventoryPath: args.inventory,
    actor,
  });
  const result = await coord.apply(args.reviewedDigest);
  atomicWrite0600(
    args.previewOutput,
    JSON.stringify(
      {
        mode: 'apply',
        inventory: { schemaVersion: inventory.schemaVersion, inventoryDigest: inventory.inventoryDigest },
        result,
      },
      null,
      2,
    ),
  );
  emitSummary({
    mode: 'apply',
    outcomes: result.outcomes,
    backup: { path: result.backup.path, sha256: result.backup.sha256 },
    appliedAt: result.appliedAt,
  });
  exit(0);
}

main().catch((error) => {
  const redacted = redact(error instanceof Error ? `${error.message}` : String(error));
  if (error instanceof Error && /requires|unknown|--apply|--roots|--inventory|usage/i.test(error.message)) {
    if (redacted) stderr.write(`${redacted}\n`);
    stderr.write(`${USAGE}\n`);
    exit(2);
    return;
  }
  if (error instanceof HubError) {
    stderr.write(`error: ${error.code}/${error.status} ${redacted}\n`);
    exit(1);
    return;
  }
  stderr.write(`error: INTERNAL/500 ${redacted}\n`);
  exit(1);
});
