export type CalibrationStats = { total: number; clean: number };
export type AutoApprovePolicy = { minSample: number; minPrecision: number };

/** A closed-by-default gate for measured review precision. */
export function isAutoApproveUnlocked(stats: CalibrationStats, policy: AutoApprovePolicy): boolean {
  if (!Number.isInteger(stats.total) || !Number.isInteger(stats.clean) || stats.total < 0 || stats.clean < 0 || stats.clean > stats.total) return false;
  if (!Number.isInteger(policy.minSample) || policy.minSample < 1 || !Number.isFinite(policy.minPrecision) || policy.minPrecision < 0 || policy.minPrecision > 1) return false;
  return stats.total >= policy.minSample && stats.clean / stats.total >= policy.minPrecision;
}
