# Changelog

All notable public changes will be documented here.

## 0.1.0 — 2026-08-22

First tagged public release.

### Fixed

- Materializer rollback now honors the documented added-file contract:
  `applyPlan` records a `.deleted` marker for every file it writes over
  no prior bytes, and `rollbackPlan` (and the apply failure path) removes
  those files instead of leaving them behind. Previously, rolling back an
  apply onto an empty target restored nothing (`restored: []`) and left
  the applied — or tampered — files in place. Covered by a new E2E test.
- `@portable-agent-asset-hub/rest` now builds to its own `dist/` like
  every other package, so its `package.json` entry points resolve under
  plain Node (they previously pointed at a directory that only existed
  in the repository-root `dist/` tree).

### Added

- End-to-end demo (`examples/demo/demo.mjs`, documented in
  `docs/demo.md`): profile → REST preview → 428 without CAS → apply →
  412 on drift → rollback, fully local.
- REST route table: unknown method on a known path answers
  `405 METHOD_NOT_ALLOWED` with an `Allow` header (previously 404), the
  201-on-create rule is an explicit operation set instead of an
  `operationId` prefix heuristic, and path parameters support named
  capture groups. `OperationId` is exported as a type derived from the
  route table, typing `RestHub.dispatch`.
- GitHub Actions CI workflow running the fast checks (lint, typecheck,
  tests) and the demo. Staged gates `s0`–`s10` remain local.
- Consolidated engineering log (`docs/engineering-log.md`), full-form
  ADRs, and `slices/README.md`.

### Initial public export

- Prepared a public portfolio export of the Portable Agent Asset Hub.
- Added Apache License 2.0 metadata and notices for the public source tree.
- Added public-surface documentation, contribution guidance, security policy and issue/PR templates.
- Kept personal skills, runtime state, private baselines and local evidence outside the publication candidate.
