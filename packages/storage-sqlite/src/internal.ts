// internal.ts
//
// Test-only entry point for @portable-agent-asset-hub/storage-sqlite.
// Exposes raw database accessors that the public surface intentionally
// hides (see tests/s2/integrity-and-boundaries.test.ts). Do NOT import
// this from production code; the boundary is asserted by the S2
// integrity test which fails if HubDatabase reappears on the public
// index.ts surface.
//
// Intended consumers:
//   - tests/storage-sqlite/* (e.g. canonical-duplicate-supersede.test.ts)
//     which need to insert test-only fixture rows that bypass the
//     repository surface.
//   - The REST launcher in production code paths that need a parallel
//     `DatabaseSync` for read-only analytics (explicit-relation
//     extractor, etc.). The launcher is the only legitimate user.
export { HubDatabase } from './database.js';
export { SqliteExplicitRelationSource } from './repositories/explicit-relations.js';
