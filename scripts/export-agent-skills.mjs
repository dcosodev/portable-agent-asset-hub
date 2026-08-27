#!/usr/bin/env node
// scripts/export-agent-skills.mjs
//
// FASE 5 — Skill export CLI.
//
// Contract:
//
//   * Default mode is `--preview`: the CLI opens the SQLite DB,
//     lists active heads (in `logicalKey, id` POSIX order) and
//     writes a deterministic, metadata-only JSON to
//     `--preview-output`. The preview NEVER carries body bytes,
//     base64-encoded payloads, or absolute filesystem paths.
//   * `--apply` requires an explicit `--reviewed-digest` and
//     `--reviewed-content` (both 64-hex SHA-256) that must match
//     the freshly recomputed `planDigest` and `contentDigest`.
//   * The apply step writes to a staging directory on the same
//     filesystem as `--target-dir`, then promotes via atomic
//     rename. A `.export-registry.json` (mode 0600) records the
//     pre-apply state of every file.
//   * stdout carries bounded summary JSON only; stderr is the
//     redacted diagnostic channel. Exit codes are 0 (success), 1
//     (validation/fingerprint fail), 2 (usage error).
//
// The CLI imports compiled packages; you MUST run `pnpm run
// build` before invoking it.

import { mkdirSync, rmSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { argv, exit, stderr, stdout } from 'node:process';

import { createActorContext, HubError } from '@portable-agent-asset-hub/core';
import { SkillExportCoordinator } from '@portable-agent-asset-hub/skill-export';

const REPO_ROOT = new URL('..', import.meta.url).pathname;

const USAGE = [
  'usage: export-agent-skills.mjs \\',
  '  --db <path> --target-dir <path> \\',
  '  --owner-user-id <id> --agent-id <id> \\',
  '  (--all | --skill-id <id> [--skill-id <id> ...]) \\',
  '  [--preview-output <path>] \\',
  '  [--apply --reviewed-digest <hex> --reviewed-content <hex>]',
  '  [--rollback --run-id <run_...>]',
].join('\n');

function parseCli(argvList) {
  let db;
  let targetDir;
  let ownerUserId;
  let agentId;
  let previewOutput;
  let apply = false;
  let rollback = false;
  let runId;
  let reviewedDigest;
  let reviewedContent;
  let all = false;
  const skillIds = [];
  for (let index = 0; index < argvList.length; index += 1) {
    const arg = argvList[index];
    const next = argvList[index + 1];
    const takeValue = (flag, label) => {
      if (typeof next !== 'string') throw new Error(`${flag} requires <${label}>`);
      index += 1;
      return next;
    };
    if (arg === '--db') db = takeValue('--db', 'path');
    else if (arg === '--target-dir') targetDir = takeValue('--target-dir', 'path');
    else if (arg === '--owner-user-id') ownerUserId = takeValue('--owner-user-id', 'id');
    else if (arg === '--agent-id') agentId = takeValue('--agent-id', 'id');
    else if (arg === '--preview-output') previewOutput = takeValue('--preview-output', 'path');
    else if (arg === '--reviewed-digest') reviewedDigest = takeValue('--reviewed-digest', 'hex');
    else if (arg === '--reviewed-content') reviewedContent = takeValue('--reviewed-content', 'hex');
    else if (arg === '--apply') apply = true;
    else if (arg === '--rollback') rollback = true;
    else if (arg === '--run-id') runId = takeValue('--run-id', 'id');
    else if (arg === '--all') all = true;
    else if (arg === '--skill-id') skillIds.push(takeValue('--skill-id', 'id'));
    else if (arg === '--help' || arg === '-h') throw new Error('');
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!db) throw new Error('--db is required');
  if (!targetDir) throw new Error('--target-dir is required');
  if (!ownerUserId) throw new Error('--owner-user-id is required');
  if (!agentId) throw new Error('--agent-id is required');
  if (!all && skillIds.length === 0) throw new Error('either --all or at least one --skill-id is required');
  if (all && skillIds.length > 0) throw new Error('--all and --skill-id are mutually exclusive');
  if (apply && (!reviewedDigest || !reviewedContent)) {
    throw new Error('--apply requires --reviewed-digest and --reviewed-content');
  }
  if (apply && rollback) throw new Error('--apply and --rollback are mutually exclusive');
  if (rollback && !runId) throw new Error('--rollback requires --run-id');
  return {
    db: resolve(db),
    targetDir: resolve(targetDir),
    ownerUserId,
    agentId,
    previewOutput: resolve(previewOutput ?? `${REPO_ROOT}artifacts/s5-export-preview-${Date.now()}.json`),
    apply,
    rollback,
    ...(runId !== undefined ? { runId } : {}),
    ...(reviewedDigest !== undefined ? { reviewedDigest } : {}),
    ...(reviewedContent !== undefined ? { reviewedContent } : {}),
    selection: all ? { mode: 'all' } : { mode: 'ids', ids: skillIds },
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
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
  }
}

function emitSummary(payload) {
  stdout.write(`${JSON.stringify(payload)}\n`);
}

async function main() {
  const args = parseCli(argv.slice(2));
  const actor = createActorContext({
    userId: args.ownerUserId,
    agentId: args.agentId,
    role: 'admin',
    capabilities: ['read.skill', 'admin'],
  });
  const coordinator = new SkillExportCoordinator({
    dbPath: args.db,
    actor,
    selection: args.selection,
    targetDir: args.targetDir,
  });

  if (args.rollback) {
    const result = coordinator.rollback();
    if (result.runId !== args.runId) throw new Error(`rollback run-id mismatch: ${args.runId}`);
    atomicWrite0600(args.previewOutput, JSON.stringify({ mode: 'rollback', runId: result.runId, finishedAt: result.finishedAt }, null, 2));
    emitSummary({ mode: 'rollback', runId: result.runId, finishedAt: result.finishedAt });
    exit(0);
    return;
  }

  if (!args.apply) {
    const plan = coordinator.preview();
    atomicWrite0600(args.previewOutput, JSON.stringify(plan, null, 2));
    emitSummary({
      mode: 'preview',
      planDigest: plan.planDigest,
      contentDigest: plan.contentDigest,
      selection: plan.selection,
      scope: plan.scope,
      counts: plan.counts,
    });
    exit(0);
    return;
  }

  const result = coordinator.apply(args.reviewedDigest, args.reviewedContent);
  atomicWrite0600(
    args.previewOutput,
    JSON.stringify(
      {
        mode: 'apply',
        runId: result.runId,
        planDigest: result.planDigest,
        contentDigest: result.contentDigest,
        appliedAt: result.appliedAt,
        filesWritten: result.filesWritten,
        filesReused: result.filesReused,
        filesRemoved: result.filesRemoved,
        selection: result.selection,
      },
      null,
      2,
    ),
  );
  emitSummary({
    mode: 'apply',
    runId: result.runId,
    planDigest: result.planDigest,
    contentDigest: result.contentDigest,
    appliedAt: result.appliedAt,
    filesWritten: result.filesWritten,
    filesReused: result.filesReused,
    filesRemoved: result.filesRemoved,
    selection: result.selection,
  });
  exit(0);
}

main().catch((error) => {
  const redacted = redact(error instanceof Error ? `${error.message}` : String(error));
  if (error instanceof Error && /requires|unknown|--apply|--all|--skill|--target|--owner|--agent|usage/i.test(error.message)) {
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
