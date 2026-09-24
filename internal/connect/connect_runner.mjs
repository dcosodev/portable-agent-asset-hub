#!/usr/bin/env node
// internal/connect/connect_runner.mjs
//
// T8 child Node process for `hub hub connect preview|apply|rollback`.
//
// Contract (mirrored in internal/connect/runner.go):
//
//   argv[0]              this file (resolved by the runner)
//   argv[1]              action: "preview" | "apply" | "rollback"
//   argv[2]              request payload (JSON string)
//   HUB_HOME / HUB_* env from the Go runner (sanitised; no bearer)
//
// The runner emits exactly one JSON document on stdout and exits
// with a Go-side-mapped code:
//   * 0  — success, body is a *Payload shape (PreviewPayload,
//          ApplyPayload, RollbackPayload).
//   * 1  — adapter/runtime/operator error. Body is an ErrorPayload
//          shape; the Go dispatcher forwards it to stderr.
//   * 2  — CLI contract violation the .mjs detected (e.g. drift from
//          the requested expectedDigest before the adapter ran).
//          Body is an ErrorPayload shape.
//
// Design contract this revision honours:
//
//   * NO hardcodes. generatedAt is the value the materializer stamps;
//     runId is whatever the materializer mints. The child never
//     re-stamps the plan to fake determinism.
//   * CANONICAL storage binding. The database path is the absolute
//     path returned by `@portable-agent-asset-hub/core`'s
//     `resolveHubDatabasePath` (which honours AGENT_MEMORY_DB_PATH,
//     AGENT_MEMORY_DATA_DIR, then platform default — never a
//     child-local fallback). Preview opens the store read-only;
//     apply/rollback open it read-write. The child MUST NOT
//     create a database file: an `lstat` on a regular file
//     precedes every open, and the absence of that file is a
//     typed operator error so the operator sees a real reason
//     instead of a fresh, empty, content-less hub.sqlite.
//   * NO parallel registry. RunId-to-coordinates resolution goes
//     through the materializer's `registerRun` / `lookupRun` only.
//     The child never keeps its own Map<runId,…>.
//   * NO digest substitution. Apply passes the operator's verbatim
//     `expectedDigest` to `applyPlan`'s CAS gate. The child never
//     rewrites `expectedDigest` to match a re-stamped
//     `preview.observedDigest`; the materializer's drift detector
//     is the single source of truth for the comparison.
//   * NO secrets/bearers on argv, env, or stdout. We inherit only
//     PATH / LANG / etc.; the Go runner strips every
//     HUB_BEARER_TOKEN* before forking us.
//   * Stable, sorted-key JSON envelope. The framing bytes are
//     byte-deterministic; domain fields (runId, generatedAt,
//     observedDigest) reflect the real materializer output.
//   * hubHome (HUB_HOME) is reserved for receipts / runtime
//     layout only. It does NOT participate in storage path
//     resolution.

import { lstatSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import * as receiptStore from './receipt_store.mjs';

// ----- argv & request parsing ----------------------------------------------

const [, , action, requestJSON] = process.argv;

if (!action) {
  emitError({
    code: 'NO_ACTION',
    message: 'connect_runner: missing action positional (preview|apply|rollback)',
    httpCode: 400,
  });
  process.exit(1);
}

let request;
try {
  request = JSON.parse(requestJSON ?? '{}');
} catch (error) {
  emitError({
    code: 'INVALID_REQUEST',
    message: `connect_runner: cannot parse request payload: ${error.message}`,
    httpCode: 400,
  });
  process.exit(1);
}

// ----- import resolution --------------------------------------------------

// The runner resolves this script relative to the repo root, so
// `import.meta.url` always points at
// `<repoRoot>/internal/connect/connect_runner.mjs`. The
// materializers package sits at
// `<repoRoot>/packages/materializers`; the core package lives at
// `<repoRoot>/packages/core`.
const here = new URL('.', import.meta.url).pathname;
const repoRoot = here
  .replace(/\/internal\/connect\/$/u, '')
  .replace(/\/internal\/connect$/u, '');

const materializersDist = await resolveDist(repoRoot, [
  `${repoRoot}/packages/materializers/dist/index.js`,
  `${repoRoot}/node_modules/@portable-agent-asset-hub/materializers/dist/index.js`,
]);
const materializersHermesDist = await resolveDist(repoRoot, [
  `${repoRoot}/packages/materializers/dist/hermes/index.js`,
  `${repoRoot}/node_modules/@portable-agent-asset-hub/materializers/dist/hermes/index.js`,
]);
const coreDist = await resolveDist(repoRoot, [
  `${repoRoot}/packages/core/dist/index.js`,
  `${repoRoot}/node_modules/@portable-agent-asset-hub/core/dist/index.js`,
]);

const materializerApi = await import(materializersDist);
const materializersHermesApi = await import(materializersHermesDist);
const coreApi = await import(coreDist);

// ----- productive Storage loader -----------------------------------------

// The child binds to `SqliteStore` from
// `@portable-agent-asset-hub/storage-sqlite`. The path resolution
// itself is delegated to `@portable-agent-asset-hub/core`'s
// `resolveHubDatabasePath` so the precedence (AGENT_MEMORY_DB_PATH
// → AGENT_MEMORY_DATA_DIR → platform default) stays canonical.
// The loader refuses to silently fall back to a fake/in-memory
// stub: a failure to load `SqliteStore` surfaces as a typed
// operator error so the operator sees the real reason the
// connect verb cannot run, instead of a misleading GREEN that a
// fake Storage produced.
const storageLoader = await loadProductiveStorage();

const { HubError, createActorContext, resolveHubDatabasePath } = coreApi;
const {
  computePreview,
  rollbackPlan,
  observedManifestDigest,
  registerRun,
  forgetRun,
  getAdapter,
  readManifestFromDisk,
} = materializerApi;
// Owner-TS canonical plan content digest helper. Wired in from
// `@portable-agent-asset-hub/materializers/hermes` so this child
// imports the SAME symbol the apply path recomputes against —
// no shadow re-implementation, no stable-stringify copy, no
// canonicalization duplicate. The function hashes the canonical
// projection of the plan CONTENT (harness/profileId/snapshotId/
// targetRoot + sorted files[relativePath, sha256, sourceRef,
// mode]) and returns the 64-hex SHA-256 the operator carries
// across the preview → apply boundary as `--reviewed-digest`.
// Volatile runId / generatedAt / bytes are deliberately excluded
// so two previews of the same logical input yield identical
// planDigest across processes.
const { planDigest, applyReviewed } = materializersHermesApi;

// ----- envelope framing ----------------------------------------------------

function emit(payload) {
  // Sorted-key JSON keeps the framing bytes stable. Domain fields
  // (runId, generatedAt, observedDigest) are emitted verbatim
  // because they are byte-deterministic at the materializer level
  // (canonicalizeManifest + digestPlan / observedManifestDigest).
  process.stdout.write(JSON.stringify(payload, sortedReplacer(), 2) + '\n');
}

function sortedReplacer() {
  return (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const sorted = {};
      for (const k of Object.keys(value).sort()) sorted[k] = value[k];
      return sorted;
    }
    return value;
  };
}

function emitError({ code, message, httpCode = 500, extra = {} }) {
  emit({ code, message, httpCode, ...extra });
}

// ----- helpers -------------------------------------------------------------

async function resolveDist(repoRoot, candidates) {
  const { statSync } = await import('node:fs');
  for (const candidate of candidates) {
    try {
      statSync(candidate);
      return candidate;
    } catch {
      // continue
    }
  }
  // Default to the last (canonical) candidate so a missing dist
  // surfaces as an `ERR_MODULE_NOT_FOUND` at import time, which
  // the caller can map to STORAGE_BINDING_MISSING.
  return candidates[candidates.length - 1];
}

async function loadProductiveStorage() {
  const sqliteModule = '@portable-agent-asset-hub/storage-sqlite';
  try {
    // Dynamic import by specifier so node's resolver walks the
    // workspace node_modules tree (storage-sqlite is a workspace
    // dependency hoisted into the root node_modules).
    const mod = await import(sqliteModule);
    const ctor = mod?.SqliteStore;
    if (typeof ctor !== 'function') {
      throw new Error('SqliteStore export missing from storage-sqlite');
    }
    return {
      kind: 'SqliteStore',
      SqliteStore: ctor,
    };
  } catch (error) {
    return {
      kind: 'BLOCKED',
      reason: `connect_runner cannot bind SqliteStore: ${error.message}.`,
    };
  }
}

function buildActor() {
  // CLI identity convention shared with `scripts/relations.mjs`
  // and the REST local-mode launcher: read the operator's
  // identity from AGENT_MEMORY_USER_ID / AGENT_MEMORY_AGENT_ID
  // and fall back to the canonical defaults `usr_local` /
  // `agt_local`. Defaulting to `usr_local` / `agt_local` (not
  // `user_anon` / `agent_anon`) keeps this child in lockstep
  // with the rest of the CLI under the SAME scope so tests that
  // seed the real Profile under that exact scope become visible
  // without any wildcard/global lookup.
  return createActorContext({
    userId: process.env.AGENT_MEMORY_USER_ID || 'usr_local',
    agentId: process.env.AGENT_MEMORY_AGENT_ID || 'agt_local',
    harnessId: 'connect-cli',
    role: 'admin',
    capabilities: ['read', 'write'],
  });
}

// ----- canonical storage binding ------------------------------------------
//
// `buildStore(loader, operation)` is the SINGLE seam where this child
// decides which database file the connect verb reads or writes. The
// path is whatever `@portable-agent-asset-hub/core`'s
// `resolveHubDatabasePath` returns for `process.env` — that helper
// honours AGENT_MEMORY_DB_PATH (explicit), AGENT_MEMORY_DATA_DIR /
// PORTABLE_AGENT_ASSET_HUB_DATA_DIR (configured data dir), then the
// platform persistent default (macOS:
// ~/Library/Application Support/portable-agent-asset-hub/hub.sqlite).
//
// Re-implementing that precedence here is forbidden: doing so would
// silently fork the precedence with the rest of the hub and let a
// stale child bind to a database nobody else sees. The whole point
// of this revision is to bind to the canonical resolution.
//
// Read-only vs read-write:
//
//   * preview: opens the store read-only (no WAL/SHM sidecar
//     creation, no migration, no audit append). The store still
//     refuses to open unless the file already exists as a regular
//     file (HubDatabase lstat check, surfaces as a typed error).
//   * apply / rollback: open the store read-write so the materializer
//     can append audit events and persist materialization state.
//
// File-existence contract: an `lstat` precedes every store open. A
// missing file is a typed operator error (`HUB_DATABASE_MISSING`)
// so the operator never sees a silently-created empty hub.sqlite
// masquerading as a populated database (which is what the
// pre-revision child produced and is exactly the failure mode the
// RED suite pinned: "resource not found").
//
// hubHome (`HUB_HOME`) does NOT participate in storage binding;
// it is reserved for the receipts / runtime layout and is forwarded
// to the verb callbacks unchanged.

const DATABASE_OPERATIONS = new Set(['preview', 'apply', 'rollback']);
const READ_ONLY_OPERATIONS = new Set(['preview']);

function buildStore(loader, operation) {
  if (loader.kind === 'BLOCKED') {
    throw new HubError('STORAGE_BINDING_MISSING', loader.reason, 501);
  }
  if (!DATABASE_OPERATIONS.has(operation)) {
    throw new HubError(
      'STORAGE_OPERATION_INVALID',
      `connect_runner: buildStore received unsupported operation "${operation}" (expected preview|apply|rollback)`,
      500,
    );
  }

  // Canonical resolution: never reimplement precedence here.
  // `resolveHubDatabasePath` honours AGENT_MEMORY_DB_PATH /
  // AGENT_MEMORY_DATA_DIR / PORTABLE_AGENT_ASSET_HUB_DATA_DIR /
  // platform default in that order.
  const resolution = resolveHubDatabasePath({ env: process.env });
  const dbPath = resolution.path;

  // Pre-open existence check: the child MUST NOT create a fresh
  // hub.sqlite behind the operator's back. An absent database is a
  // typed error so the operator's connect verb stops with a clear
  // message instead of producing a content-less preview.
  const stat = lstatSync(dbPath, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) {
    throw new HubError(
      'HUB_DATABASE_MISSING',
      `connect_runner: canonical database not found at ${dbPath} (source=${resolution.source}). Run \`hub init\` or set AGENT_MEMORY_DB_PATH before connecting.`,
      404,
    );
  }

  const mode = READ_ONLY_OPERATIONS.has(operation) ? 'read-only' : 'read-write';
  try {
    return new loader.SqliteStore(dbPath, { mode });
  } catch (error) {
    // Re-throw HubError verbatim; wrap IO / SQLite errors with the
    // canonical path and resolution source so the operator can see
    // exactly which file failed to bind.
    if (error && typeof error === 'object' && typeof error.code === 'string') {
      throw error;
    }
    throw new HubError(
      'HUB_DATABASE_OPEN_FAILED',
      `connect_runner: cannot open canonical database ${dbPath} (source=${resolution.source}, mode=${mode}): ${error?.message ?? String(error)}`,
      500,
    );
  }
}

function projectPlan(plan) {
  // Wire projection: drop `bytes` (large), sort files for stable
  // framing. The fields we emit here ARE the canonical manifest
  // projection — no re-stamping, no fake fixed timestamps.
  const files = [...plan.files]
    .map((file) => ({
      relativePath: file.relativePath,
      sha256: file.sha256,
      size: Buffer.byteLength(file.bytes),
      mode: file.mode,
      sourceRef: file.sourceRef,
    }))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return {
    runId: plan.runId ?? null,
    snapshotId: plan.snapshotId,
    harness: plan.harness,
    profileId: plan.profileId,
    targetRoot: plan.targetRoot,
    files,
    generatedAt: plan.generatedAt,
    rendererVersion: plan.rendererVersion,
  };
}

function projectProfile(profile) {
  if (!profile) return null;
  return {
    id: profile.id,
    version: profile.version ?? 1,
    scope: profile.scope ?? null,
    blockCount: Array.isArray(profile.blocks) ? profile.blocks.length : 0,
  };
}

// ----- verb dispatch -------------------------------------------------------

const loader = storageLoader;
const actor = buildActor();

async function runPreview(req) {
  if (req.harness !== 'hermes' && req.harness !== 'openclaw') {
    emitError({
      code: 'UNKNOWN_HARNESS',
      message: `connect_runner: harness ${req.harness} not recognised (expected hermes|openclaw)`,
      httpCode: 400,
    });
    return 2;
  }
  if (!req.profileId || !req.snapshotId || !req.targetRoot) {
    emitError({
      code: 'MISSING_ARG',
      message: 'connect_runner: preview requires harness, profileId, snapshotId, targetRoot',
      httpCode: 400,
    });
    return 2;
  }

  let store;
  try {
    store = buildStore(loader, 'preview');
  } catch (error) {
    return handleAdapterError(error, 'preview');
  }
  try {
    // Preview is read-only by construction: it never writes to
    // disk and never opens the lock directory. The materializer
    // validates (targetRoot non-symlink, profile/snapshot shape)
    // and returns the observedDigest the apply step will check.
    const preview = computePreview(store, actor, {
      harness: req.harness,
      profileId: req.profileId,
      snapshotId: req.snapshotId,
      targetRoot: req.targetRoot,
    });
    // Plan-content digest. We delegate to the OWNER-TS
    // `planDigest` exported from
    // `@portable-agent-asset-hub/materializers/hermes`
    // (packages/materializers/src/hermes/apply-reviewed.ts),
    // not a copy. The helper projects {harness, profileId,
    // snapshotId, targetRoot, files[] sorted by relativePath}
    // and SHA-256s the canonical JSON; volatile runId /
    // generatedAt / bytes are excluded by construction. The
    // projection accepts the live `preview.plan` because the
    // ManifestFile shape already carries relativePath / sha256 /
    // sourceRef / mode — the bytes field is dropped inside
    // `planDigest` so a Buffer in `files[i].bytes` does not
    // collide with the expected string projection.
    const planDigestValue = planDigest({
      harness: preview.plan.harness,
      profileId: preview.plan.profileId,
      snapshotId: preview.plan.snapshotId,
      targetRoot: preview.plan.targetRoot,
      files: preview.plan.files,
    });
    // Human-readable summary. The Go JSON/human renderer in
    // cmd/hub/cmd_connect.go is the production surface for the
    // human form; this child carries a pre-rendered key=value
    // line so a CI pipeline that bypasses the Go renderer (e.g.
    // invoking the .mjs directly) still surfaces the stable
    // anchors (planDigest / profileId / snapshotId / harness)
    // for grep-based audit. observedDigest is deliberately
    // excluded: it is the volatile CAS manifest digest (the
    // live SHA-256 of the canonical manifest bytes including
    // runId / generatedAt) and would re-introduce the very
    // drift the deterministic-output suite rejects. Operators
    // who want the observedDigest read the JSON envelope via
    // `--json`; the human form stays stable across invocations
    // of the same logical input. The string is generated from
    // the live plan metadata — no re-stamping of volatile values.
    const humanReadable = [
      `planDigest=${planDigestValue}`,
      `profileId=${preview.plan.profileId}`,
      `snapshotId=${preview.plan.snapshotId}`,
      `harness=${preview.plan.harness}`,
    ].join(' ');
    emit({
      command: 'connect preview',
      action: 'preview',
      harness: req.harness,
      // observedDigest is the live CAS manifest digest
      // (SHA-256 of the canonical manifest bytes including
      // runId / generatedAt). planDigest is the canonical
      // SHA-256 of the plan CONTENT (volatile metadata
      // normalised out). The two digests serve different
      // purposes and MUST stay distinct — the apply path
      // checks planDigest against the operator's
      // --reviewed-digest, and observedDigest against the
      // CAS gate. Aliasing them would silently break drift
      // detection on volatile values.
      observedDigest: preview.observedDigest,
      planDigest: planDigestValue,
      humanReadable,
      profile: projectProfile(preview.profile),
      plan: projectPlan(preview.plan),
    });
    return 0;
  } catch (error) {
    return handleAdapterError(error, 'preview');
  } finally {
    try { store.close(); } catch { /* best effort */ }
  }
}

async function runApply(req) {
  // Format checks mirror internal/connect/regex.go and
  // packages/materializers/src/{preview,apply,rollback}.ts. The
  // Go shell already enforces the same regex; we re-check so a
  // future caller that bypasses the Go dispatcher still gets a
  // clear rejection.
  const digestRegex = /^[0-9a-f]{64}$/u;
  if (!req.reviewedDigest) {
    emitError({
      code: 'REVIEWED_DIGEST_REQUIRED',
      message: 'connect_runner: apply requires a reviewedDigest (the operator-reviewed planDigest from preview)',
      httpCode: 400,
    });
    return 2;
  }
  if (!digestRegex.test(req.reviewedDigest)) {
    emitError({
      code: 'REVIEWED_DIGEST_FORMAT',
      message: 'connect_runner: reviewedDigest must be 64 lowercase hex characters',
      httpCode: 400,
    });
    return 2;
  }
  if (req.expectedDigest && !digestRegex.test(req.expectedDigest)) {
    emitError({
      code: 'EXPECTED_DIGEST_FORMAT',
      message: 'connect_runner: expectedDigest must be 64 lowercase hex characters',
      httpCode: 400,
    });
    return 2;
  }
  if (req.observedDigest && !digestRegex.test(req.observedDigest)) {
    emitError({
      code: 'OBSERVED_DIGEST_FORMAT',
      message: 'connect_runner: observedDigest must be 64 lowercase hex characters',
      httpCode: 400,
    });
    return 2;
  }
  if (!req.profileId || !req.snapshotId || !req.targetRoot || !req.reason) {
    emitError({
      code: 'MISSING_ARG',
      message: 'connect_runner: apply requires harness, profileId, snapshotId, targetRoot, reason',
      httpCode: 400,
    });
    return 2;
  }
  if (!req.lockDir) {
    emitError({
      code: 'MISSING_LOCK_DIR',
      message: 'connect_runner: apply requires lockDir (use --lock-dir or default to targetRoot)',
      httpCode: 400,
    });
    return 2;
  }

  let store;
  try {
    store = buildStore(loader, 'apply');
  } catch (error) {
    return handleAdapterError(error, 'apply');
  }
  try {
    // Apply runs `applyReviewed` from the owner-TS hermes path.
    // The CAS gate compares `reviewedDigest` (the operator's
    // verbatim value from `--reviewed-digest`) against the
    // `planDigest` of the live seed preview we compute in THIS
    // process. If the profile/snapshot has changed since the
    // operator reviewed the plan, the preview's planDigest will
    // drift from `reviewedDigest` and the materializer will
    // surface PRECONDITION_FAILED with a "planDigest drift" /
    // "stale preview" message. We translate that to PREVIEW_STALE
    // (HTTP 412) so the operator knows to re-run preview.
    //
    // The seed preview can fail with NOT_FOUND when the
    // referenced profile/snapshot is no longer present in the
    // canonical database — that is also a stale-source
    // condition, so we map it to PREVIEW_STALE (HTTP 412)
    // symmetrically. The drift-vs-stale distinction lives
    // entirely in the materializer message; this child keeps a
    // single typed exit code.
    let seedPreview;
    try {
      seedPreview = computePreview(store, actor, {
        harness: req.harness,
        profileId: req.profileId,
        snapshotId: req.snapshotId,
        targetRoot: req.targetRoot,
      });
    } catch (error) {
      if (error && error.code === 'NOT_FOUND') {
        emitError({
          code: 'PREVIEW_STALE',
          message: `connect_runner: apply rejected — preview source is stale or missing (planDigest drift / stale source): ${error.message ?? String(error)}`,
          httpCode: 412,
        });
        return 2;
      }
      throw error;
    }

    const currentPlanDigest = planDigest({
      harness: seedPreview.plan.harness,
      profileId: seedPreview.plan.profileId,
      snapshotId: seedPreview.plan.snapshotId,
      targetRoot: seedPreview.plan.targetRoot,
      files: seedPreview.plan.files,
    });

    const result = await applyReviewed(
      { store, actor, targetRoot: req.targetRoot, lockDir: req.lockDir },
      {
        preview: seedPreview,
        reviewedDigest: req.reviewedDigest,
        observedDigest: req.observedDigest || undefined,
        expectedDigest: req.expectedDigest || undefined,
        reason: req.reason,
        requestId: req.requestId,
        targetRoot: req.targetRoot,
        lockDir: req.lockDir,
      },
    );

    // Receipts only make sense once a manifest has actually
    // landed on disk. We resolve the harness adapter to learn
    // the manifestPath the materializer just wrote, read it
    // back, and stamp the receipt with the manifest's own
    // generatedAt so the receipt's `writtenAt` matches the
    // canonical manifest bytes — not a child-local clock. A
    // missing or mismatched manifest is a hard INTERNAL: the
    // materializer claimed success, the operator needs a real
    // reason, and a silently-missing receipt is exactly the
    // failure mode the receipt contract forbids.
    const adapter = getAdapter(req.harness);
    const manifest = readManifestFromDisk(
      pathJoin(req.targetRoot, adapter.manifestPath),
    );
    if (
      !manifest ||
      manifest.runId !== result.runId ||
      manifest.harness !== req.harness ||
      manifest.profileId !== req.profileId ||
      manifest.targetRoot !== req.targetRoot ||
      !manifest.generatedAt
    ) {
      throw new HubError(
        'INTERNAL',
        `connect_runner: apply succeeded but the on-disk manifest at ${adapter.manifestPath} is missing or does not match the apply result (runId=${result.runId}, harness=${req.harness}, profileId=${req.profileId}, targetRoot=${req.targetRoot})`,
        500,
      );
    }

    const receiptPath = receiptStore.write(req.hubHome, {
      schemaVersion: 1,
      runId: result.runId,
      targetRoot: req.targetRoot,
      lockDir: req.lockDir,
      harness: req.harness,
      profileId: req.profileId,
      observedDigest: result.observedDigest,
      writtenAt: manifest.generatedAt,
    });

    const writtenFiles = (result.writtenFiles || [])
      .map((f) => f.relativePath)
      .sort();

    emit({
      command: 'connect apply',
      action: 'apply',
      harness: req.harness,
      runId: result.runId,
      observedDigest: result.observedDigest,
      currentPlanDigest,
      planDigest: req.reviewedDigest,
      writtenFiles,
      backupRoot: result.backupRoot,
      receiptPath,
    });
    return 0;
  } catch (error) {
    // The materializer raises PRECONDITION_FAILED with a
    // "planDigest drift" / "stale preview" message when the
    // live seed preview's planDigest no longer matches the
    // operator's reviewedDigest. Map that to PREVIEW_STALE
    // (HTTP 412) so the operator sees a typed drift signal
    // rather than a generic 500, and re-runs preview before
    // re-attempting apply.
    if (
      error &&
      error.code === 'PRECONDITION_FAILED' &&
      typeof error.message === 'string' &&
      /planDigest drift|stale preview/iu.test(error.message)
    ) {
      emitError({
        code: 'PREVIEW_STALE',
        message: `connect_runner: apply rejected — planDigest drift / stale preview: ${error.message}`,
        httpCode: 412,
      });
      return 2;
    }
    return handleAdapterError(error, 'apply');
  } finally {
    try { store.close(); } catch { /* best effort */ }
  }
}

async function runRollback(req) {
  const runIDRegex = /^run_[A-Za-z0-9._-]+$/u;
  if (!req.runId) {
    emitError({
      code: 'RUN_ID_REQUIRED',
      message: 'connect_runner: rollback requires runId',
      httpCode: 400,
    });
    return 2;
  }
  if (!runIDRegex.test(req.runId)) {
    emitError({
      code: 'RUN_ID_FORMAT',
      message: 'connect_runner: runId must match run_[A-Za-z0-9._-]+',
      httpCode: 400,
    });
    return 2;
  }
  if (!req.reason) {
    emitError({
      code: 'REASON_REQUIRED',
      message: 'connect_runner: rollback requires reason',
      httpCode: 400,
    });
    return 2;
  }

  let store;
  try {
    store = buildStore(loader, 'rollback');
  } catch (error) {
    return handleAdapterError(error, 'rollback');
  }
  try {
    const receiptResult = receiptStore.read(req.hubHome, req.runId);
    if (!receiptResult.ok) {
      throw new HubError('NOT_FOUND', 404, receiptResult.message ?? `receipt ${req.runId} not found`);
    }
    const receipt = receiptResult.receipt;

    if (receipt.harness !== 'hermes') {
      throw new HubError('VALIDATION', 400, `unsupported harness: ${receipt.harness}`);
    }

    const adapter = getAdapter(receipt.harness);
    const manifest = readManifestFromDisk(pathJoin(receipt.targetRoot, adapter.manifestPath));
    if (!manifest) {
      throw new HubError('NOT_FOUND', 404, `live manifest missing at ${pathJoin(receipt.targetRoot, adapter.manifestPath)}`);
    }
    if (
      manifest.runId !== req.runId ||
      manifest.harness !== receipt.harness ||
      manifest.profileId !== receipt.profileId ||
      manifest.targetRoot !== receipt.targetRoot
    ) {
      throw new HubError('PRECONDITION_FAILED', 412, 'stale receipt / live manifest mismatch');
    }

    const liveDigest = observedManifestDigest(receipt.targetRoot);
    if (liveDigest !== receipt.observedDigest) {
      throw new HubError('PRECONDITION_FAILED', 412, 'stale receipt: observedDigest drift');
    }

    registerRun(req.runId, {
      targetRoot: receipt.targetRoot,
      lockDir: receipt.lockDir,
      harness: receipt.harness,
      profileId: receipt.profileId,
    });

    const result = rollbackPlan(store, actor, {
      runId: req.runId,
      reason: req.reason,
      requestId: req.requestId,
    });
    const restored = [...result.restored].sort();
    emit({
      command: 'connect rollback',
      action: 'rollback',
      runId: result.runId,
      restored,
    });
    return 0;
  } catch (error) {
    return handleAdapterError(error, 'rollback');
  } finally {
    try { forgetRun(req.runId); } catch { /* best effort */ }
    try { store.close(); } catch { /* best effort */ }
  }
}

// ----- shared error handling -----------------------------------------------

function handleAdapterError(error, verb) {
  // HubError carries code / status / message — we surface them
  // verbatim. Non-HubError exceptions are mapped to INTERNAL
  // (HTTP 500). The Go dispatcher decides the operator-visible
  // exit code (1 = adapter/runtime, 2 = CLI contract violation).
  const code = error?.code ?? 'INTERNAL';
  const message = error?.message ?? String(error);
  const httpCode = typeof error?.httpCode === 'number' ? error.httpCode : 500;
  emitError({
    code,
    message: `connect_runner: ${verb} failed: ${message}`,
    httpCode,
  });
  return 1;
}

// ----- main dispatch -------------------------------------------------------

(async () => {
  let code;
  try {
    switch (action) {
      case 'preview':
        code = await runPreview(request);
        break;
      case 'apply':
        code = await runApply(request);
        break;
      case 'rollback':
        code = await runRollback(request);
        break;
      default:
        emitError({
          code: 'UNKNOWN_ACTION',
          message: `connect_runner: unknown action ${action}`,
          httpCode: 400,
        });
        code = 1;
    }
  } catch (error) {
    emitError({
      code: 'INTERNAL',
      message: `connect_runner: unhandled: ${error?.message ?? String(error)}`,
      httpCode: 500,
    });
    code = 1;
  }
  process.exit(code);
})();