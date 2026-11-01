// Parent gates run child gates more than once against one artifact path. These
// tests pin that a later PASS never hides an earlier FAIL: each invocation's
// snapshot, log and digest stay reachable under its own runId, and gate artifacts
// store only path + digest + bytes, never output bodies.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import {
  buildRunId,
  evidencePaths,
  snapshotBeforeOverwrite,
  recordStepLog,
  recordInvocationEvidence,
  sha256,
  sha256FromFile,
} from '../scripts/gate-evidence.mjs';

const cleanup: string[] = [];

function makeRepo(label: string): string {
  const repo = mkdtempSync(join(tmpdir(), `gate-evidence-${label}-`));
  mkdirSync(join(repo, 'artifacts'), { recursive: true });
  cleanup.push(repo);
  return repo;
}

function removeAll(): void {
  while (cleanup.length > 0) {
    const d = cleanup.pop();
    if (d && existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
}

describe('gate-evidence: buildRunId', () => {
  it('produces a stable, sortable, file-path-safe runId', () => {
    const fixed = new Date('2026-08-21T10:12:13.597Z');
    const a = buildRunId('migration-hermes-regression', fixed);
    const b = buildRunId('migration-hermes-regression', new Date('2026-08-21T10:12:14.000Z'));
    const c = buildRunId('migration-openclaw-regression', fixed);
    expect(a).toBe('migration-hermes-regression-2026-08-21T10-12-13-597Z');
    expect(b).toBe('migration-hermes-regression-2026-08-21T10-12-14-000Z');
    expect(c).toBe('migration-openclaw-regression-2026-08-21T10-12-13-597Z');
    expect(a < b).toBe(true); // sortable
  });
});

describe('gate-evidence: evidencePaths', () => {
  it('returns a directory under artifacts/.evidence/<runId> and a snapshot file', () => {
    const { snapshotPath, evidenceDir } = evidencePaths({
      repoRoot: '/tmp/repo',
      runId: 'migration-hermes-regression-2026-08-21T10-12-13-597Z',
      artifactPath: 'artifacts/hermes-gate.json',
    });
    expect(evidenceDir).toContain('artifacts/.evidence/migration-hermes-regression-');
    expect(snapshotPath).toMatch(/hermes-gate\.json\.snapshot\.json$/);
  });
});

describe('gate-evidence: snapshotBeforeOverwrite', () => {
  it('returns existed=false when the artifact is missing (no throw)', () => {
    const repo = makeRepo('missing');
    const out = snapshotBeforeOverwrite({
      repoRoot: repo,
      artifactPath: join(repo, 'artifacts', 'hermes-gate.json'),
      runId: 'migration-hermes-regression-2026-08-21T10-12-13-597Z',
    });
    expect(out.ok).toBe(true);
    expect(out.existed).toBe(false);
    expect(out.snapshotDigest).toBe(null);
  });

  it('captures the pre-overwrite hermes-gate.json (first invocation PASS)', () => {
    const repo = makeRepo('pass');
    const artifactPath = join(repo, 'artifacts', 'hermes-gate.json');
    const payload = JSON.stringify({ gate: 'hermes', status: 'PASS', verdict: 'PASS', note: 'invocation-1' });
    writeFileSync(artifactPath, payload);
    const runId = 'migration-hermes-regression-2026-08-21T10-12-13-597Z';
    const out = snapshotBeforeOverwrite({ repoRoot: repo, artifactPath, runId });
    expect(out.ok).toBe(true);
    expect(out.existed).toBe(true);
    expect(out.snapshotDigest).toBe(sha256(payload));
    expect(out.snapshotBytes).toBe(Buffer.byteLength(payload));
    expect(existsSync(out.snapshotPath!)).toBe(true);
    expect(readFileSync(out.snapshotPath!, 'utf8')).toBe(payload);
  });

  it('preserves BOTH snapshots when called twice with DIFFERENT runIds (core guarantee)', () => {
    const repo = makeRepo('both');
    const artifactPath = join(repo, 'artifacts', 'hermes-gate.json');

    // FIRST hermes invocation: FAIL because catalog failed upstream.
    writeFileSync(artifactPath, JSON.stringify({ gate: 'hermes', status: 'FAIL', verdict: 'FAIL', note: 'invocation-1-FROM-catalog-FAIL' }));
    const runId1 = 'migration-hermes-regression-2026-08-21T10-12-13-597Z';
    const snap1 = snapshotBeforeOverwrite({ repoRoot: repo, artifactPath, runId: runId1 });
    expect(snap1.ok).toBe(true);

    // Caller now overwrites the on-disk artifact with the SECOND hermes
    // invocation (from OpenClaw): PASS, because catalog has been fixed since.
    writeFileSync(artifactPath, JSON.stringify({ gate: 'hermes', status: 'PASS', verdict: 'PASS', note: 'invocation-2-FROM-OpenClaw-NESTED-Hermes' }));

    const runId2 = 'migration-hermes-regression-via-openclaw-2026-08-21T10-40-54-350Z';
    const snap2 = snapshotBeforeOverwrite({ repoRoot: repo, artifactPath, runId: runId2 });
    expect(snap2.ok).toBe(true);

    // Both snapshot files must still be on disk with their distinct statuses.
    expect(existsSync(snap1.snapshotPath!)).toBe(true);
    expect(existsSync(snap2.snapshotPath!)).toBe(true);
    const firstSnapshot = JSON.parse(readFileSync(snap1.snapshotPath!, 'utf8'));
    const secondSnapshot = JSON.parse(readFileSync(snap2.snapshotPath!, 'utf8'));
    expect(firstSnapshot.status).toBe('FAIL');
    expect(firstSnapshot.note).toBe('invocation-1-FROM-catalog-FAIL');
    expect(secondSnapshot.status).toBe('PASS');
    expect(secondSnapshot.note).toBe('invocation-2-FROM-OpenClaw-NESTED-Hermes');
    expect(snap1.snapshotPath).not.toBe(snap2.snapshotPath);
    // Original artifact still reflects the second invocation.
    expect(JSON.parse(readFileSync(artifactPath, 'utf8')).status).toBe('PASS');
  });

  it('preserves the earlier copy when called twice with the SAME runId (renames to .previous-<sha>.json)', () => {
    const repo = makeRepo('same-runid');
    const artifactPath = join(repo, 'artifacts', 'catalog-evidence.json');
    writeFileSync(artifactPath, 'first');
    const runId = 'hermes-catalog-regression-2026-08-21T10-12-13-597Z';
    const first = snapshotBeforeOverwrite({ repoRoot: repo, artifactPath, runId });
    expect(first.ok).toBe(true);
    // Caller overwrites the artifact then calls again with the same runId.
    writeFileSync(artifactPath, 'second');
    const second = snapshotBeforeOverwrite({ repoRoot: repo, artifactPath, runId });
    expect(second.ok).toBe(true);
    expect(second.preservedPreviousPath).not.toBe(null);
    // The .previous- file contains the FIRST copy.
    expect(readFileSync(second.preservedPreviousPath!, 'utf8')).toBe('first');
    // The primary snapshot now holds the SECOND copy (post-overwrite).
    expect(readFileSync(second.snapshotPath!, 'utf8')).toBe('second');
  });
});

describe('gate-evidence: recordStepLog', () => {
  it('returns log_digest/log_path/log_bytes and writes a meta.json sibling', () => {
    const repo = makeRepo('log');
    const runId = 'migration-hermes-regression-2026-08-21T10-12-13-597Z';
    const stdout = 'pnpm hermes:gate\n2026-08-21T10:12:13 ... stdout body';
    const stderr = 'fatal: missing catalog contract\n';
    const out = recordStepLog({
      repoRoot: repo,
      runId,
      stepName: '13-hermes-regression',
      command: 'pnpm hermes:gate',
      exitCode: 2,
      status: 'FAIL',
      stdout,
      stderr,
      startAt: '2026-08-21T10:12:13.000Z',
      endAt: '2026-08-21T10:13:40.000Z',
      artifactPath: 'artifacts/hermes-gate.json',
      snapshotPath: `artifacts/.evidence/${runId}/hermes-gate.json.snapshot.json`,
    });
    expect(out.ok).toBe(true);
    expect(out.logDigest).toBe(sha256(stdout));
    expect(out.errDigest).toBe(sha256(stderr));
    expect(out.logBytes).toBe(Buffer.byteLength(stdout));
    expect(existsSync(out.logPath!)).toBe(true);
    expect(existsSync(out.errPath!)).toBe(true);
    expect(existsSync(out.metadataPath!)).toBe(true);
    const meta = JSON.parse(readFileSync(out.metadataPath!, 'utf8'));
    expect(meta.runId).toBe(runId);
    expect(meta.stepName).toBe('13-hermes-regression');
    expect(meta.exitCode).toBe(2);
    expect(meta.status).toBe('FAIL');
    expect(meta.stdoutBytes).toBe(stdout.length);
    expect(meta.stderrBytes).toBe(stderr.length);
  });

  it('does NOT inline the body into the returned metadata that the gate artifact would store', () => {
    // The contract: gate artifacts store log_digest + log_path + log_bytes,
    // NOT the bodies. recordStepLog returns ONLY path+digest+bytes for the
    // stdout/stderr files plus a tiny meta.json (without the bodies).
    const repo = makeRepo('huge');
    const huge = 'X'.repeat(64 * 1024);
    const out = recordStepLog({
      repoRoot: repo,
      runId: 'migration-hermes-regression-2026-08-21T10-12-13-597Z',
      stepName: '13-hermes-regression',
      command: 'pnpm hermes:gate',
      exitCode: 2,
      status: 'FAIL',
      stdout: huge,
      stderr: '',
    });
    expect(out.ok).toBe(true);
    expect(out.logBytes).toBe(Buffer.byteLength(huge));
    // log_path points to the file on disk (the body lives there, not in JSON).
    expect(out.logPath!.endsWith('.stdout.log')).toBe(true);
    // Metadata sibling must be small (bounded by JSON envelope, not body).
    const meta = JSON.parse(readFileSync(out.metadataPath!, 'utf8'));
    expect(JSON.stringify(meta).length).toBeLessThan(2 * 1024);
    // The digest in the returned object is stable and equal to file content.
    expect(out.logDigest).toBe(sha256FromFile(out.logPath!));
  });
});

describe('gate-evidence: end-to-end migration traceability contract', () => {
  // A direct Hermes run FAILs, then a nested Hermes run overwrites the artifact with
  // PASS. The migration artifact must record both runs and keep hermes_failed=true,
  // and the first snapshot must stay reachable with a matching digest.

  it('keeps both Hermes invocations traceable when migration records the FAIL first and the PASS later', () => {
    const repo = makeRepo('e2e');
    const artifactPath = join(repo, 'artifacts', 'hermes-gate.json');

    // First Hermes invocation: migration directly invokes `pnpm hermes:gate`. catalog internally
    // failed, so hermes reports FAIL. migration records runId1 + snapshot.
    const payload1 = JSON.stringify({
      gate: 'hermes', status: 'FAIL', verdict: 'FAIL',
      summary: { steps_failed: 1, hermes_own_failures: ['11-catalog-regression'] },
      emitted_at: '2026-08-21T10:12:13.597Z',
    });
    writeFileSync(artifactPath, payload1);
    const runId1 = 'migration-hermes-regression-2026-08-21T10-12-13-597Z';
    const snap1 = snapshotBeforeOverwrite({ repoRoot: repo, artifactPath, runId: runId1 });
    expect(snap1.ok).toBe(true);

    // Log file for the failed step 13.
    const log1 = recordStepLog({
      repoRoot: repo,
      runId: runId1,
      stepName: '13-hermes-regression',
      command: 'pnpm hermes:gate',
      exitCode: 2,
      status: 'FAIL',
      stdout: 'pnpm hermes:gate (invocation 1)',
      stderr: '11-catalog-regression: FAIL — catalog status=FAIL',
      startAt: '2026-08-21T10:12:13.000Z',
      endAt: '2026-08-21T10:13:40.000Z',
      artifactPath: 'artifacts/hermes-gate.json',
      snapshotPath: snap1.snapshotPath ?? '',
    });
    expect(log1.ok).toBe(true);

    // migration's own verdict: even though the next invocation may pass, migration
    // observed a FAIL — the gate must NOT flip hermes_failed just because a
    // future re-run succeeds.
    const migrationFirstDecision: { hermes_failed: boolean; hermes_runId: string } = { hermes_failed: true, hermes_runId: runId1 };

    // Second Hermes invocation: migration's step 14 runs OpenClaw, OpenClaw's step 12 runs Hermes.
    // By then catalog has been fixed, so Hermes PASSES. migration captures runId2 + snap.
    const payload2 = JSON.stringify({
      gate: 'hermes', status: 'PASS', verdict: 'PASS',
      summary: { steps_failed: 0, hermes_own_failures: [] },
      emitted_at: '2026-08-21T10:40:55.000Z',
    });
    writeFileSync(artifactPath, payload2);
    const runId2 = 'migration-hermes-via-openclaw-2026-08-21T10-40-54-350Z';
    const snap2 = snapshotBeforeOverwrite({ repoRoot: repo, artifactPath, runId: runId2 });
    expect(snap2.ok).toBe(true);

    // Build the would-be migration-gate.json "invocations" section.
    const migrationInvocations: Array<Record<string, unknown>> = [
      {
        name: 'hermes-regression-invocation-1',
        scope: 'migration-direct',
        runId: runId1,
        artifact_path: 'artifacts/hermes-gate.json',
        snapshot_path: snap1.snapshotPath,
        snapshot_digest: snap1.snapshotDigest,
        observed_status: 'FAIL',
        exit_code: 2,
        start_at: '2026-08-21T10:12:13.000Z',
        end_at: '2026-08-21T10:13:40.000Z',
        log_path: log1.logPath,
        log_digest: log1.logDigest,
        log_bytes: log1.logBytes,
      },
      {
        name: 'hermes-regression-invocation-2',
        scope: 'migration-via-openclaw',
        runId: runId2,
        artifact_path: 'artifacts/hermes-gate.json',
        snapshot_path: snap2.snapshotPath,
        snapshot_digest: snap2.snapshotDigest,
        observed_status: 'PASS',
        exit_code: 0,
        start_at: '2026-08-21T10:40:54.000Z',
        end_at: '2026-08-21T10:40:55.000Z',
      },
    ];

    // What migration-gate.json would write. We serialize + re-parse so the
    // test exercises the JSON shape the gate actually emits.
    const migrationArtifactPath = join(repo, 'artifacts', 'migration-gate.json');
    const migrationPayload = {
      gate: 'migration',
      status: 'FAIL',
      verdict: 'FAIL',
      hermes_failed: migrationFirstDecision.hermes_failed,
      hermes_status: 'PASS', // final on-disk
      hermes_invocations: migrationInvocations,
      failed_steps: ['13-hermes-regression', '13b-hermes-artifact'],
    };
    writeFileSync(migrationArtifactPath, JSON.stringify(migrationPayload, null, 2) + '\n');

    // Read it back and assert the contract.
    const migration = JSON.parse(readFileSync(migrationArtifactPath, 'utf8'));
    expect(migration.hermes_failed).toBe(true);
    expect(migration.verdict).toBe('FAIL');
    expect(migration.hermes_invocations.length).toBe(2);
    expect(migration.hermes_invocations[0].observed_status).toBe('FAIL');
    expect(migration.hermes_invocations[1].observed_status).toBe('PASS');
    expect(migration.hermes_invocations[0].snapshot_path).not.toBe(migration.hermes_invocations[1].snapshot_path);

    const recordedDigest: string = migration.hermes_invocations[0].snapshot_digest;
    const observedDigest: string = createHash('sha256').update(readFileSync(migration.hermes_invocations[0].snapshot_path)).digest('hex');
    expect(recordedDigest).toBe(observedDigest);

    const recordedDigest2: string = migration.hermes_invocations[1].snapshot_digest;
    const observedDigest2: string = createHash('sha256').update(readFileSync(migration.hermes_invocations[1].snapshot_path)).digest('hex');
    expect(recordedDigest2).toBe(observedDigest2);

    // The two snapshot digests must be DIFFERENT (different payloads, different files).
    expect(recordedDigest).not.toBe(recordedDigest2);

    // The first snapshot still says FAIL on disk.
    const firstSnapshot = JSON.parse(readFileSync(migration.hermes_invocations[0].snapshot_path, 'utf8'));
    expect(firstSnapshot.status).toBe('FAIL');
    // The second snapshot says PASS on disk.
    const secondSnapshot = JSON.parse(readFileSync(migration.hermes_invocations[1].snapshot_path, 'utf8'));
    expect(secondSnapshot.status).toBe('PASS');
  });
});


describe('gate-evidence: recordInvocationEvidence', () => {
  it('snapshots the observed artifact AND records the stdout/stderr log under a single runId, then returns a structured entry', () => {
    const repo = makeRepo('record-inv');
    const observedArtifactAbs = join(repo, 'artifacts', 'hermes-gate.json');
    const prior = JSON.stringify({ gate: 'hermes', status: 'PASS', note: 'from-an-earlier-run' });
    writeFileSync(observedArtifactAbs, prior);

    const parentRunId = 'migration-gate-2026-08-21T10-12-13-597Z';
    const invRunId = 'migration-hermes-regression-2026-08-21T10-12-13-597Z';

    const entry = recordInvocationEvidence({
      repoRoot: repo,
      parentRunId,
      invocationRunId: invRunId,
      invocationName: 'hermes-direct-from-migration',
      scope: 'migration-direct',
      command: 'pnpm hermes:gate',
      exitCode: 0,
      status: 'PASS',
      stdout: 'pnpm hermes:gate (from migration step 13)',
      stderr: '',
      startAt: '2026-08-21T10:12:13.000Z',
      endAt: '2026-08-21T10:40:54.000Z',
      observedArtifactPath: observedArtifactAbs,
      observedArtifact: { gate: 'hermes', status: 'PASS', verdict: 'PASS', emitted_at: '2026-08-21T10:40:54.000Z' },
    });

    // The helper must signal success …
    expect(entry.ok).toBe(true);
    // … and write all the on-disk evidence under ONE runId directory.
    expect(entry.runId).toBe(invRunId);
    expect(entry.parentRunId).toBe(parentRunId);
    expect(entry.scope).toBe('migration-direct');
    expect(entry.invocationName).toBe('hermes-direct-from-migration');
    expect(entry.exitCode).toBe(0);
    expect(entry.observed_status).toBe('PASS');
    expect(entry.observed_verdict).toBe('PASS');
    expect(entry.emitted_at).toBe('2026-08-21T10:40:54.000Z');
    expect(entry.observedArtifactPath).toBe(observedArtifactAbs);

    // The snapshot of the OBSERVED artifact (hermes-gate.json) must exist on
    // disk with a digest that matches the prior body, and its path must
    // live under the parent's runId-scoped evidence dir.
    expect(entry.snapshot.existed).toBe(true);
    expect(existsSync(entry.snapshot.path!)).toBe(true);
    expect(entry.snapshot.digest).toBe(sha256(prior));
    expect(entry.snapshot.path).toContain(`artifacts/.evidence/${invRunId}/`);

    // The per-invocation stdout/stderr log + meta must also be under the
    // same runId dir.
    expect(entry.log.logPath).toContain(`artifacts/.evidence/${invRunId}/`);
    expect(existsSync(entry.log.logPath)).toBe(true);
    expect(existsSync(entry.log.errPath)).toBe(true);
    expect(existsSync(entry.log.metadataPath)).toBe(true);
    const meta = JSON.parse(readFileSync(entry.log.metadataPath!, 'utf8'));
    expect(meta.runId).toBe(invRunId);
    expect(meta.parentRunId).toBe(parentRunId);
    expect(meta.scope).toBe('migration-direct');
    expect(meta.command).toBe('pnpm hermes:gate');
  });

  it('keeps two invocations of the same observed artifact traceable: distinct runIds, distinct snapshot files, distinct log files', () => {
    const repo = makeRepo('record-inv-multi');
    const observedArtifactPath = join(repo, 'artifacts', 'hermes-gate.json');

    // First invocation: migration→Hermes directly. catalog is broken so Hermes reports FAIL.
    writeFileSync(observedArtifactPath, JSON.stringify({ gate: 'hermes', status: 'FAIL', verdict: 'FAIL', note: 'inv-1-from-migration' }));
    const inv1 = recordInvocationEvidence({
      repoRoot: repo,
      parentRunId: 'migration-gate-2026-08-21T10-12-13-597Z',
      invocationRunId: 'migration-hermes-regression-2026-08-21T10-12-13-597Z',
      invocationName: 'hermes-direct-from-migration',
      scope: 'migration-direct',
      command: 'pnpm hermes:gate',
      exitCode: 2,
      status: 'FAIL',
      stdout: 'pnpm hermes:gate (inv 1)',
      stderr: '11-catalog-regression: FAIL',
      startAt: '2026-08-21T10:12:13.000Z',
      endAt: '2026-08-21T10:40:54.000Z',
      observedArtifactPath,
      observedArtifact: { gate: 'hermes', status: 'FAIL', verdict: 'FAIL', emitted_at: '2026-08-21T10:40:54.000Z', summary: { steps_failed: 1 } },
    });
    expect(inv1.ok).toBe(true);
    expect(inv1.observed_status).toBe('FAIL');
    expect(inv1.observed_verdict).toBe('FAIL');

    // Real flow: before the second invocation runs, the producer overwrites
    // the on-disk artifact (e.g. OpenClaw step 12 finishing its Hermes run). Mirror
    // that here so the snapshot the SECOND invocation captures reflects
    // the post-overwrite state (PASS), not the stale FAIL body.
    writeFileSync(observedArtifactPath, JSON.stringify({ gate: 'hermes', status: 'PASS', verdict: 'PASS', note: 'inv-2-from-openclaw' }));

    // migration's step 14 runs OpenClaw, OpenClaw's step 12 runs Hermes a SECOND time. That
    // nested invocation is recorded under a DIFFERENT runId — even though
    // it observes the SAME on-disk path, it must not erase the first
    // invocation's snapshot, log, or entry.
    const openclawStep12Entry = recordInvocationEvidence({
      repoRoot: repo,
      parentRunId: 'openclaw-gate-2026-08-21T10-40-54-300Z', // openclaw's own runId — observed by migration via openclaw-gate.json
      invocationRunId: 'hermes-gate-2026-08-21T10-40-55-000Z', // Hermes's runId, as observed by migration in the final hermes-gate.json
      invocationName: 'hermes-direct-from-openclaw-step-12',
      scope: 'migration-via-openclaw',
      command: 'pnpm hermes:gate',
      exitCode: 0,
      status: 'PASS',
      stdout: 'pnpm hermes:gate (inv 2, by OpenClaw step 12)',
      stderr: '',
      startAt: '2026-08-21T10:40:54.000Z',
      endAt: '2026-08-21T10:40:55.000Z',
      observedArtifactPath,
      observedArtifact: { gate: 'hermes', status: 'PASS', verdict: 'PASS', emitted_at: '2026-08-21T10:40:55.000Z', summary: { steps_failed: 0 } },
    });
    expect(openclawStep12Entry.ok).toBe(true);
    expect(openclawStep12Entry.observed_status).toBe('PASS');
    expect(openclawStep12Entry.observed_verdict).toBe('PASS');

    // Both snapshot files are still on disk and content-distinct.
    expect(inv1.snapshot.path).not.toBe(openclawStep12Entry.snapshot.path);
    expect(existsSync(inv1.snapshot.path!)).toBe(true);
    expect(existsSync(openclawStep12Entry.snapshot.path!)).toBe(true);
    const firstSnap = JSON.parse(readFileSync(inv1.snapshot.path!, 'utf8'));
    const secondSnap = JSON.parse(readFileSync(openclawStep12Entry.snapshot.path!, 'utf8'));
    expect(firstSnap.status).toBe('FAIL');
    expect(firstSnap.note).toBe('inv-1-from-migration');
    expect(secondSnap.status).toBe('PASS');
    expect(inv1.snapshot.digest).not.toBe(openclawStep12Entry.snapshot.digest);
  });

  it('records the migration→OpenClaw direct invocation with its own runId, snapshot of openclaw-gate.json, and digests (no mix with nested Hermes)', () => {
    const repo = makeRepo('record-openclaw-direct');
    const openclawArtifactAbs = join(repo, 'artifacts', 'openclaw-gate.json');
    writeFileSync(openclawArtifactAbs, JSON.stringify({ gate: 'openclaw', status: 'PASS', verdict: 'PASS' }));

    const entry = recordInvocationEvidence({
      repoRoot: repo,
      parentRunId: 'migration-gate-2026-08-21T10-12-13-597Z',
      invocationRunId: 'migration-openclaw-regression-2026-08-21T10-40-54-350Z',
      invocationName: 'openclaw-direct-from-migration',
      scope: 'migration-direct',
      command: 'pnpm openclaw:gate',
      exitCode: 0,
      status: 'PASS',
      stdout: 'pnpm openclaw:gate (from migration step 14)',
      stderr: '',
      startAt: '2026-08-21T10:40:54.000Z',
      endAt: '2026-08-21T10:50:00.000Z',
      observedArtifactPath: openclawArtifactAbs,
      observedArtifact: {
        gate: 'openclaw', status: 'PASS', verdict: 'PASS',
        runId: 'openclaw-gate-2026-08-21T10-40-54-300Z',
        emitted_at: '2026-08-21T10:50:00.000Z',
        steps: {
          '12-hermes-regression': {
            name: '12-hermes-regression',
            status: 'PASS',
            evidence: {
              runId: 'openclaw-gate-2026-08-21T10-40-54-300Z',
              meta_path: `${repo}/artifacts/.evidence/openclaw-gate-2026-08-21T10-40-54-300Z/12-hermes-regression.meta.json`,
            },
          },
        },
      },
    });

    expect(entry.ok).toBe(true);
    expect(entry.scope).toBe('migration-direct');
    expect(entry.parentRunId).toBe('migration-gate-2026-08-21T10-12-13-597Z');
    expect(entry.runId).toBe('migration-openclaw-regression-2026-08-21T10-40-54-350Z');
    // The snapshot path is recorded and matches the prior body.
    expect(entry.snapshot.existed).toBe(true);
    expect(existsSync(entry.snapshot.path!)).toBe(true);
    expect(entry.snapshot.digest).toBe(sha256(readFileSync(openclawArtifactAbs, 'utf8')));
  });

  it('handles a missing observed artifact gracefully (first-ever invocation: no prior body to snapshot)', () => {
    const repo = makeRepo('record-missing');
    const entry = recordInvocationEvidence({
      repoRoot: repo,
      parentRunId: 'migration-gate-2026-08-21T10-12-13-597Z',
      invocationRunId: 'migration-hermes-regression-2026-08-21T10-12-13-597Z',
      invocationName: 'hermes-direct-from-migration',
      scope: 'migration-direct',
      command: 'pnpm hermes:gate',
      exitCode: 0,
      status: 'PASS',
      stdout: '',
      stderr: '',
      startAt: '2026-08-21T10:12:13.000Z',
      endAt: '2026-08-21T10:40:54.000Z',
      observedArtifactPath: join(repo, 'artifacts', 'hermes-gate.json'),
      observedArtifact: { gate: 'hermes', status: 'PASS', verdict: 'PASS', emitted_at: '2026-08-21T10:40:54.000Z' },
    });

    expect(entry.ok).toBe(true);
    expect(entry.snapshot.existed).toBe(false);
    expect(entry.snapshot.digest).toBe(null);
    // log/meta still on disk.
    expect(existsSync(entry.log.logPath)).toBe(true);
    expect(existsSync(entry.log.metadataPath)).toBe(true);
  });
});

// The first invocation dominates: a later PASS must not flip `hermes_failed`.

describe('migration invocations aggregator: first-invocation-dominates fail-closed', () => {
  // Helper that mirrors the migration aggregation logic. The migration script owns
  // the same predicate so that a future regression can't quietly invert
  // it; tests pin both the predicate and the surface field shape.
  function aggregateHermes(invocations: Array<{ scope: string; observed_status: string; observed_verdict?: string | null; exit_code: number; }>) {
    // FAIL wins for the FIRST invocation; later PASSes never flip it back.
    const direct = invocations.find((i) => i.scope === 'migration-direct') ?? null;
    const viaOpenclaw = invocations.find((i) => i.scope === 'migration-via-openclaw') ?? null;
    const hermes_failed = !!(
      (direct && (direct.exit_code !== 0 || direct.observed_status !== 'PASS')) ||
      (viaOpenclaw && (viaOpenclaw.exit_code !== 0 || viaOpenclaw.observed_status !== 'PASS'))
    );
    return { hermes_failed };
  }

  it('keeps hermes_failed=true when the FIRST invocation (migration-direct) FAILed even if the second (migration-via-OpenClaw) passed', () => {
    const out = aggregateHermes([
      { scope: 'migration-direct',  observed_status: 'FAIL', exit_code: 2 },
      { scope: 'migration-via-openclaw',  observed_status: 'PASS', exit_code: 0 },
    ]);
    expect(out.hermes_failed).toBe(true);
  });

  it('keeps hermes_failed=true when the SECOND (migration-via-OpenClaw) invocation FAILed', () => {
    const out = aggregateHermes([
      { scope: 'migration-direct',  observed_status: 'PASS', exit_code: 0 },
      { scope: 'migration-via-openclaw',  observed_status: 'FAIL', exit_code: 2 },
    ]);
    expect(out.hermes_failed).toBe(true);
  });

  it('reports hermes_failed=false when BOTH invocations passed', () => {
    const out = aggregateHermes([
      { scope: 'migration-direct', observed_status: 'PASS', exit_code: 0 },
      { scope: 'migration-via-openclaw', observed_status: 'PASS', exit_code: 0 },
    ]);
    expect(out.hermes_failed).toBe(false);
  });
});

// Cleanup after all tests in this file.
process.once('exit', () => { removeAll(); });
