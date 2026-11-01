#!/usr/bin/env node
// Per-invocation evidence helpers for the gate scripts.
//
// A parent gate can run the same child gate more than once, and every run writes
// to the same artifact path, so a later PASS would otherwise overwrite an earlier
// FAIL. These helpers keep each run's evidence under a runId-scoped directory
// without changing gate semantics. They are synchronous so they fit inside
// existing step-runner code.

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

export const EVIDENCE_ROOT_DEFAULT = 'artifacts/.evidence';

/**
 * Sha256 digest of a string or buffer. Returns hex.
 */
export function sha256(value) {
  return createHash('sha256').update(value ?? '').digest('hex');
}

/**
 * Sha256 digest of an existing file's bytes. Returns hex.
 * Returns null if the file is unreadable.
 */
export function sha256FromFile(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    return sha256(readFileSync(filePath));
  } catch {
    return null;
  }
}

/**
 * Make a stable, sortable, parent-scoped runId.
 *
 *   buildRunId('migration-hermes-regression') => 'migration-hermes-regression-2026-08-21T10-12-13-597Z'
 *
 * The `:`, `.` in the ISO timestamp are replaced with `-` so the ID
 * is safe in file paths on macOS, Linux, and Windows.
 */
export function buildRunId(scope, startedAt = new Date()) {
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  return `${scope}-${stamp}`;
}

/**
 * Resolve the on-disk paths for a given artifact + runId. Returns
 * `snapshotPath`, `evidenceDir`, and the sanitised `runId`. The
 * sanitisation only replaces characters that would be unsafe in a
 * Windows file path (':', '*', '?', '"', '<', '>', '|') and reserved
 * names. We keep `.`, `-`, `_` for ergonomics.
 */
export function evidencePaths({ repoRoot, runId, artifactPath, evidenceRoot = EVIDENCE_ROOT_DEFAULT }) {
  const safeRunId = String(runId ?? '').replace(/[^a-zA-Z0-9_.-]/g, '_');
  const evidenceDir = resolve(repoRoot, evidenceRoot, safeRunId);
  const base = basename(artifactPath ?? '');
  const snapshotPath = join(evidenceDir, `${base}.snapshot.json`);
  return { evidenceDir, snapshotPath, safeRunId };
}

/**
 * Snapshot an existing artifact BEFORE the caller overwrites it.
 * Idempotent: if a snapshot for the same runId already exists, the
 * earlier copy is renamed with a `.previous-<sha256-12>.json` suffix
 * to preserve the prior evidence.
 *
 * Returns `{ ok, existed, snapshotPath, snapshotDigest, snapshotBytes,
 *            preservedPreviousPath? }`. Returns `ok:false` ONLY when
 * I/O fails — a missing artifact is `existed:false, ok:true` so
 * callers can use this in a "first invocation" path without a
 * try/catch.
 */
export function snapshotBeforeOverwrite({ repoRoot, artifactPath, runId, evidenceRoot = EVIDENCE_ROOT_DEFAULT }) {
  if (!artifactPath || !runId) {
    return { ok: false, existed: false, error: 'artifactPath and runId are required', snapshotPath: null, snapshotDigest: null, snapshotBytes: 0 };
  }
  const { evidenceDir, snapshotPath } = evidencePaths({ repoRoot, runId, artifactPath, evidenceRoot });
  mkdirSync(evidenceDir, { recursive: true });

  if (!existsSync(artifactPath)) {
    return { ok: true, existed: false, snapshotPath, snapshotDigest: null, snapshotBytes: 0 };
  }

  let preservedPreviousPath = null;
  if (existsSync(snapshotPath)) {
    const existingDigest = sha256FromFile(snapshotPath) ?? 'unknown';
    const candidate = join(evidenceDir, `${basename(snapshotPath)}.previous-${existingDigest.slice(0, 12)}.json`);
    if (!existsSync(candidate)) {
      try {
        copyFileSync(snapshotPath, candidate);
        preservedPreviousPath = candidate;
      } catch (e) {
        return { ok: false, existed: true, error: `preserving previous snapshot failed: ${e.message}`, snapshotPath, snapshotDigest: null, snapshotBytes: 0 };
      }
    }
  }

  try {
    copyFileSync(artifactPath, snapshotPath);
  } catch (e) {
    return { ok: false, existed: true, error: `snapshot copy failed: ${e.message}`, snapshotPath, snapshotDigest: null, snapshotBytes: 0 };
  }
  const stat = statSync(snapshotPath);
  return {
    ok: true,
    existed: true,
    snapshotPath,
    snapshotDigest: sha256FromFile(snapshotPath),
    snapshotBytes: stat.size,
    preservedPreviousPath,
  };
}

/**
 * Write per-step stdout/stderr logs and a small JSON sibling to the
 * runId evidence directory. Returns `{ ok, logPath, logDigest,
 * logBytes, errPath, errDigest, errBytes, metadataPath,
 * metadataDigest, metadataBytes }`.
 *
 * The metadata file is intentionally small — the gate artifact
 * already records command + exitCode + status; the metadata file
 * just links the log files back to the runId, stepName, and any
 * snapshot path captured before this step ran.
 */
export function recordStepLog({
  repoRoot,
  runId,
  stepName,
  command,
  exitCode,
  status,
  stdout = '',
  stderr = '',
  startAt,
  endAt,
  artifactPath = null,
  snapshotPath = null,
  evidenceRoot = EVIDENCE_ROOT_DEFAULT,
}) {
  if (!repoRoot || !runId || !stepName) {
    return { ok: false, error: 'repoRoot, runId and stepName are required' };
  }
  const { evidenceDir } = evidencePaths({ repoRoot, runId, artifactPath, evidenceRoot });
  mkdirSync(evidenceDir, { recursive: true });

  const safeStep = String(stepName).replace(/[^a-zA-Z0-9_.-]/g, '_');
  const logPath = join(evidenceDir, `${safeStep}.stdout.log`);
  const errPath = join(evidenceDir, `${safeStep}.stderr.log`);
  const metaPath = join(evidenceDir, `${safeStep}.meta.json`);

  try {
    writeFileSync(logPath, typeof stdout === 'string' ? stdout : String(stdout ?? ''));
    writeFileSync(errPath, typeof stderr === 'string' ? stderr : String(stderr ?? ''));
  } catch (e) {
    return { ok: false, error: `writing log files failed: ${e.message}` };
  }

  const metadata = {
    runId,
    stepName,
    command: command ?? null,
    exitCode: exitCode ?? null,
    status: status ?? 'UNKNOWN',
    startAt: startAt ?? null,
    endAt: endAt ?? null,
    artifactPath: artifactPath ?? null,
    snapshotPath: snapshotPath ?? null,
    stdoutBytes: typeof stdout === 'string' ? stdout.length : 0,
    stderrBytes: typeof stderr === 'string' ? stderr.length : 0,
    stdoutDigest: sha256(typeof stdout === 'string' ? stdout : ''),
    stderrDigest: sha256(typeof stderr === 'string' ? stderr : ''),
  };
  try {
    writeFileSync(metaPath, JSON.stringify(metadata, null, 2) + '\n');
  } catch (e) {
    return { ok: false, error: `writing metadata failed: ${e.message}` };
  }

  return {
    ok: true,
    logPath,
    logDigest: sha256FromFile(logPath),
    logBytes: statSync(logPath).size,
    errPath,
    errDigest: sha256FromFile(errPath),
    errBytes: statSync(errPath).size,
    metadataPath: metaPath,
    metadataDigest: sha256FromFile(metaPath),
    metadataBytes: statSync(metaPath).size,
  };
}

/**
 * Read a snapshot/artifact file. Returns `null` if missing or
 * unparseable. Used by tests; production gates call `readFile`
 * directly so they can throw on malformed input.
 */
export function readJsonSafe(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Records ONE invocation of a child gate called from a parent gate. Captures:
 *
 *   1. A snapshot of the OBSERVED artifact (e.g. `artifacts/hermes-gate.json`)
 *      BEFORE the caller inspects it — so the prior state survives
 *      even when a subsequent invocation overwrites the file.
 *
 *   2. Per-invocation stdout/stderr log + meta.json under
 *      `artifacts/.evidence/<invocationRunId>/` — keyed by the
 *      parent-chosen runId so two invocations never collide.
 *
 * The returned entry is what the parent gate records on its artifact. Bodies are never
 * inlined — only paths/digests/bytes references so the gate JSON stays
 * small even when the invocation prints megabytes.
 *
 * Required fields:
 *
 *   repoRoot, parentRunId, invocationRunId, invocationName, scope,
 *   command, exitCode, observedArtifactPath, observedArtifact
 *
 * The `observedArtifact` must be the just-read JSON object of the
 * observed artifact AFTER invocation (or null if missing/unreadable).
 * The helper extracts `status`, `verdict`, `emitted_at`, `runId` from
 * it but never inlines the body.
 *
 * The `scope` is opaque to the helper but is propagated onto both
 * the entry and the meta.json so an aggregator can tell direct from nested
 * invocations without consulting the runId.
 */
export function recordInvocationEvidence({
  repoRoot,
  parentRunId,
  invocationRunId,
  invocationName,
  scope,
  command,
  exitCode,
  status,
  stdout = '',
  stderr = '',
  startAt,
  endAt,
  observedArtifactPath,
  observedArtifact,
  evidenceRoot = EVIDENCE_ROOT_DEFAULT,
}) {
  if (!repoRoot || !parentRunId || !invocationRunId || !invocationName || !scope || !observedArtifactPath) {
    return { ok: false, error: 'repoRoot, parentRunId, invocationRunId, invocationName, scope, and observedArtifactPath are required' };
  }

  const observedStatus = (observedArtifact && typeof observedArtifact === 'object' && typeof observedArtifact.status === 'string')
    ? observedArtifact.status
    : (status ?? 'UNKNOWN');
  const observedVerdict = (observedArtifact && typeof observedArtifact === 'object' && typeof observedArtifact.verdict === 'string')
    ? observedArtifact.verdict
    : null;
  const observedEmittedAt = (observedArtifact && typeof observedArtifact === 'object' && typeof observedArtifact.emitted_at === 'string')
    ? observedArtifact.emitted_at
    : (endAt ?? null);
  const observedRunId = (observedArtifact && typeof observedArtifact === 'object' && typeof observedArtifact.runId === 'string')
    ? observedArtifact.runId
    : null;

  const snapshot = snapshotBeforeOverwrite({
    repoRoot,
    artifactPath: observedArtifactPath,
    runId: invocationRunId,
    evidenceRoot,
  });

  const logResult = recordStepLog({
    repoRoot,
    runId: invocationRunId,
    stepName: invocationName,
    command: command ?? null,
    exitCode,
    status: status ?? 'UNKNOWN',
    stdout,
    stderr,
    startAt,
    endAt,
    artifactPath: observedArtifactPath,
    snapshotPath: snapshot.snapshotPath,
    evidenceRoot,
  });

  // Amend the meta.json file with parent/scope so a grep over
  // `artifacts/.evidence` can disambiguate by parent gate and scope.
  if (logResult.ok && logResult.metadataPath) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(logResult.metadataPath, 'utf8'));
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === 'object') {
      parsed.parentRunId = parentRunId;
      parsed.scope = scope;
      try {
        writeFileSync(logResult.metadataPath, JSON.stringify(parsed, null, 2) + '\n');
      } catch {
        // Best-effort metadata update; the log+digest contract is already
        // upheld by recordStepLog above.
      }
    }
  }

  if (!logResult.ok) {
    return { ok: false, error: logResult.error ?? 'recordStepLog failed', invocationRunId };
  }

  return {
    ok: true,
    runId: invocationRunId,
    parentRunId,
    scope,
    invocationName,
    command: command ?? null,
    exitCode: exitCode ?? null,
    status: status ?? 'UNKNOWN',
    observed_status: observedStatus,
    observed_verdict: observedVerdict,
    emitted_at: observedEmittedAt,
    observedRunId,
    observedArtifactPath,
    startAt: startAt ?? null,
    endAt: endAt ?? null,
    snapshot: {
      existed: snapshot.existed,
      path: snapshot.snapshotPath,
      digest: snapshot.snapshotDigest,
      bytes: snapshot.snapshotBytes,
      preserved_previous_path: snapshot.preservedPreviousPath ?? null,
    },
    log: {
      logPath: logResult.logPath,
      logDigest: logResult.logDigest,
      logBytes: logResult.logBytes,
      errPath: logResult.errPath,
      errDigest: logResult.errDigest,
      errBytes: logResult.errBytes,
      metadataPath: logResult.metadataPath,
      metadataDigest: logResult.metadataDigest,
      metadataBytes: logResult.metadataBytes,
    },
  };
}
