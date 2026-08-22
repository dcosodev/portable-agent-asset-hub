#!/usr/bin/env node
// scripts/gate-evidence.mjs
//
// Reusable per-invocation evidence helpers for S5/S8/S9/S10 gate scripts.
//
// Background — the orchestration audit confirmed that S10 calls
// `pnpm s8:gate` (step 13) and then `pnpm s9:gate` (step 14); S9
// internally also calls `pnpm s8:gate` (step 12). Both S8 invocations
// write `artifacts/s8-gate.json`, so the on-disk artifact at the end
// of the S10 run only reflects the LAST s8 invocation. If the FIRST
// S8 invocation observed a real FAIL (e.g. because S5 failed upstream),
// the FAIL evidence is overwritten by S9's nested S8 re-run before
// anyone can inspect it.
//
// These helpers preserve traceability without changing gate semantics:
//
//   * snapshotBeforeOverwrite({ repoRoot, artifactPath, runId }) — if
//     `artifactPath` exists, COPY it to
//     `artifacts/.evidence/<runId>/<basename>.snapshot.json`
//     and return the snapshot's digest/bytes. Never destroys an
//     existing snapshot — if one already exists for the same runId,
//     rename the older copy with a `.previous-<sha>.json` suffix first.
//
//   * recordStepLog({ repoRoot, runId, stepName, stdout, stderr,
//     status, exitCode, command }) — when a step FAILS (or always in
//     debug mode), writes stdout/stderr to
//     `artifacts/.evidence/<runId>/<stepName>.{stdout,stderr}.log`
//     and a small JSON sibling `<stepName>.meta.json` (runId,
//     command, exitCode, status, evidence relationships, byte sizes).
//     Returns digests + paths. Gate artifacts store ONLY the
//     `log_digest`, `log_path`, `log_bytes` triple — bodies live on
//     disk and are not stuffed into the artifact JSON.
//
//   * buildRunId(scope) — `s10-s8-regression-<ISO>` style; safe in
//     file paths across OSes; sortable.
//
// All helpers are synchronous (copyFileSync/writeFileSync) so they
// drop into existing runStep / persistArtifact contexts without
// requiring the surrounding code to await.

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
 * Make a stable, sortable, parent-scoped runId. Two S8 invocations
 * from the same S10 gate will get distinct IDs because each call
 * receives a fresh `scope` and `startedAt`.
 *
 *   buildRunId('s10-s8-regression') => 's10-s8-regression-2026-08-21T10-12-13-597Z'
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
 * S10-specific evidence helper. Records ONE invocation of a child gate
 * (s8 or s9) called from a parent gate (S10). Captures:
 *
 *   1. A snapshot of the OBSERVED artifact (e.g. `artifacts/s8-gate.json`)
 *      BEFORE the caller inspects it — so the prior state survives
 *      even when a subsequent invocation overwrites the file.
 *
 *   2. Per-invocation stdout/stderr log + meta.json under
 *      `artifacts/.evidence/<invocationRunId>/` — keyed by the
 *      S10-chosen runId so two distinct invocations (S10→S8 direct,
 *      S9→S8 nested) never collide.
 *
 * The returned entry is the structured shape the S10 gate must include
 * on its `s8_invocations` (or `s9_invocation`) array. Bodies are never
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
 * the entry and the meta.json so the S10 aggregator can distinguish
 * `s10-direct` from `s10-via-s9` without consulting the runId.
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

  // Amend the meta.json file with parent/scope so a future grep over
  // `artifacts/.evidence` can disambiguate by parent gate and scope
  // without reopening the S10 artifact.
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
        // Best-effort amendment; the log+digest contract is already
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
