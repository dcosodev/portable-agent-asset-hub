// scripts/gate-evidence.d.ts
//
// Minimal type declarations for `scripts/gate-evidence.mjs`. The
// helper is plain ESM JavaScript (no build step); TS tests import it
// for typecheck-time type safety. The signatures are kept in sync
// with `scripts/gate-evidence.mjs`.

export const EVIDENCE_ROOT_DEFAULT: string;

export interface SnapshotResult {
  ok: boolean;
  existed: boolean;
  error?: string;
  snapshotPath: string | null;
  snapshotDigest: string | null;
  snapshotBytes: number;
  preservedPreviousPath?: string | null;
}

export interface StepLogResult {
  ok: boolean;
  error?: string;
  logPath: string;
  logDigest: string;
  logBytes: number;
  errPath: string;
  errDigest: string;
  errBytes: number;
  metadataPath: string;
  metadataDigest: string;
  metadataBytes: number;
}

export interface EvidencePaths {
  evidenceDir: string;
  snapshotPath: string;
  safeRunId: string;
}

export function sha256(value: string | Buffer | Uint8Array | null | undefined): string;
export function sha256FromFile(filePath: string): string | null;
export function buildRunId(scope: string, startedAt?: Date): string;
export function evidencePaths(args: {
  repoRoot: string;
  runId: string;
  artifactPath: string;
  evidenceRoot?: string;
}): EvidencePaths;

export function snapshotBeforeOverwrite(args: {
  repoRoot: string;
  artifactPath: string;
  runId: string;
  evidenceRoot?: string;
}): SnapshotResult;

export function recordStepLog(args: {
  repoRoot: string;
  runId: string;
  stepName: string;
  command?: string | null;
  exitCode?: number | null;
  status?: string;
  stdout?: string;
  stderr?: string;
  startAt?: string | null;
  endAt?: string | null;
  artifactPath?: string | null;
  snapshotPath?: string | null;
  evidenceRoot?: string;
}): StepLogResult;

export function readJsonSafe(filePath: string): unknown;

export interface InvocationEvidenceLog {
  logPath: string;
  logDigest: string;
  logBytes: number;
  errPath: string;
  errDigest: string;
  errBytes: number;
  metadataPath: string;
  metadataDigest: string;
  metadataBytes: number;
}

export interface InvocationEvidenceSnapshot {
  existed: boolean;
  path: string | null;
  digest: string | null;
  bytes: number;
  preserved_previous_path: string | null;
}

export interface InvocationEvidenceEntry {
  ok: boolean;
  error?: string;
  runId: string;
  parentRunId: string;
  scope: string;
  invocationName: string;
  command: string | null;
  exitCode: number | null;
  status: string;
  observed_status: string;
  observed_verdict: string | null;
  emitted_at: string | null;
  observedRunId: string | null;
  observedArtifactPath: string;
  startAt: string | null;
  endAt: string | null;
  snapshot: InvocationEvidenceSnapshot;
  log: InvocationEvidenceLog;
}

export interface RecordInvocationEvidenceArgs {
  repoRoot: string;
  parentRunId: string;
  invocationRunId: string;
  invocationName: string;
  scope: string;
  command?: string | null;
  exitCode?: number | null;
  status?: string;
  stdout?: string;
  stderr?: string;
  startAt?: string | null;
  endAt?: string | null;
  observedArtifactPath: string;
  observedArtifact?: Record<string, unknown> | null;
  evidenceRoot?: string;
}

export function recordInvocationEvidence(args: RecordInvocationEvidenceArgs): InvocationEvidenceEntry | { ok: false; error: string; invocationRunId?: string };
