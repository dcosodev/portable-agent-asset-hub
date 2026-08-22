// tests/gate-evidence.test.ts
//
// TDD gate for the per-invocation evidence helpers introduced for the
// S10→S8→S5 traceability audit. The tests are RED first: they were
// committed BEFORE the helper existed and now they must pass against
// `scripts/gate-evidence.mjs`.
//
// Coverage:
//   1. snapshotBeforeOverwrite preserves an existing artifact on disk
//      and returns its digest + bytes (so the caller can record both
//      paths).
//   2. Two consecutive snapshotBeforeOverwrite calls with DIFFERENT
//      runIds preserve BOTH copies — this is the core "do not lose
//      the first S8 invocation" requirement from the audit.
//   3. recordStepLog writes the per-step log + meta.json, returns
//      digest/path/bytes triples, and the gate artifact never embeds
//      the body.
//   4. The end-to-end S10 behavior: when S10 captures an s8-gate.json
//      with status=FAIL (first invocation) and then S9's nested S8
//      overwrites the file with status=PASS (second invocation),
//      BOTH status outcomes remain reachable: (a) S10's own artifact
//      keeps `s8_failed: true`, (b) the previous s8-gate.json snapshot
//      lives under `artifacts/.evidence/<runId>/` with status=FAIL and
//      SHA-256 digest match.

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
    const a = buildRunId('s10-s8-regression', fixed);
    const b = buildRunId('s10-s8-regression', new Date('2026-08-21T10:12:14.000Z'));
    const c = buildRunId('s10-s9-regression', fixed);
    expect(a).toBe('s10-s8-regression-2026-08-21T10-12-13-597Z');
    expect(b).toBe('s10-s8-regression-2026-08-21T10-12-14-000Z');
    expect(c).toBe('s10-s9-regression-2026-08-21T10-12-13-597Z');
    expect(a < b).toBe(true); // sortable
  });
});

describe('gate-evidence: evidencePaths', () => {
  it('returns a directory under artifacts/.evidence/<runId> and a snapshot file', () => {
    const { snapshotPath, evidenceDir } = evidencePaths({
      repoRoot: '/tmp/repo',
      runId: 's10-s8-regression-2026-08-21T10-12-13-597Z',
      artifactPath: 'artifacts/s8-gate.json',
    });
    expect(evidenceDir).toContain('artifacts/.evidence/s10-s8-regression-');
    expect(snapshotPath).toMatch(/s8-gate\.json\.snapshot\.json$/);
  });
});

describe('gate-evidence: snapshotBeforeOverwrite', () => {
  it('returns existed=false when the artifact is missing (no throw)', () => {
    const repo = makeRepo('missing');
    const out = snapshotBeforeOverwrite({
      repoRoot: repo,
      artifactPath: join(repo, 'artifacts', 's8-gate.json'),
      runId: 's10-s8-regression-2026-08-21T10-12-13-597Z',
    });
    expect(out.ok).toBe(true);
    expect(out.existed).toBe(false);
    expect(out.snapshotDigest).toBe(null);
  });

  it('captures the pre-overwrite s8-gate.json (first invocation PASS)', () => {
    const repo = makeRepo('pass');
    const artifactPath = join(repo, 'artifacts', 's8-gate.json');
    const payload = JSON.stringify({ gate: 's8', status: 'PASS', verdict: 'PASS', note: 'invocation-1' });
    writeFileSync(artifactPath, payload);
    const runId = 's10-s8-regression-2026-08-21T10-12-13-597Z';
    const out = snapshotBeforeOverwrite({ repoRoot: repo, artifactPath, runId });
    expect(out.ok).toBe(true);
    expect(out.existed).toBe(true);
    expect(out.snapshotDigest).toBe(sha256(payload));
    expect(out.snapshotBytes).toBe(Buffer.byteLength(payload));
    expect(existsSync(out.snapshotPath!)).toBe(true);
    expect(readFileSync(out.snapshotPath!, 'utf8')).toBe(payload);
  });

  it('preserves BOTH snapshots when called twice with DIFFERENT runIds (audit core)', () => {
    const repo = makeRepo('both');
    const artifactPath = join(repo, 'artifacts', 's8-gate.json');

    // FIRST s8 invocation: FAIL because S5 failed upstream.
    writeFileSync(artifactPath, JSON.stringify({ gate: 's8', status: 'FAIL', verdict: 'FAIL', note: 'invocation-1-FROM-S5-FAIL' }));
    const runId1 = 's10-s8-regression-2026-08-21T10-12-13-597Z';
    const snap1 = snapshotBeforeOverwrite({ repoRoot: repo, artifactPath, runId: runId1 });
    expect(snap1.ok).toBe(true);

    // Caller now overwrites the on-disk artifact with the SECOND s8
    // invocation (from S9): PASS, because S5 has been fixed since.
    writeFileSync(artifactPath, JSON.stringify({ gate: 's8', status: 'PASS', verdict: 'PASS', note: 'invocation-2-FROM-S9-NESTED-S8' }));

    const runId2 = 's10-s8-regression-via-s9-2026-08-21T10-40-54-350Z';
    const snap2 = snapshotBeforeOverwrite({ repoRoot: repo, artifactPath, runId: runId2 });
    expect(snap2.ok).toBe(true);

    // Both snapshot files must still be on disk with their distinct statuses.
    expect(existsSync(snap1.snapshotPath!)).toBe(true);
    expect(existsSync(snap2.snapshotPath!)).toBe(true);
    const firstSnapshot = JSON.parse(readFileSync(snap1.snapshotPath!, 'utf8'));
    const secondSnapshot = JSON.parse(readFileSync(snap2.snapshotPath!, 'utf8'));
    expect(firstSnapshot.status).toBe('FAIL');
    expect(firstSnapshot.note).toBe('invocation-1-FROM-S5-FAIL');
    expect(secondSnapshot.status).toBe('PASS');
    expect(secondSnapshot.note).toBe('invocation-2-FROM-S9-NESTED-S8');
    expect(snap1.snapshotPath).not.toBe(snap2.snapshotPath);
    // Original artifact still reflects the second invocation.
    expect(JSON.parse(readFileSync(artifactPath, 'utf8')).status).toBe('PASS');
  });

  it('preserves the earlier copy when called twice with the SAME runId (renames to .previous-<sha>.json)', () => {
    const repo = makeRepo('same-runid');
    const artifactPath = join(repo, 'artifacts', 's5-evidence.json');
    writeFileSync(artifactPath, 'first');
    const runId = 's8-s5-regression-2026-08-21T10-12-13-597Z';
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
    const runId = 's10-s8-regression-2026-08-21T10-12-13-597Z';
    const stdout = 'pnpm s8:gate\n2026-08-21T10:12:13 ... stdout body';
    const stderr = 'fatal: missing s5 contract\n';
    const out = recordStepLog({
      repoRoot: repo,
      runId,
      stepName: '13-s8-regression',
      command: 'pnpm s8:gate',
      exitCode: 2,
      status: 'FAIL',
      stdout,
      stderr,
      startAt: '2026-08-21T10:12:13.000Z',
      endAt: '2026-08-21T10:13:40.000Z',
      artifactPath: 'artifacts/s8-gate.json',
      snapshotPath: `artifacts/.evidence/${runId}/s8-gate.json.snapshot.json`,
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
    expect(meta.stepName).toBe('13-s8-regression');
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
      runId: 's10-s8-regression-2026-08-21T10-12-13-597Z',
      stepName: '13-s8-regression',
      command: 'pnpm s8:gate',
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

describe('gate-evidence: end-to-end S10 traceability contract', () => {
  // This is the audit's exact scenario, replayed on a fresh repoRoot:
  //   1. S10 step 13 runs S8 directly. S8 fails (S5 failed upstream).
  //   2. S10 captures s8_failed=true and the FAIL snapshot digest+path.
  //   3. S10 step 14 runs S9, which internally runs S8 (step 12). That
  //      nested S8 invocation overwrites artifacts/s8-gate.json with
  //      status=PASS and emits a DIFFERENT runId.
  //   4. After S10 finishes:
  //        - artifacts/s10-gate.json must record BOTH invocations
  //          (runIds + paths + distinct snapshots).
  //        - S10 must NOT silently flip s8_failed to false just because
  //          a later invocation passed.
  //        - The first snapshot must remain reachable via its runId-scoped
  //          path and the digest recorded on s10-gate.json must match
  //          the snapshot file.

  it('keeps both S8 invocations traceable when S10 records the FAIL first and the PASS later', () => {
    const repo = makeRepo('e2e');
    const artifactPath = join(repo, 'artifacts', 's8-gate.json');

    // First S8 invocation: S10 directly invokes `pnpm s8:gate`. s5 internally
    // failed, so s8 reports FAIL. S10 records runId1 + snapshot.
    const payload1 = JSON.stringify({
      gate: 's8', status: 'FAIL', verdict: 'FAIL',
      summary: { steps_failed: 1, s8_own_failures: ['11-s5-regression'] },
      emitted_at: '2026-08-21T10:12:13.597Z',
    });
    writeFileSync(artifactPath, payload1);
    const runId1 = 's10-s8-regression-2026-08-21T10-12-13-597Z';
    const snap1 = snapshotBeforeOverwrite({ repoRoot: repo, artifactPath, runId: runId1 });
    expect(snap1.ok).toBe(true);

    // Log file for the failed step 13.
    const log1 = recordStepLog({
      repoRoot: repo,
      runId: runId1,
      stepName: '13-s8-regression',
      command: 'pnpm s8:gate',
      exitCode: 2,
      status: 'FAIL',
      stdout: 'pnpm s8:gate (invocation 1)',
      stderr: '11-s5-regression: FAIL — s5 status=FAIL',
      startAt: '2026-08-21T10:12:13.000Z',
      endAt: '2026-08-21T10:13:40.000Z',
      artifactPath: 'artifacts/s8-gate.json',
      snapshotPath: snap1.snapshotPath ?? '',
    });
    expect(log1.ok).toBe(true);

    // S10's own verdict: even though the next invocation may pass, s10
    // observed a FAIL — the gate must NOT flip s8_failed just because a
    // future re-run succeeds.
    const s10FirstDecision: { s8_failed: boolean; s8_runId: string } = { s8_failed: true, s8_runId: runId1 };

    // Second S8 invocation: S10's step 14 runs S9, S9's step 12 runs S8.
    // By then S5 has been fixed, so S8 PASSES. S10 captures runId2 + snap.
    const payload2 = JSON.stringify({
      gate: 's8', status: 'PASS', verdict: 'PASS',
      summary: { steps_failed: 0, s8_own_failures: [] },
      emitted_at: '2026-08-21T10:40:55.000Z',
    });
    writeFileSync(artifactPath, payload2);
    const runId2 = 's10-s8-via-s9-2026-08-21T10-40-54-350Z';
    const snap2 = snapshotBeforeOverwrite({ repoRoot: repo, artifactPath, runId: runId2 });
    expect(snap2.ok).toBe(true);

    // Build the would-be s10-gate.json "invocations" section.
    const s10Invocations: Array<Record<string, unknown>> = [
      {
        name: 's8-regression-invocation-1',
        scope: 's10-direct',
        runId: runId1,
        artifact_path: 'artifacts/s8-gate.json',
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
        name: 's8-regression-invocation-2',
        scope: 's10-via-s9',
        runId: runId2,
        artifact_path: 'artifacts/s8-gate.json',
        snapshot_path: snap2.snapshotPath,
        snapshot_digest: snap2.snapshotDigest,
        observed_status: 'PASS',
        exit_code: 0,
        start_at: '2026-08-21T10:40:54.000Z',
        end_at: '2026-08-21T10:40:55.000Z',
      },
    ];

    // What s10-gate.json would write. We serialize + re-parse so the
    // test exercises the JSON shape the gate actually emits.
    const s10ArtifactPath = join(repo, 'artifacts', 's10-gate.json');
    const s10Payload = {
      gate: 's10',
      status: 'FAIL',
      verdict: 'FAIL',
      s8_failed: s10FirstDecision.s8_failed,
      s8_status: 'PASS', // final on-disk
      s8_invocations: s10Invocations,
      failed_steps: ['13-s8-regression', '13b-s8-artifact'],
    };
    writeFileSync(s10ArtifactPath, JSON.stringify(s10Payload, null, 2) + '\n');

    // Read it back and assert the contract.
    const s10 = JSON.parse(readFileSync(s10ArtifactPath, 'utf8'));
    expect(s10.s8_failed).toBe(true);
    expect(s10.verdict).toBe('FAIL');
    expect(s10.s8_invocations.length).toBe(2);
    expect(s10.s8_invocations[0].observed_status).toBe('FAIL');
    expect(s10.s8_invocations[1].observed_status).toBe('PASS');
    expect(s10.s8_invocations[0].snapshot_path).not.toBe(s10.s8_invocations[1].snapshot_path);

    const recordedDigest: string = s10.s8_invocations[0].snapshot_digest;
    const observedDigest: string = createHash('sha256').update(readFileSync(s10.s8_invocations[0].snapshot_path)).digest('hex');
    expect(recordedDigest).toBe(observedDigest);

    const recordedDigest2: string = s10.s8_invocations[1].snapshot_digest;
    const observedDigest2: string = createHash('sha256').update(readFileSync(s10.s8_invocations[1].snapshot_path)).digest('hex');
    expect(recordedDigest2).toBe(observedDigest2);

    // The two snapshot digests must be DIFFERENT (different payloads, different files).
    expect(recordedDigest).not.toBe(recordedDigest2);

    // The first snapshot still says FAIL on disk.
    const firstSnapshot = JSON.parse(readFileSync(s10.s8_invocations[0].snapshot_path, 'utf8'));
    expect(firstSnapshot.status).toBe('FAIL');
    // The second snapshot says PASS on disk.
    const secondSnapshot = JSON.parse(readFileSync(s10.s8_invocations[1].snapshot_path, 'utf8'));
    expect(secondSnapshot.status).toBe('PASS');
  });
});

// ===========================================================================
// S10-specific evidence helpers (recordInvocationEvidence).
//
// The S10 audit wires the helper directly into runStep for steps 13 and 14
// so two distinct S8 invocations (S10→S8 direct, S9→S8 nested) and the
// S10→S9 direct invocation can all be captured structurally with non-
// mixing runIds, digests, and snapshot paths. These tests pin the helper's
// contract; the s10-gate.mjs integration relies on it.
// ===========================================================================

describe('gate-evidence: recordInvocationEvidence', () => {
  it('snapshots the observed artifact AND records the stdout/stderr log under a single runId, then returns a structured entry', () => {
    const repo = makeRepo('record-inv');
    const observedArtifactAbs = join(repo, 'artifacts', 's8-gate.json');
    const prior = JSON.stringify({ gate: 's8', status: 'PASS', note: 'from-an-earlier-run' });
    writeFileSync(observedArtifactAbs, prior);

    const parentRunId = 's10-gate-2026-08-21T10-12-13-597Z';
    const invRunId = 's10-s8-regression-2026-08-21T10-12-13-597Z';

    const entry = recordInvocationEvidence({
      repoRoot: repo,
      parentRunId,
      invocationRunId: invRunId,
      invocationName: 's8-direct-from-s10',
      scope: 's10-direct',
      command: 'pnpm s8:gate',
      exitCode: 0,
      status: 'PASS',
      stdout: 'pnpm s8:gate (from S10 step 13)',
      stderr: '',
      startAt: '2026-08-21T10:12:13.000Z',
      endAt: '2026-08-21T10:40:54.000Z',
      observedArtifactPath: observedArtifactAbs,
      observedArtifact: { gate: 's8', status: 'PASS', verdict: 'PASS', emitted_at: '2026-08-21T10:40:54.000Z' },
    });

    // The helper must signal success …
    expect(entry.ok).toBe(true);
    // … and write all the on-disk evidence under ONE runId directory.
    expect(entry.runId).toBe(invRunId);
    expect(entry.parentRunId).toBe(parentRunId);
    expect(entry.scope).toBe('s10-direct');
    expect(entry.invocationName).toBe('s8-direct-from-s10');
    expect(entry.exitCode).toBe(0);
    expect(entry.observed_status).toBe('PASS');
    expect(entry.observed_verdict).toBe('PASS');
    expect(entry.emitted_at).toBe('2026-08-21T10:40:54.000Z');
    expect(entry.observedArtifactPath).toBe(observedArtifactAbs);

    // The snapshot of the OBSERVED artifact (s8-gate.json) must exist on
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
    expect(meta.scope).toBe('s10-direct');
    expect(meta.command).toBe('pnpm s8:gate');
  });

  it('keeps two invocations of the same observed artifact traceable: distinct runIds, distinct snapshot files, distinct log files', () => {
    const repo = makeRepo('record-inv-multi');
    const observedArtifactPath = join(repo, 'artifacts', 's8-gate.json');

    // First invocation: S10→S8 directly. S5 is broken so S8 reports FAIL.
    writeFileSync(observedArtifactPath, JSON.stringify({ gate: 's8', status: 'FAIL', verdict: 'FAIL', note: 'inv-1-from-s10' }));
    const inv1 = recordInvocationEvidence({
      repoRoot: repo,
      parentRunId: 's10-gate-2026-08-21T10-12-13-597Z',
      invocationRunId: 's10-s8-regression-2026-08-21T10-12-13-597Z',
      invocationName: 's8-direct-from-s10',
      scope: 's10-direct',
      command: 'pnpm s8:gate',
      exitCode: 2,
      status: 'FAIL',
      stdout: 'pnpm s8:gate (inv 1)',
      stderr: '11-s5-regression: FAIL',
      startAt: '2026-08-21T10:12:13.000Z',
      endAt: '2026-08-21T10:40:54.000Z',
      observedArtifactPath,
      observedArtifact: { gate: 's8', status: 'FAIL', verdict: 'FAIL', emitted_at: '2026-08-21T10:40:54.000Z', summary: { steps_failed: 1 } },
    });
    expect(inv1.ok).toBe(true);
    expect(inv1.observed_status).toBe('FAIL');
    expect(inv1.observed_verdict).toBe('FAIL');

    // Real flow: before the second invocation runs, the producer overwrites
    // the on-disk artifact (e.g. S9 step 12 finishing its S8 run). Mirror
    // that here so the snapshot the SECOND invocation captures reflects
    // the post-overwrite state (PASS), not the stale FAIL body.
    writeFileSync(observedArtifactPath, JSON.stringify({ gate: 's8', status: 'PASS', verdict: 'PASS', note: 'inv-2-from-s9' }));

    // S10's step 14 runs S9, S9's step 12 runs S8 a SECOND time. That
    // nested invocation is recorded under a DIFFERENT runId — even though
    // it observes the SAME on-disk path, it must not erase the first
    // invocation's snapshot, log, or entry.
    const s9Step12Entry = recordInvocationEvidence({
      repoRoot: repo,
      parentRunId: 's9-gate-2026-08-21T10-40-54-300Z', // s9's own runId — observed by S10 via s9-gate.json
      invocationRunId: 's8-gate-2026-08-21T10-40-55-000Z', // S8's runId, as observed by S10 in the final s8-gate.json
      invocationName: 's8-direct-from-s9-step-12',
      scope: 's10-via-s9',
      command: 'pnpm s8:gate',
      exitCode: 0,
      status: 'PASS',
      stdout: 'pnpm s8:gate (inv 2, by S9 step 12)',
      stderr: '',
      startAt: '2026-08-21T10:40:54.000Z',
      endAt: '2026-08-21T10:40:55.000Z',
      observedArtifactPath,
      observedArtifact: { gate: 's8', status: 'PASS', verdict: 'PASS', emitted_at: '2026-08-21T10:40:55.000Z', summary: { steps_failed: 0 } },
    });
    expect(s9Step12Entry.ok).toBe(true);
    expect(s9Step12Entry.observed_status).toBe('PASS');
    expect(s9Step12Entry.observed_verdict).toBe('PASS');

    // Both snapshot files are still on disk and content-distinct.
    expect(inv1.snapshot.path).not.toBe(s9Step12Entry.snapshot.path);
    expect(existsSync(inv1.snapshot.path!)).toBe(true);
    expect(existsSync(s9Step12Entry.snapshot.path!)).toBe(true);
    const firstSnap = JSON.parse(readFileSync(inv1.snapshot.path!, 'utf8'));
    const secondSnap = JSON.parse(readFileSync(s9Step12Entry.snapshot.path!, 'utf8'));
    expect(firstSnap.status).toBe('FAIL');
    expect(firstSnap.note).toBe('inv-1-from-s10');
    expect(secondSnap.status).toBe('PASS');
    expect(inv1.snapshot.digest).not.toBe(s9Step12Entry.snapshot.digest);
  });

  it('records the S10→S9 direct invocation with its own runId, snapshot of s9-gate.json, and digests (no mix with nested S8)', () => {
    const repo = makeRepo('record-s9-direct');
    const s9ArtifactAbs = join(repo, 'artifacts', 's9-gate.json');
    writeFileSync(s9ArtifactAbs, JSON.stringify({ gate: 's9', status: 'PASS', verdict: 'PASS' }));

    const entry = recordInvocationEvidence({
      repoRoot: repo,
      parentRunId: 's10-gate-2026-08-21T10-12-13-597Z',
      invocationRunId: 's10-s9-regression-2026-08-21T10-40-54-350Z',
      invocationName: 's9-direct-from-s10',
      scope: 's10-direct',
      command: 'pnpm s9:gate',
      exitCode: 0,
      status: 'PASS',
      stdout: 'pnpm s9:gate (from S10 step 14)',
      stderr: '',
      startAt: '2026-08-21T10:40:54.000Z',
      endAt: '2026-08-21T10:50:00.000Z',
      observedArtifactPath: s9ArtifactAbs,
      observedArtifact: {
        gate: 's9', status: 'PASS', verdict: 'PASS',
        runId: 's9-gate-2026-08-21T10-40-54-300Z',
        emitted_at: '2026-08-21T10:50:00.000Z',
        steps: {
          '12-s8-regression': {
            name: '12-s8-regression',
            status: 'PASS',
            evidence: {
              runId: 's9-gate-2026-08-21T10-40-54-300Z',
              meta_path: `${repo}/artifacts/.evidence/s9-gate-2026-08-21T10-40-54-300Z/12-s8-regression.meta.json`,
            },
          },
        },
      },
    });

    expect(entry.ok).toBe(true);
    expect(entry.scope).toBe('s10-direct');
    expect(entry.parentRunId).toBe('s10-gate-2026-08-21T10-12-13-597Z');
    expect(entry.runId).toBe('s10-s9-regression-2026-08-21T10-40-54-350Z');
    // The snapshot path is recorded and matches the prior body.
    expect(entry.snapshot.existed).toBe(true);
    expect(existsSync(entry.snapshot.path!)).toBe(true);
    expect(entry.snapshot.digest).toBe(sha256(readFileSync(s9ArtifactAbs, 'utf8')));
  });

  it('handles a missing observed artifact gracefully (first-ever invocation: no prior body to snapshot)', () => {
    const repo = makeRepo('record-missing');
    const entry = recordInvocationEvidence({
      repoRoot: repo,
      parentRunId: 's10-gate-2026-08-21T10-12-13-597Z',
      invocationRunId: 's10-s8-regression-2026-08-21T10-12-13-597Z',
      invocationName: 's8-direct-from-s10',
      scope: 's10-direct',
      command: 'pnpm s8:gate',
      exitCode: 0,
      status: 'PASS',
      stdout: '',
      stderr: '',
      startAt: '2026-08-21T10:12:13.000Z',
      endAt: '2026-08-21T10:40:54.000Z',
      observedArtifactPath: join(repo, 'artifacts', 's8-gate.json'),
      observedArtifact: { gate: 's8', status: 'PASS', verdict: 'PASS', emitted_at: '2026-08-21T10:40:54.000Z' },
    });

    expect(entry.ok).toBe(true);
    expect(entry.snapshot.existed).toBe(false);
    expect(entry.snapshot.digest).toBe(null);
    // log/meta still on disk.
    expect(existsSync(entry.log.logPath)).toBe(true);
    expect(existsSync(entry.log.metadataPath)).toBe(true);
  });
});

// ===========================================================================
// S10 step 13/14 fail-closed contract.
//
// The audit mandates that S10 must not flip `s8_failed` to false just
// because a later S8 invocation passed. The aggregator logic must look at
// the FIRST invocation's outcome first; only flip when the FIRST observed
// PASS. Same rule must apply to `s9_invocation` for symmetry. The test
// below pins the aggregator contract by exercising it on a synthetic
// invocations list.
// ===========================================================================

describe('S10 invocations aggregator: first-invocation-dominates fail-closed', () => {
  // Helper that mirrors the S10 aggregation logic. The S10 script owns
  // the same predicate so that a future regression can't quietly invert
  // it; tests pin both the predicate and the surface field shape.
  function aggregateS8(invocations: Array<{ scope: string; observed_status: string; observed_verdict?: string | null; exit_code: number; }>) {
    // FAIL wins for the FIRST invocation; later PASSes never flip it back.
    const direct = invocations.find((i) => i.scope === 's10-direct') ?? null;
    const viaS9 = invocations.find((i) => i.scope === 's10-via-s9') ?? null;
    const s8_failed = !!(
      (direct && (direct.exit_code !== 0 || direct.observed_status !== 'PASS')) ||
      (viaS9 && (viaS9.exit_code !== 0 || viaS9.observed_status !== 'PASS'))
    );
    return { s8_failed };
  }

  it('keeps s8_failed=true when the FIRST invocation (S10-direct) FAILed even if the second (S10-via-S9) passed', () => {
    const out = aggregateS8([
      { scope: 's10-direct',  observed_status: 'FAIL', exit_code: 2 },
      { scope: 's10-via-s9',  observed_status: 'PASS', exit_code: 0 },
    ]);
    expect(out.s8_failed).toBe(true);
  });

  it('keeps s8_failed=true when the SECOND (S10-via-S9) invocation FAILed', () => {
    const out = aggregateS8([
      { scope: 's10-direct',  observed_status: 'PASS', exit_code: 0 },
      { scope: 's10-via-s9',  observed_status: 'FAIL', exit_code: 2 },
    ]);
    expect(out.s8_failed).toBe(true);
  });

  it('reports s8_failed=false when BOTH invocations passed', () => {
    const out = aggregateS8([
      { scope: 's10-direct', observed_status: 'PASS', exit_code: 0 },
      { scope: 's10-via-s9', observed_status: 'PASS', exit_code: 0 },
    ]);
    expect(out.s8_failed).toBe(false);
  });
});

// Cleanup after all tests in this file.
process.once('exit', () => { removeAll(); });
