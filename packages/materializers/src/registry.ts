// packages/materializers/src/registry.ts
//
// In-memory registry mapping a successful `applyPlan` runId to the
// filesystem coordinates the apply recorded. Rollback reads this
// registry to resolve the targetRoot / lockDir / harness / profileId
// associated with a runId without scanning the user's HOME.
//
// Lifecycle:
//   * `applyPlan` calls `registerRun` AFTER the manifest is on disk
//     and BEFORE returning ApplyResult.
//   * `rollbackPlan` calls `lookupRun` BEFORE the `discoverManifests`
//     fallback path; if it finds an entry it uses the recorded
//     coordinates and skips the discover step.
//   * `rollbackPlan` deletes the registry entry on every code path
//     (success, NOT_FOUND, and rollback-completion) so the map never
//     leaks stale runs.

import type { HarnessId } from './contracts.js';

export type RunRecord = {
  targetRoot: string;
  lockDir: string;
  harness: HarnessId;
  profileId: string;
};

const runs = new Map<string, RunRecord>();

export function registerRun(runId: string, record: RunRecord): void {
  runs.set(runId, { ...record });
}

export function lookupRun(runId: string): RunRecord | undefined {
  const entry = runs.get(runId);
  return entry ? { ...entry } : undefined;
}

export function forgetRun(runId: string): void {
  runs.delete(runId);
}

/**
 * Test-only helper: clears the registry. Used by the test suites to
 * guarantee isolation between cases that share a vitest worker.
 */
export function _resetRegistryForTests(): void {
  runs.clear();
}
