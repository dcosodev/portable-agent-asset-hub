#!/usr/bin/env node
// scripts/attach-agent-hub.mjs
//
// FASE 4 CLI: attaches an agent-memory hub to a target agent
// directory by rendering the per-harness wrapper, USER/SOUL copy,
// and MCP descriptor. Preview by default; --apply requires an
// explicit --reviewed-digest; --rollback requires --run-id.
//
// Contract:
//
//   * Default mode is preview. The preview JSON is written to
//     --preview-output (defaults to `./artifacts/fase4-preview.json`)
//     atomically and with mode 0600. The preview contains sha256 +
//     size for USER/SOUL bytes, never the bodies.
//   * `--apply --reviewed-digest <hex>` re-validates the preview,
//     re-scans every input (USER/SOUL/MCP entry/target), and only
//     writes when the digest matches.
//   * `--rollback --run-id <id>` reverses a previous apply by
//     restoring the original files (with original modes) and
//     deleting any newly-created files.
//   * Stdout emits bounded summary JSON only. Stderr is the redacted
//     diagnostic channel. Exit codes are 0 (success), 1 (validation
//     or runtime error), 2 (usage error).
//   * Bodies, base64-encoded bytes, secret tokens, and absolute
//     target paths are NEVER echoed in preview stdout.

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { argv, exit, stderr, stdout } from 'node:process';

import {
  HARNESS_IDS,
  applyPlan,
  computePreview,
  rollbackPlan,
} from '../dist/packages/runtime-adapters/index.js';

const REPO_ROOT = new URL('..', import.meta.url).pathname;

const USAGE = [
  'usage: attach-agent-hub.mjs \\',
  '  --harness <codex|claude-code|opencode|hermes|openclaw> \\',
  '  --target-dir <absolute path> --profile <id> \\',
  '  --user-file <absolute path> --soul-file <absolute path> \\',
  '  --rest-url <url> --mcp-entry <absolute path> \\',
  '  [--agent-id <id>] [--auth-token-file <0600 path>] [--preview-output <path>]',
  '  [--apply --reviewed-digest <hex>] \\',
  '  [--rollback --run-id <id>]',
].join('\n');

const HEX_64 = /^[0-9a-f]{64}$/u;

function parseCli(argvList) {
  let harness;
  let targetDir;
  let profile;
  let userFile;
  let soulFile;
  let restUrl;
  let mcpEntry;
  let agentId;
  let authTokenFile;
  let previewOutput;
  let apply = false;
  let reviewedDigest;
  let rollback = false;
  let runId;
  let reason;

  const takeValue = (flag, label, next) => {
    if (typeof next !== 'string') throw new Error(`${flag} requires <${label}>`);
    return next;
  };

  for (let i = 0; i < argvList.length; i += 1) {
    const arg = argvList[i];
    const next = argvList[i + 1];
    if (arg === '--harness') { harness = takeValue('--harness', 'id', next); i += 1; }
    else if (arg === '--target-dir') { targetDir = takeValue('--target-dir', 'path', next); i += 1; }
    else if (arg === '--profile') { profile = takeValue('--profile', 'id', next); i += 1; }
    else if (arg === '--user-file') { userFile = takeValue('--user-file', 'path', next); i += 1; }
    else if (arg === '--soul-file') { soulFile = takeValue('--soul-file', 'path', next); i += 1; }
    else if (arg === '--rest-url') { restUrl = takeValue('--rest-url', 'url', next); i += 1; }
    else if (arg === '--mcp-entry') { mcpEntry = takeValue('--mcp-entry', 'path', next); i += 1; }
    else if (arg === '--agent-id') { agentId = takeValue('--agent-id', 'id', next); i += 1; }
    else if (arg === '--auth-token-file') { authTokenFile = takeValue('--auth-token-file', 'path', next); i += 1; }
    else if (arg === '--preview-output') { previewOutput = takeValue('--preview-output', 'path', next); i += 1; }
    else if (arg === '--reviewed-digest') { reviewedDigest = takeValue('--reviewed-digest', 'hex', next); i += 1; }
    else if (arg === '--run-id') { runId = takeValue('--run-id', 'id', next); i += 1; }
    else if (arg === '--reason') { reason = takeValue('--reason', 'text', next); i += 1; }
    else if (arg === '--apply') { apply = true; }
    else if (arg === '--rollback') { rollback = true; }
    else if (arg === '--help' || arg === '-h') throw new Error('');
    else throw new Error(`unknown argument: ${arg}`);
  }

  if (!harness) throw new Error('--harness is required');
  if (!HARNESS_IDS.includes(harness)) {
    throw new Error(`--harness must be one of: ${HARNESS_IDS.join(', ')}`);
  }
  if (!targetDir) throw new Error('--target-dir is required');
  if (!profile) throw new Error('--profile is required');
  if (!userFile) throw new Error('--user-file is required');
  if (!soulFile) throw new Error('--soul-file is required');
  if (!restUrl) throw new Error('--rest-url is required');
  if (!mcpEntry) throw new Error('--mcp-entry is required');
  if (apply && rollback) throw new Error('--apply and --rollback are mutually exclusive');
  if (apply && !reviewedDigest) throw new Error('--apply requires --reviewed-digest <hex>');
  if (rollback && !runId) throw new Error('--rollback requires --run-id <id>');
  if (rollback && (!targetDir)) throw new Error('--rollback requires --target-dir');
  if (reviewedDigest !== undefined && !HEX_64.test(reviewedDigest)) {
    throw new Error('--reviewed-digest must be a 64-char hex string');
  }

  return {
    harness,
    targetDir: resolve(targetDir),
    profile,
    userFile: resolve(userFile),
    soulFile: resolve(soulFile),
    restUrl,
    mcpEntry: resolve(mcpEntry),
    agentId,
    authTokenFile: authTokenFile ? resolve(authTokenFile) : undefined,
    previewOutput: previewOutput ? resolve(previewOutput) : undefined,
    apply,
    reviewedDigest,
    rollback,
    runId,
    reason: reason ?? 'manual',
  };
}

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

function previewSummaryFor(preview) {
  // Bounded summary only. No USER/SOUL bodies, no base64, no
  // absolute target path on stdout. The planDigest is what an
  // operator will paste back into `--apply --reviewed-digest`.
  return {
    mode: 'preview',
    harness: preview.harness,
    profile: preview.profile,
    agentId: preview.agentId,
    planDigest: preview.planDigest.digest,
    planDigestAlgorithm: preview.planDigest.algorithm,
    canonicalisedAt: preview.planDigest.canonicalisedAt,
    wrapperRelativePath: preview.wrapperRelativePath,
    fileCount: preview.files.length,
    files: preview.files.map((file) => ({
      relativePath: file.relativePath,
      sha256: file.sha256,
      size: file.size,
      mode: file.mode,
      sourceRef: file.sourceRef,
    })),
    descriptorKind: preview.descriptor.kind,
    descriptorRelativePath: preview.descriptor.relativePath,
    commandFragments: preview.commandFragments.map((fragment) => ({
      label: fragment.label,
      argv: fragment.argv,
      env: fragment.env,
    })),
    restUrl: preview.restUrl,
    // The mcp entry is reported by logical identifier (path). It is
    // an absolute path the operator already knows; not a secret.
    mcpEntry: preview.mcpEntry,
  };
}

function safePreviewFor(preview) {
  // Drop the absolute targetDir so it never reaches stdout; tests
  // and operators can rely on `targetDir` being absent from the
  // preview summary.
  const summary = previewSummaryFor(preview);
  delete summary.targetDir;
  return summary;
}

function loadPreviewFromDisk(path) {
  if (!existsSync(path)) throw new Error(`preview file not found: ${path}`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`preview file is a symlink: ${path}`);
  if (!stat.isFile()) throw new Error(`preview file is not a regular file: ${path}`);
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw);
}

function isApplyInputObject(value) {
  return !!value && typeof value === 'object';
}

async function main() {
  const args = parseCli(argv.slice(2));

  if (args.rollback) {
    const result = rollbackPlan({ targetDir: args.targetDir, runId: args.runId, reason: args.reason });
    atomicWrite0600(
      args.previewOutput ?? resolve(`${REPO_ROOT}artifacts/fase4-rollback.json`),
      JSON.stringify({ mode: 'rollback', runId: args.runId, ...result }, null, 2),
    );
    emitSummary({
      mode: 'rollback',
      runId: args.runId,
      restoredFiles: result.restoredFiles,
      removedFiles: result.removedFiles,
      finishedAt: result.finishedAt,
    });
    exit(0);
    return;
  }

  if (!args.apply) {
    // preview mode: never imports USER/SOUL/MCP bodies into stdout.
    // USER/SOUL bytes are summarised by sha256 + size; mcpEntry
    // path is allowed because the operator supplied it.
    const preview = computePreview({
      harness: args.harness,
      targetDir: args.targetDir,
      profile: args.profile,
      userFile: args.userFile,
      soulFile: args.soulFile,
      restUrl: args.restUrl,
      mcpEntry: args.mcpEntry,
      ...(args.agentId !== undefined ? { agentId: args.agentId } : {}),
      ...(args.authTokenFile !== undefined ? { authTokenFile: args.authTokenFile } : {}),
    });
    const outputPath = args.previewOutput ?? resolve(`${REPO_ROOT}artifacts/fase4-preview.json`);
    const reviewArtifact = safePreviewFor(preview);
    atomicWrite0600(outputPath, JSON.stringify(reviewArtifact, null, 2));
    emitSummary(reviewArtifact);
    exit(0);
    return;
  }

  // --apply path.
  const sourcePath = args.previewOutput ?? resolve(`${REPO_ROOT}artifacts/fase4-preview.json`);
  const preview = loadPreviewFromDisk(sourcePath);
  if (!isApplyInputObject(preview)) throw new Error('preview file is not an object');
  // Drift detection: rebuild the preview from current inputs and
  // require byte-identical planDigest + every file digest. Never
  // trust the bytes persisted to disk for USER/SOUL.
  const recomputed = computePreview({
    harness: args.harness,
    targetDir: args.targetDir,
    profile: args.profile,
    userFile: args.userFile,
    soulFile: args.soulFile,
    restUrl: args.restUrl,
    mcpEntry: args.mcpEntry,
    ...(args.agentId !== undefined ? { agentId: args.agentId } : {}),
    ...(args.authTokenFile !== undefined ? { authTokenFile: args.authTokenFile } : {}),
  });
  if (recomputed.planDigest.digest !== args.reviewedDigest) {
    throw new Error(`reviewedDigest drift: ${args.reviewedDigest} vs ${recomputed.planDigest.digest}`);
  }
  const persistedDigest = typeof preview.planDigest === 'string'
    ? preview.planDigest
    : preview.planDigest?.digest;
  if (recomputed.planDigest.digest !== persistedDigest) {
    throw new Error('persisted preview digest drift against recomputed preview');
  }
  const persistedFiles = Array.isArray(preview.files) ? preview.files : [];
  if (persistedFiles.length !== recomputed.files.length) {
    throw new Error(`persisted preview file count drift: ${persistedFiles.length} vs ${recomputed.files.length}`);
  }
  for (let i = 0; i < recomputed.files.length; i += 1) {
    const a = recomputed.files[i];
    const b = persistedFiles[i];
    if (a.relativePath !== b.relativePath || a.sha256 !== b.sha256 || a.size !== b.size) {
      throw new Error(`persisted preview file drift at index ${i}: ${a.relativePath}`);
    }
  }

  const result = applyPlan({
    preview: recomputed,
    targetDir: args.targetDir,
    reviewedDigest: args.reviewedDigest,
    reason: args.reason,
  });

  atomicWrite0600(
    `${REPO_ROOT}artifacts/fase4-apply-${result.runId}.json`,
    JSON.stringify({ mode: 'apply', result }, null, 2),
  );
  emitSummary({
    mode: 'apply',
    runId: result.runId,
    planDigest: result.planDigest,
    writtenFiles: result.writtenFiles,
    backupRoot: result.backupRoot,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
  });
  exit(0);
}

main().catch((error) => {
  const redacted = redact(error instanceof Error ? `${error.message}` : String(error));
  const name = error instanceof Error ? error.name : 'Error';
  // `--help` / `-h` / mutually-exclusive flags / missing required
  // values produce a usage error; we route them to exit 2.
  const isUsageHelp = error instanceof Error && error.message === '';
  const isUsage = isUsageHelp || (error instanceof Error && /requires|unknown|--apply|--rollback|--target|--user|--soul|--rest|--mcp|--harness|--reviewed|--run|--preview|usage/i.test(error.message));
  if (isUsage || redacted.startsWith('--')) {
    if (redacted) stderr.write(`${redacted}\n`);
    stderr.write(`${USAGE}\n`);
    exit(2);
    return;
  }
  if (error && typeof error === 'object' && error.code === 'SYMLINK') {
    stderr.write(`error: ${name}/symlink ${redacted}\n`);
    exit(1);
    return;
  }
  stderr.write(`error: ${name}/runtime ${redacted}\n`);
  exit(1);
});

// Re-export helpers for tests that import the same file as a module.
export const __testing__ = {
  parseCli,
  redact,
  atomicWrite0600,
  previewSummaryFor,
  safePreviewFor,
};
